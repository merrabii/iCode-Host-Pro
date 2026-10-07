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

  /** Contrôle de connexion réel (appel prestataire en mode test). */
  async checkConnection(
    actor: Actor,
  ): Promise<ProviderMaskedView & { simulated?: boolean }> {
    try {
      const resolved = await this.resolve();
      const account = await resolved.connector.verifyAccount();
      const row = await this.prisma.paymentProviderSetting.update({
        where: { id: resolved.settingId },
        data: {
          lastCheckAt: new Date(),
          lastCheckAccount: account.accountId,
          lastCheckError: null,
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
   * Résolution du connecteur opérationnel :
   *  1. Stripe configuré + actif + test → connecteur Stripe réel ;
   *  2. sinon simulateur (recette/CI) si explicitement activé ;
   *  3. sinon refus net (aucun bouton de paiement non fonctionnel).
   */
  async resolve(): Promise<ResolvedProvider> {
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
      const secretKey = this.decryptOrThrow(stripe.secretKeyEnc, 'la clé secrète');
      const webhookSecret = stripe.webhookSecretEnc
        ? this.decryptOrThrow(stripe.webhookSecretEnc, 'le secret webhook')
        : '';
      return {
        settingId: stripe.id,
        code: 'stripe',
        displayName: stripe.displayName,
        environment: 'test',
        merchantAccount: stripe.merchantAccount ?? 'acct_inconnu',
        currencies: this.currenciesOf(stripe),
        connector: new StripeConnector(secretKey, webhookSecret, this.config),
      };
    }
    if (isPaymentSimulatorEnabled()) {
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
   * Secret webhook attendu pour le code donné (contrôleur webhook).
   * Teste la signature : pas de secret = refus net, jamais de « default OK ».
   */
  async webhookSecretFor(code: string): Promise<string> {
    if (code === 'simulated') {
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

  private currenciesOf(row: PaymentProviderSetting): string[] {
    if (Array.isArray(row.allowedCurrencies)) {
      const list = row.allowedCurrencies.filter(
        (c): c is string => typeof c === 'string',
      );
      if (list.length) return list;
    }
    return [...CARD_CURRENCIES];
  }
}
