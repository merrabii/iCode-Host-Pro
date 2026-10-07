import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProviderSetting } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { isPaymentSimulatorEnabled } from '../config/payment-simulator';
import { CryptoService, MailCryptoError } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentConnector } from './payment-connector';
import { SimulatedConnector } from './simulated-connector';
import { StripeConnector, StripeHttpError } from './stripe-connector';
import { SaveProviderDto } from './dto/payments.dto';

/** Devises autorisées dans ce lot (MAD hors périmètre). */
export const CARD_CURRENCIES = ['USD', 'EUR'] as const;

/** Identité de l'OPÉRATION (snapshot) exigée pour toute reprise d'un paiement. */
export interface OperationIdentity {
  providerCode: string;
  merchantAccount: string;
  environment?: string | null;
}

export interface ResolvedProvider {
  settingId: string;
  code: 'stripe' | 'simulated';
  displayName: string;
  environment: 'test';
  merchantAccount: string;
  currencies: string[];
  connector: PaymentConnector;
}

export interface ProviderMaskedView {
  code: string;
  displayName: string;
  isActive: boolean;
  environment: string;
  liveEnabled: boolean;
  merchantAccount: string | null;
  publishableKey: string | null;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  webhookEndpointUrl: string | null;
  allowedCurrencies: string[];
  lastCheckAt: Date | null;
  lastCheckAccount: string | null;
  lastCheckError: string | null;
  updatedAt: Date | null;
  updatedByEmail: string | null;
}

export interface Actor {
  sub: string;
  email: string;
}

/**
 * GO Stripe — configuration du connecteur carte (mode TEST strict).
 *
 * Règles durables :
 *  - `environment=live` et `liveEnabled=true` sont REFUSÉS à l'écriture (aucune
 *    activation commerciale par accident, GO §2) ;
 *  - les secrets (`sk_test_…`, `whsec_…`) sont chiffrés AES-256-GCM via le
 *    mécanisme existant (`CryptoService`/`ENCRYPTION_KEY`) et ne sont JAMAIS
 *    renvoyés par l'API (seuls `hasSecretKey`/`hasWebhookSecret`) ;
 *  - seule une clé préfixée `sk_test_`/`pk_test_`/`whsec_` est acceptée ;
 *  - PaymentCloud n'est PAS implémenté dans ce lot (connecteur distinct, GO) ;
 *  - sans Stripe configuré, le simulateur (recette) prend le relais UNIQUEMENT
 *    si `PAYMENT_SIMULATOR_ENABLED=true` et `NODE_ENV ≠ production`.
 */
