import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CardPaymentStatus, PaymentProviderSetting } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { isPaymentSimulatorEnabled } from '../config/payment-simulator';
import { CryptoService, MailCryptoError } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentConnector } from './payment-connector';
import {
  SimulatedConnector,
  SimulatedSessionSnapshot,
  SimulatedSessionStore,
} from './simulated-connector';
import { StripeConnector, StripeHttpError } from './stripe-connector';
import { stripeUsability } from './stripe-usability';
import { SaveProviderDto } from './dto/payments.dto';

/** Devises autorisées dans ce lot (MAD hors périmètre). */
export const CARD_CURRENCIES = ['USD', 'EUR'] as const;

/** Identité de l'OPÉRATION (snapshot) exigée pour toute reprise d'un paiement. */
export interface OperationIdentity {
  providerCode: string;
  merchantAccount: string;
  environment?: string | null;
}

/**
 * GO V3 §3 — résultat d'UNE SEULE lecture de configuration pour un webhook :
 * le secret (vérification de signature) et l'identité source (compte +
 * ligne + version) proviennent du MÊME snapshot.
 */
export interface WebhookAuthContext {
  secret: string;
  identity: {
    settingId: string;
    configVersion: Date;
    merchantAccount: string;
  } | null;
  identityError: string | null;
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
    if (dto.secretKey) {
      data.secretKeyEnc = this.crypto.encrypt(dto.secretKey);
      // GO §3 — une NOUVELLE clé secrète rend les preuves d'identité
      // obsolètes : re-vérification obligatoire (« Tester la connexion »)
      // avant la prochaine opération. Jamais d'identité héritée d'une
      // clé remplacée.
      data.lastCheckAccount = null;
      data.lastCheckAt = null;
      data.lastCheckError =
        'Clé secrète modifiée : re-vérification requise (« Tester la connexion »).';
    }
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
   * GO P4 + §3 — c'est CETTE vérification qui fabrique l'identité marchande
   * Fiable :
   *  - le compte réel (`GET /v1/account`) est mémorisé (`lastCheckAccount`) ;
   *  - un `merchantAccount` absent est REMPLI par le compte VÉRIFIÉ (jamais par
   *    une saisie déclarative) ;
   *  - un `merchantAccount` déclaré ≠ compte vérifié laisse un écart VISIBLE
   *    (`lastCheckError`) sans écrasement silencieux : les opérations sont
   *    alors refusées tant que l'identité n'est pas résolue ;
   *  - §2/§3 — le snapshot de configuration (id + updatedAt + merchantAccount)
   *    est lu AVANT l'appel réseau et l'écriture est un CAS sur CE snapshot :
   *    une édition pendant le contrôle rend la preuve non applicable (« re-
   *    testez ») — jamais de preuve attribuée à une version que le contrôle
   *    n'a pas vue (succès comme échec).
   * `requireMerchantAccount` est désactivé ICI uniquement : sans ce contrôle,
   * un premier enregistrement de clés ne pourrait jamais être vérifié.
   */
  async checkConnection(
    actor: Actor,
  ): Promise<ProviderMaskedView & { simulated?: boolean }> {
    let before: PaymentProviderSetting;
    let resolved: ResolvedProvider;
    try {
      // GO V3 §2 — le snapshot est lu EN PREMIER et le connecteur est bâti
      // EXACTEMENT depuis CETTE ligne (jamais d'objet issu d'une relecture) :
      // le résultat du contrôle (succès comme échec) n'est écrit que par un CAS
      // sur `before.updatedAt` — une édition entre la lecture et l'écriture
      // rend le test NON applicable (« re-testez »), jamais attribué à une
      // version que le contrôle n'a pas vue.
      const stripe = await this.getSetting('stripe');
      if (stripe && stripe.isActive) {
        before = stripe;
        resolved = this.resolvedFromStripeRow(stripe, { requireMerchantAccount: false });
      } else if (isPaymentSimulatorEnabled() && process.env.NODE_ENV !== 'production') {
        before = await this.ensureSimulatorSetting();
        resolved = this.resolvedFromSimRow(before);
      } else {
        throw new ConflictException(
          'Aucun prestataire de paiement configuré : activez Stripe en mode test ' +
            '(clé sk_test_ + secret whsec_) ou le simulateur de recette ' +
            '(PAYMENT_SIMULATOR_ENABLED=true).',
        );
      }
    } catch (err) {
      return this.recordCheckFailure(err);
    }
    // §2 — AVANT tout appel réseau : version de configuration soumise au CAS.
    let account: { accountId: string };
    try {
      account = await resolved.connector.verifyAccount();
    } catch (err) {
      return this.recordCheckFailure(err, before);
    }
    try {
      const declared = before.merchantAccount ?? null;
      const mismatch =
        resolved.code === 'stripe' && declared && declared !== account.accountId
          ? `Compte marchand déclaré (${declared}) ≠ compte vérifié (${account.accountId}) : corrigez la configuration.`
          : null;
      const cas = await this.prisma.paymentProviderSetting.updateMany({
        where: {
          id: resolved.settingId,
          updatedAt: before.updatedAt,
          merchantAccount: before.merchantAccount,
        },
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
      if (cas.count !== 1) {
        throw new ConflictException(
          'Configuration modifiée pendant le contrôle de connexion : relancez le test.',
        );
      }
      const row = await this.prisma.paymentProviderSetting.findUnique({
        where: { id: resolved.settingId },
      });
      if (!row) {
        throw new ConflictException('Configuration introuvable après contrôle : re-testez.');
      }
      return { ...this.toMasked(row), simulated: resolved.code === 'simulated' };
    } catch (err) {
      return this.recordCheckFailure(err, before);
    }
  }

  /**
   * §3 + §2 — échec du contrôle : preuve écrite en CAS sur la version AVANT
   * réseau (jamais sur une configuration modifiée pendant l'appel).
   */
  private async recordCheckFailure(
    err: unknown,
    snapshot?: PaymentProviderSetting,
  ): Promise<ProviderMaskedView & { simulated?: boolean }> {
    const message =
      err instanceof StripeHttpError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    // Refus métier explicite (config modifiée, introuvable) : jamais réécrit
    // comme une simple erreur de connexion.
    if (err instanceof ConflictException) throw err;
    const setting = snapshot ?? (await this.getSetting('stripe'));
    if (setting) {
      const cas = await this.prisma.paymentProviderSetting.updateMany({
        where: { id: setting.id, updatedAt: setting.updatedAt },
        data: { lastCheckAt: new Date(), lastCheckError: message.slice(0, 500) },
      });
      if (cas.count === 1) {
        const row = await this.prisma.paymentProviderSetting.findUnique({
          where: { id: setting.id },
        });
        if (row) return this.toMasked(row);
      }
      // Configuration modifiée pendant l'échec : aucun attribut écrit.
      const fresh = await this.getSetting('stripe');
      if (fresh) return this.toMasked(fresh);
    }
    throw new ConflictException(`Connexion impossible : ${message}`);
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
      return this.resolvedFromStripeRow(stripe, { requireMerchantAccount: requireMerchant });
    }
    if (isPaymentSimulatorEnabled() && process.env.NODE_ENV !== 'production') {
      const sim = await this.ensureSimulatorSetting();
      return this.resolvedFromSimRow(sim);
    }
    throw new ConflictException(
      'Aucun prestataire de paiement configuré : activez Stripe en mode test ' +
        '(clé sk_test_ + secret whsec_) ou le simulateur de recette ' +
        '(PAYMENT_SIMULATOR_ENABLED=true).',
    );
  }

  /**
   * GO V3 §2 — constructeur de connecteur Stripe À PARTIR D'UNE LIGNE déjà
   * lue : `checkConnection` bâtit le connecteur exactement sur le snapshot
   * soumis au CAS (aucune relecture entre la construction et l'édition
   * possible). Mêmes règles que `resolve` (usability, décryptage).
   */
  private resolvedFromStripeRow(
    stripe: PaymentProviderSetting,
    opts: { requireMerchantAccount: boolean },
  ): ResolvedProvider {
    // GO revue §5b — MÊMES règles que l'affichage de disponibilité
    // (helper pur partagé) : un connecteur affiché « utilisable » est
    // exactement un connecteur résoluble ici (jamais de divergence).
    const usable = stripeUsability(stripe, {
      requireMerchantAccount: opts.requireMerchantAccount,
    });
    if (!usable.usable) {
      switch (usable.code) {
        case 'not_test':
          throw new ConflictException('Configuration live refusée (GO Stripe).');
        case 'no_secret':
          throw new ConflictException(
            'Prestataire actif sans clé secrète : configuration invalide.',
          );
        case 'identity_mismatch':
          throw new ConflictException(
            `Compte marchand déclaré (${usable.declared}) ≠ compte vérifié (${usable.verified}) : ` +
              'identité marchande incohérente, opération refusée.',
          );
        case 'identity_unverified':
          throw new ConflictException(
            'Identité marchande non vérifiée : lancez « Tester la connexion » ' +
              '(une déclaration seule ne suffit pas à opérer).',
          );
      }
    }
    if (!stripe.secretKeyEnc) {
      // Inatteignable (stripeUsability « no_secret » ci-dessus) — garde TS.
      throw new ConflictException(
        'Prestataire actif sans clé secrète : configuration invalide.',
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
      // §3 — le compte VÉRIFIÉ prime sur la déclaration (jamais l'inverse).
      merchantAccount: stripe.lastCheckAccount ?? stripe.merchantAccount ?? 'acct_inconnu',
      currencies: this.currenciesOf(stripe),
      connector: new StripeConnector(secretKey, webhookSecret, this.config),
    };
  }

  /** GO V3 §2 — constructeur de connecteur simulateur À PARTIR D'UNE ligne. */
  private resolvedFromSimRow(sim: PaymentProviderSetting): ResolvedProvider {
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
      connector: new SimulatedConnector(webhookSecret, this.simulatedStore()),
    };
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
        connector: new SimulatedConnector(webhookSecret, this.simulatedStore()),
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
      // GO §3 — configuration incohérente (déclaré ≠ vérifié) = opération
      // GELÉE : jamais de reprise sous une identité que le contrôle n'a pas
      // confirmée. §2 — le compte VÉRIFIÉ est le SEUL admis : un compte
      // déclaré mais jamais vérifié (après rotation, `lastCheckAccount` vidé)
      // gèle la reprise jusqu'au prochain contrôle.
      const declared = stripe.merchantAccount ?? null;
      const verified = stripe.lastCheckAccount ?? null;
      if (declared && verified && declared !== verified) {
        throw new ConflictException(
          `Compte marchand déclaré (${declared}) ≠ compte vérifié (${verified}) : ` +
            'configuration incohérente, reprise gelée.',
        );
      }
      if (!verified) {
        throw new ConflictException(
          declared
            ? `Compte marchand non vérifié (${declared}) : reprise gelée (« Tester la connexion »).`
            : 'Identité marchande de l’opération non résoluble (configuration vidée) : intervention requise.',
        );
      }
      const current = verified;
      if (current !== op.merchantAccount) {
        throw new ConflictException(
          `Compte marchand modifié pendant l’opération (${op.merchantAccount} → ${current}) : ` +
            'reprise refusée, intervention requise.',
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
   * GO V3 §3 — contexte d'authentification webhook en UNE seule lecture :
   * le secret ET l'identité source (ligne + version + compte vérifié)
   * proviennent du MÊME snapshot de configuration. La vérification de
   * signature et l'identité de la confirmation sont donc toujours cohérentes
   * (jamais deux lectures séparées interverties par une rotation).
   *
   * `identity: null` = signature VÉRIFIABLE mais identité non acquittable
   * (déclaré ≠ vérifié, ou jamais vérifié après rotation) : le service
   * webhook classe alors l'événement (503 pour un type traitable, IGNORED
   * pour un type hors périmètre) — jamais d'identité héritée.
   */
  async webhookAuthContext(code: string): Promise<WebhookAuthContext> {
    if (code === 'simulated') {
      // GO P1 — AVANT toute création de configuration ni écriture : un
      // webhook simulé est refusé dès que le simulateur est désactivé ou en
      // production (aucune ligne `PaymentProviderSetting` créée, aucun effet).
      this.assertSimulatorUsable();
      const sim = await this.ensureSimulatorSetting();
      const secret = this.decryptOrThrow(
        sim.webhookSecretEnc!,
        'le secret webhook du simulateur',
      );
      return {
        secret,
        identity: {
          settingId: sim.id,
          configVersion: sim.updatedAt,
          merchantAccount: sim.merchantAccount ?? 'sim_merchant_local',
        },
        identityError: null,
      };
    }
    const setting = await this.getSetting(code);
    if (!setting?.webhookSecretEnc) {
      throw new ConflictException(
        `Secret webhook non configuré pour « ${code} » (whsec_ attendu).`,
      );
    }
    const secret = this.decryptOrThrow(setting.webhookSecretEnc, 'le secret webhook');
    // GO §3 + §2 — MÊMES règles que `currentIdentity`, appliquées sur CE
    // snapshot (le même que le secret) : vérifié UNIQUEMENT, et jamais
    // d'identité sur une configuration incohérente ou non revérifiée.
    const declared = setting.merchantAccount ?? null;
    const verified = setting.lastCheckAccount ?? null;
    if (declared && verified && declared !== verified) {
      return {
        secret,
        identity: null,
        identityError:
          `Identité marchande incohérente pour « ${code} » (${declared} ≠ ${verified}) : ` +
          'événement non acquittable.',
      };
    }
    if (!verified) {
      return {
        secret,
        identity: null,
        identityError: declared
          ? `Identité marchande non vérifiée pour « ${code} » (${declared}) : événement ` +
            'non acquittable (« Tester la connexion » après rotation).'
          : `Identité marchande non établie pour « ${code} » : événement non acquittable.`,
      };
    }
    return {
      secret,
      identity: {
        settingId: setting.id,
        configVersion: setting.updatedAt,
        merchantAccount: verified,
      },
      identityError: null,
    };
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
    // GO §3 + §2 — vérifié UNIQUEMENT, et jamais d'identité sur une
    // configuration incohérente (déclaré ≠ vérifié = événement non
    // acquittable, 503). §2 — une déclaration seule (jamais revérifiée après
    // une rotation de configuration) ne fabrique PLUS d'identité : sans
    // `lastCheckAccount`, l'événement n'est pas acquittable.
    const declared = setting.merchantAccount ?? null;
    const verified = setting.lastCheckAccount ?? null;
    if (declared && verified && declared !== verified) {
      throw new ConflictException(
        `Identité marchande incohérente pour « ${code} » (${declared} ≠ ${verified}) : ` +
          'événement non acquittable.',
      );
    }
    if (!verified) {
      throw new ConflictException(
        declared
          ? `Identité marchande non vérifiée pour « ${code} » (${declared}) : événement ` +
              'non acquittable (« Tester la connexion » après rotation).'
          : `Identité marchande non établie pour « ${code} » : événement non acquittable.`,
      );
    }
    return verified;
  }

  /**
   * GO P3 + §4.3 — période du sweep des webhooks non rattachés (ms).
   * DURABLE par défaut (60 s) : un rapprochement perdu au redémarrage est
   * repris au démarrage suivant (sweep initial) et périodiquement. Désactivation
   * UNIQUEMENT explicite : `PAYMENT_WEBHOOK_RECONCILE_INTERVAL_MS=0`
   * (les échéances restent persistées et reprises à chaque envoi webhooks /
   * rafraîchissement client).
   */
  reconcileIntervalMs(): number {
    const raw = this.config.get<string>('PAYMENT_WEBHOOK_RECONCILE_INTERVAL_MS');
    if (raw === undefined || raw === null || raw === '') return 60_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 60_000;
  }

  /**
   * §4.5 — état des sessions simulées DURCI en base (`CardPayment`) : le
   * connecteur simulé partage la vérité de la plateforme, quel que soit le
   * nombre d'instances d'API ou les redémarrages.
   */
  private simulatedStore(): SimulatedSessionStore {
    const prisma = this.prisma;
    const load = async (
      sessionRef: string,
    ): Promise<SimulatedSessionSnapshot | null> => {
      const row = await prisma.cardPayment.findFirst({
        where: { providerSessionRef: sessionRef, providerCode: 'simulated' },
        select: {
          providerPaymentRef: true,
          amountCents: true,
          currency: true,
          status: true,
        },
      });
      if (!row) return null;
      return {
        paymentRef: row.providerPaymentRef,
        amountTotalCents: row.amountCents,
        currency: row.currency.toLowerCase(),
        paid:
          row.status === CardPaymentStatus.SUCCEEDED ||
          row.status === CardPaymentStatus.PARTIALLY_REFUNDED ||
          row.status === CardPaymentStatus.REFUNDED,
        expired: row.status === CardPaymentStatus.EXPIRED,
        canceled: row.status === CardPaymentStatus.CANCELED,
      };
    };
    return {
      findSession: load,
      hasSession: async (sessionRef: string) => (await load(sessionRef)) !== null,
    };
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