@Injectable()
export class PaymentProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  private decryptOrThrow(payload: string, label: string): string {
    try {
      return this.crypto.decrypt(payload);
    } catch (err) {
      if (err instanceof MailCryptoError) throw err;
      throw new BadRequestException(
        `Impossible de déchiffrer ${label} : ENCRYPTION_KEY absente ou incompatible.`,
      );
    }
  }

  webhookEndpointUrl(): string {
    const base = (
      this.config.get<string>('PUBLIC_API_BASE') ?? 'http://localhost:3001'
    ).replace(/\/+$/, '');
    return `${base}/api/payments/webhook`;
  }

  private toMasked(row: PaymentProviderSetting): ProviderMaskedView {
    let allowed: string[] = [];
    if (Array.isArray(row.allowedCurrencies)) {
      allowed = row.allowedCurrencies.filter(
        (c): c is string => typeof c === 'string',
      );
    }
    return {
      code: row.code,
      displayName: row.displayName,
      isActive: row.isActive,
      environment: row.environment,
      liveEnabled: row.liveEnabled,
      merchantAccount: row.merchantAccount,
      publishableKey: row.publishableKey,
      hasSecretKey: Boolean(row.secretKeyEnc),
      hasWebhookSecret: Boolean(row.webhookSecretEnc),
      webhookEndpointUrl: row.webhookEndpointUrl,
      allowedCurrencies: allowed.length ? allowed : [...CARD_CURRENCIES],
      lastCheckAt: row.lastCheckAt,
      lastCheckAccount: row.lastCheckAccount,
      lastCheckError: row.lastCheckError,
      updatedAt: row.updatedAt,
      updatedByEmail: row.updatedByEmail,
    };
  }

  async getSetting(code = 'stripe'): Promise<PaymentProviderSetting | null> {
    return this.prisma.paymentProviderSetting.findUnique({ where: { code } });
  }

  async getMaskedView(code = 'stripe'): Promise<ProviderMaskedView | null> {
    const row = await this.getSetting(code);
    return row ? this.toMasked(row) : null;
  }

  /** Écriture de la configuration (admin) — refuse TOUTE écriture live. */
  async save(dto: SaveProviderDto, actor: Actor): Promise<ProviderMaskedView> {
    if (dto.code !== 'stripe') {
      throw new BadRequestException(
        'Connecteur inconnu. Seul « stripe » est implémenté dans ce lot ; ' +
          'PaymentCloud viendra par un connecteur distinct (aucune implémentation fictive).',
      );
    }
    if (dto.environment !== undefined && dto.environment !== 'test') {
      throw new BadRequestException('Environnement « live » refusé : mode test uniquement.');
    }
    if (dto.liveEnabled === true) {
      throw new BadRequestException(
        'Live désactivé (GO Stripe) : aucune activation commerciale dans ce lot.',
      );
    }
    if (dto.secretKey && !dto.secretKey.startsWith('sk_test_')) {
      throw new BadRequestException(
        'Clé secrète refusée : seules les clés TEST (préfixe sk_test_) sont acceptées.',
      );
    }
    if (dto.publishableKey && !dto.publishableKey.startsWith('pk_test_')) {
      throw new BadRequestException(
        'Clé publique refusée : seules les clés TEST (préfixe pk_test_) sont acceptées.',
      );
    }
    if (dto.webhookSecret && !dto.webhookSecret.startsWith('whsec_')) {
      throw new BadRequestException(
        'Secret webhook refusé : format whsec_ attendu (depuis le tableau Stripe).',
      );
    }

    const existing = await this.getSetting('stripe');
    if (dto.isActive && !dto.secretKey && !existing?.secretKeyEnc) {
      throw new BadRequestException(
        'Clé secrète test (sk_test_) requise pour activer le prestataire.',
      );
    }

    const data: Parameters<
      PrismaService['paymentProviderSetting']['upsert']
    >[0]['create'] = {
      code: 'stripe',
      displayName: dto.displayName,
      isActive: dto.isActive,
      environment: 'test',
      liveEnabled: false,
      merchantAccount: dto.merchantAccount ?? null,
      publishableKey: dto.publishableKey ?? null,
      webhookEndpointUrl: dto.webhookEndpointUrl ?? this.webhookEndpointUrl(),
      allowedCurrencies: dto.allowedCurrencies?.length
        ? dto.allowedCurrencies
        : [...CARD_CURRENCIES],
      createdByUserId: existing ? undefined : actor.sub,
      updatedByUserId: actor.sub,
      updatedByEmail: actor.email,
    };
    if (dto.secretKey) data.secretKeyEnc = this.crypto.encrypt(dto.secretKey);
    if (dto.webhookSecret) data.webhookSecretEnc = this.crypto.encrypt(dto.webhookSecret);

    const row = await this.prisma.paymentProviderSetting.upsert({
      where: { code: 'stripe' },
      create: data,
      // `undefined` = inchangé (secrets conservés si non renseignés).
      update: { ...data, createdByUserId: undefined },
    });
    return this.toMasked(row);
  }

  /**
   * Contrôle de connexion réel (appel prestataire en mode test).
   *
   * GO P4 — c'est CETTE vérification qui fabrique l'identité marchande Fiable :
   *  - le compte réel (`GET /v1/account`) est mémorisé (`lastCheckAccount`) ;
   *  - un `merchantAccount` absent est REMPLI par le compte VÉRIFIÉ (jamais par
   *    une saisie déclarative) ;
   *  - un `merchantAccount` déclaré ≠ compte vérifié laisse un écart VISIBLE
   *    (`lastCheckError`) sans écrasement silencieux : les opérations sont
   *    alors refusées tant que l'identité n'est pas résolue.
   * `requireMerchantAccount` est désactivé ICI uniquement : sans ce contrôle,
   * un premier enregistrement de clés ne pourrait jamais être vérifié.
   */
  async checkConnection(
    actor: Actor,
  ): Promise<ProviderMaskedView & { simulated?: boolean }> {
    try {
      const resolved = await this.resolve({ requireMerchantAccount: false });
      const account = await resolved.connector.verifyAccount();
      const current = await this.getSetting('stripe');
      const declared = current?.merchantAccount ?? null;
      const mismatch =
        resolved.code === 'stripe' && declared && declared !== account.accountId
          ? `Compte marchand déclaré (${declared}) ≠ compte vérifié (${account.accountId}) : corrigez la configuration.`
          : null;
      const row = await this.prisma.paymentProviderSetting.update({
        where: { id: resolved.settingId },
        data: {
          lastCheckAt: new Date(),
          lastCheckAccount: account.accountId,
          lastCheckError: mismatch,
          // Identité vérifiée : renseignée par le contrôle, jamais inventée.
          ...(resolved.code === 'stripe' && !declared
            ? { merchantAccount: account.accountId, updatedByUserId: actor.sub }
            : {}),
        },
      });
      return { ...this.toMasked(row), simulated: resolved.code === 'simulated' };
    } catch (err) {
      const message =
        err instanceof StripeHttpError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      const setting = await this.getSetting('stripe');
      if (setting) {
        const row = await this.prisma.paymentProviderSetting.update({
          where: { id: setting.id },
          data: { lastCheckAt: new Date(), lastCheckError: message.slice(0, 500) },
        });
        return this.toMasked(row);
      }
      throw new ConflictException(`Connexion impossible : ${message}`);
    }
  }

  /** Ligne du simulateur (créditée à la demande, secret local généré une fois). */
  private async ensureSimulatorSetting(): Promise<PaymentProviderSetting> {
    // GO P1 — filet : jamais de configuration créée hors simulateur actif.
    this.assertSimulatorUsable();
    const existing = await this.prisma.paymentProviderSetting.findUnique({
      where: { code: 'simulated' },
    });
    if (existing?.webhookSecretEnc) return existing;
    const secretEnc = this.crypto.encrypt(
      `whsec_local_${randomBytes(18).toString('hex')}`,
    );
    if (existing) {
      return this.prisma.paymentProviderSetting.update({
        where: { id: existing.id },
        data: { webhookSecretEnc: secretEnc, environment: 'test', liveEnabled: false },
      });
    }
    return this.prisma.paymentProviderSetting.create({
      data: {
        code: 'simulated',
        displayName: 'Simulateur local (aucun appel réseau)',
        isActive: true,
        environment: 'test',
        liveEnabled: false,
        merchantAccount: 'sim_merchant_local',
        webhookSecretEnc: secretEnc,
        webhookEndpointUrl: this.webhookEndpointUrl(),
        allowedCurrencies: [...CARD_CURRENCIES],
      },
    });
  }

  /**
   * GO P1 — le simulateur n'est utilisable QUE s'il est explicitement activé
   * ET hors production. Tout accès (page, événement, webhook, résolution) passe
   * par cet unique contrôle, AVANT toute création de configuration.
   */
  assertSimulatorUsable(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new ConflictException(
        'Simulateur de paiement interdit en production (GO Stripe).',
      );
    }
    if (!isPaymentSimulatorEnabled()) {
      throw new ConflictException(
        'Simulateur de paiement désactivé (PAYMENT_SIMULATOR_ENABLED).',
      );
    }
  }

  /**
   * Résolution du connecteur OPÉRATIONNEL pour une NOUVELLE opération :
   *  1. Stripe configuré + actif + test → connecteur Stripe réel ;
   *  2. sinon simulateur (recette/CI) si explicitement activé ;
   *  3. sinon refus net (aucun bouton de paiement non fonctionnel).
   *
   * GO P4 — l'identité marchande n'est JAMAIS « acct_inconnu » :
   *  - compte déclaré ≠ compte vérifié → refus (l'écart est déjà visible dans
   *    `lastCheckError`, il doit être corrigé avant toute nouvelle opération) ;
   *  - ni déclaré ni vérifié → refus (une opération exige une identité
   *    marchande établie : « Tester la connexion » la fabrique).
   * `requireMerchantAccount: false` sert UNIQUEMENT au contrôle de connexion.
   */
  async resolve(
    opts: { requireMerchantAccount?: boolean } = {},
  ): Promise<ResolvedProvider> {
    const requireMerchant = opts.requireMerchantAccount !== false;
    const stripe = await this.getSetting('stripe');
    if (stripe && stripe.isActive) {
      if (stripe.environment !== 'test') {
        throw new ConflictException('Configuration live refusée (GO Stripe).');
      }
      if (!stripe.secretKeyEnc) {
        throw new ConflictException(
          'Prestataire actif sans clé secrète : configuration invalide.',
        );
      }
      if (requireMerchant) {
        const declared = stripe.merchantAccount ?? null;
        const verified = stripe.lastCheckAccount ?? null;
        if (declared && verified && declared !== verified) {
          throw new ConflictException(
            `Compte marchand déclaré (${declared}) ≠ compte vérifié (${verified}) : ` +
              'identité marchande incohérente, opération refusée.',
          );
        }
        if (!declared && !verified) {
          throw new ConflictException(
            'Compte marchand non établi : enregistrez-le ou lancez « Tester la connexion » ' +
              'avant toute opération (aucune identité déclarative acceptée).',
          );
        }
      }
      const secretKey = this.decryptOrThrow(stripe.secretKeyEnc, 'la clé secrète');
      const webhookSecret = stripe.webhookSecretEnc
        ? this.decryptOrThrow(stripe.webhookSecretEnc, 'le secret webhook')
        : '';
      return {
        settingId: stripe.id,
        code: 'stripe',
        displayName: stripe.displayName,
        environment: 'test',
        merchantAccount:
          stripe.merchantAccount ?? stripe.lastCheckAccount ?? 'acct_inconnu',
        currencies: this.currenciesOf(stripe),
        connector: new StripeConnector(secretKey, webhookSecret, this.config),
      };
    }
    if (isPaymentSimulatorEnabled() && process.env.NODE_ENV !== 'production') {
      const sim = await this.ensureSimulatorSetting();
      const webhookSecret = this.decryptOrThrow(
        sim.webhookSecretEnc!,
        'le secret webhook du simulateur',
      );
      return {
        settingId: sim.id,
        code: 'simulated',
        displayName: sim.displayName,
        environment: 'test',
        merchantAccount: sim.merchantAccount ?? 'sim_merchant_local',
        currencies: this.currenciesOf(sim),
        connector: new SimulatedConnector(webhookSecret),
      };
    }
    throw new ConflictException(
      'Aucun prestataire de paiement configuré : activez Stripe en mode test ' +
        '(clé sk_test_ + secret whsec_) ou le simulateur de recette ' +
        '(PAYMENT_SIMULATOR_ENABLED=true).',
    );
  }

  /**
   * GO P1 + P4 — résolution d'une opération EXISTANTE par son identité D'ORIGINE.
   *
   *  - JAMAIS de repli : une opération « stripe » n'est jamais reprise par le
   *    simulateur (ni l'inverse) — le fournisseur est celui de la ligne, pas
   *    celui qui est actuellement configuré ;
   *  - JAMAIS de remplacement silencieux de configuration : si le compte
   *    marchand a CHANGÉ depuis la création, l'opération est REFUSÉE (l'appelant
   *    signale l'intervention) ; une simple rotation de clés du MÊME compte
   *    reste acceptée (identité inchangée) ;
   *  - simulateur requis → refus net s'il est désactivé ou en production.
   */
  async resolveFor(op: OperationIdentity): Promise<ResolvedProvider> {
    if (op.environment && op.environment !== 'test') {
      throw new ConflictException(
        `Environnement « ${op.environment} » non pris en charge (mode test uniquement).`,
      );
    }
    if (op.providerCode === 'simulated') {
      this.assertSimulatorUsable();
      const sim = await this.ensureSimulatorSetting();
      const current = sim.merchantAccount ?? 'sim_merchant_local';
      if (current !== op.merchantAccount) {
        throw new ConflictException(
          `Identité marchande du simulateur modifiée (${op.merchantAccount} → ${current}) : opération gelée.`,
        );
      }
      const webhookSecret = this.decryptOrThrow(
        sim.webhookSecretEnc!,
        'le secret webhook du simulateur',
      );
      return {
        settingId: sim.id,
        code: 'simulated',
        displayName: sim.displayName,
        environment: 'test',
        merchantAccount: current,
        currencies: this.currenciesOf(sim),
        connector: new SimulatedConnector(webhookSecret),
      };
    }

    const stripe = await this.getSetting(op.providerCode);
    if (!stripe) {
      throw new ConflictException(
        `Fournisseur d’origine « ${op.providerCode} » inconnu : aucune reprise.`,
      );
    }
    if (op.providerCode === 'stripe') {
      if (!stripe.isActive || stripe.environment !== 'test' || !stripe.secretKeyEnc) {
        throw new ConflictException(
          'Prestataire d’origine « stripe » indisponible : aucune reprise par un autre fournisseur.',
        );
      }
      const current = stripe.merchantAccount ?? stripe.lastCheckAccount ?? null;
      if (current && current !== op.merchantAccount) {
        throw new ConflictException(
          `Compte marchand modifié pendant l’opération (${op.merchantAccount} → ${current}) : ` +
            'reprise refusée, intervention requise.',
        );
      }
      if (!current) {
        throw new ConflictException(
          'Identité marchande de l’opération non résoluble (configuration vidée) : intervention requise.',
        );
      }
      const secretKey = this.decryptOrThrow(stripe.secretKeyEnc, 'la clé secrète');
      const webhookSecret = stripe.webhookSecretEnc
        ? this.decryptOrThrow(stripe.webhookSecretEnc, 'le secret webhook')
        : '';
      return {
        settingId: stripe.id,
        code: 'stripe',
        displayName: stripe.displayName,
        environment: 'test',
        merchantAccount: current,
        currencies: this.currenciesOf(stripe),
        connector: new StripeConnector(secretKey, webhookSecret, this.config),
      };
    }

    throw new ConflictException(
      `Fournisseur « ${op.providerCode} » non pris en charge : aucune reprise.`,
    );
  }

  /**
   * Secret webhook attendu pour le code donné (contrôleur webhook).
   * Teste la signature : pas de secret = refus net, jamais de « default OK ».
   */
  async webhookSecretFor(code: string): Promise<string> {
    if (code === 'simulated') {
      // GO P1 — AVANT toute création de configuration ni écriture : un
      // webhook simulé est refusé dès que le simulateur est désactivé ou en
      // production (aucune ligne `PaymentProviderSetting` créée, aucun effet).
      this.assertSimulatorUsable();
      const sim = await this.ensureSimulatorSetting();
      return this.decryptOrThrow(sim.webhookSecretEnc!, 'le secret webhook du simulateur');
    }
    const setting = await this.getSetting(code);
    if (!setting?.webhookSecretEnc) {
      throw new ConflictException(
        `Secret webhook non configuré pour « ${code} » (whsec_ attendu).`,
      );
    }
    return this.decryptOrThrow(setting.webhookSecretEnc, 'le secret webhook');
  }

  /**
   * GO P1/P4 — identité MARCHANDE courante d'un fournisseur identifié par sa
   * SIGNATURE webhook (code + secret vérifiés avant tout traitement).
   *
   * Servie comme preuve d'appartenance à la confirmation (compte marchand du
   * connecteur vérifié). Aucun appel réseau, aucun repli sur un autre
   * fournisseur : identité indisponible = événement NON acquittable (503).
   */
  async currentIdentity(code: string): Promise<string> {
    if (code === 'simulated') {
      this.assertSimulatorUsable();
      const sim = await this.ensureSimulatorSetting();
      return sim.merchantAccount ?? 'sim_merchant_local';
    }
    const setting = await this.getSetting(code);
    if (!setting) {
      throw new ConflictException(`Fournisseur « ${code} » non configuré : identité absente.`);
    }
    const identity = setting.merchantAccount ?? setting.lastCheckAccount ?? null;
    if (!identity) {
      throw new ConflictException(
        `Identité marchande non établie pour « ${code} » : événement non acquittable.`,
      );
    }
    return identity;
  }

  /**
   * GO P3 — période du sweep des webhooks non rattachés (ms).
   * Activation EXPLICITE : `PAYMENT_WEBHOOK_RECONCILE_INTERVAL_MS`
   * (0/absent = sweep désactivé, les échéances restent persistées et sont
   * reprises à chaque envoi webhooks / rafraîchissement client).
   */
  reconcileIntervalMs(): number {
    const raw = Number(this.config.get<string>('PAYMENT_WEBHOOK_RECONCILE_INTERVAL_MS') ?? 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  private currenciesOf(row: PaymentProviderSetting): string[] {    if (Array.isArray(row.allowedCurrencies)) {
      const list = row.allowedCurrencies.filter(
        (c): c is string => typeof c === 'string',
      );
      if (list.length) return list;
    }
    return [...CARD_CURRENCIES];
  }
}
