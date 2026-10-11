import { ConflictException, Injectable } from '@nestjs/common';
import { PaymentMethodType, PaymentSettings, Prisma } from '@prisma/client';
import { JwtPayload } from '../auth/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { isPaymentSimulatorEnabled } from '../config/payment-simulator';
import {
  cardCurrenciesOf,
  stripeUnusableReason,
  stripeUsability,
} from '../payments/stripe-usability';

/** Parcours de paiement pilotés par `PaymentSettings` (interrupteurs indépendants). */
export type PaymentCapability = 'wallet' | 'cardOrder' | 'cardTopup';

export interface PaymentCapabilities {
  walletPaymentEnabled: boolean;
  cardOrderPaymentEnabled: boolean;
  cardTopupEnabled: boolean;
}

/**
 * GO revue §5b — capacités EFFECTIVES : les interrupteurs seuls ne suffisent
 * pas à décrire ce que le client peut réellement faire. Une carte affichée
 * dont le connecteur refuse (identité incohérente, devise non autorisée,
 * ligne CARTE désactivée) est un faux affichage. Ces champs décrivent la
 * disponibilité opérationnelle ; les 3 booléens d'interrupteur restent
 * exposés tels quels (indépendants).
 */
export interface EffectivePaymentCapabilities extends PaymentCapabilities {
  /** Moyen CARTE réellement utilisable (interrupteur non requis ici). */
  cardAvailable: boolean;
  /** Devises acceptées par le connecteur résolu ([] si indisponible). */
  cardCurrencies: string[];
  /** Raison honnête (jamais de secret) si la carte est indisponible. */
  cardUnavailableReason: string | null;
}

/** État ADMIN d'un moyen de paiement (aucun secret exposé). */
export type MethodState = 'disabled' | 'incomplete' | 'operational';

export interface MethodStateView {
  state: MethodState;
  /** Explication utile pour l'admin — JAMAIS de secret (clé, token, IBAN complet). */
  stateReason: string | null;
}

export interface UpdatePaymentSettingsDto {
  walletPaymentEnabled?: boolean;
  cardOrderPaymentEnabled?: boolean;
  cardTopupEnabled?: boolean;
}

const CAPABILITY_FIELD: Record<PaymentCapability, keyof PaymentCapabilities> = {
  wallet: 'walletPaymentEnabled',
  cardOrder: 'cardOrderPaymentEnabled',
  cardTopup: 'cardTopupEnabled',
};

const CAPABILITY_LABEL: Record<PaymentCapability, string> = {
  wallet: 'Règlement d’une commande par solde',
  cardOrder: 'Paiement direct d’une commande par carte',
  cardTopup: 'Recharge du portefeuille par carte',
};

const ALL_FIELDS: (keyof PaymentCapabilities)[] = [
  'walletPaymentEnabled',
  'cardOrderPaymentEnabled',
  'cardTopupEnabled',
];

/**
 * Réglages OPÉRATIONNELS des moyens de paiement (en base, jamais en env).
 *
 * Invariants :
 *  - trois interrupteurs INDÉPENDANTS : la recharge et le règlement par solde
 *    ne s'activent ni ne se désactivent jamais l'un l'autre ;
 *  - le gate (`assertEnabled`) est appelé par le serveur AVANT tout NOUVEAU
 *    débit ou toute création de paiement : masquer un bouton ne suffit pas ;
 *  - une désactivation n'interdit QUE les NOUVELLES opérations : webhooks,
 *    confirmation, rapprochement et remboursement d'un paiement déjà engagé
 *    restent pleinement fonctionnels (aucun gate sur ces chemins) ;
 *  - la désactivation ne touche NI le solde du portefeuille NI son historique ;
 *  - chaque modification est audité (auteur + ancienne/nouvelle valeur, sans
 *    secret).
 */
@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Singleton créé sûrement (course = P2002 → relecture), sans réinitialisation. */
  async ensure(): Promise<PaymentSettings> {
    const existing = await this.prisma.paymentSettings.findUnique({
      where: { id: 'singleton' },
    });
    if (existing) return existing;
    try {
      return await this.prisma.paymentSettings.create({ data: { id: 'singleton' } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.paymentSettings.findUnique({
          where: { id: 'singleton' },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  async capabilities(): Promise<PaymentCapabilities> {
    const s = await this.ensure();
    return {
      walletPaymentEnabled: s.walletPaymentEnabled,
      cardOrderPaymentEnabled: s.cardOrderPaymentEnabled,
      cardTopupEnabled: s.cardTopupEnabled,
    };
  }

  /**
   * GATE SERVEUR — appelé AVANT tout nouveau débit ou toute création de
   * paiement. Un appel API direct contourne l'UI : il reçoit le même refus
   * (409 `PAYMENT_METHOD_DISABLED`), sans effet (zéro débit, zéro session).
   */
  async assertEnabled(capability: PaymentCapability): Promise<void> {
    const caps = await this.capabilities();
    if (caps[CAPABILITY_FIELD[capability]]) return;
    throw new ConflictException({
      message:
        `${CAPABILITY_LABEL[capability]} est désactivé par l’administrateur : ` +
        'cette opération est refusée (aucun débit, aucun paiement créé).',
      code: 'PAYMENT_METHOD_DISABLED',
      capability,
    });
  }

  /** Mise à jour admin (PATCH) — atomique avec son audit (GO §5.1). */
  async update(
    dto: UpdatePaymentSettingsDto,
    actor: JwtPayload,
  ): Promise<PaymentCapabilities> {
    const current = await this.ensure();
    const data: Record<string, boolean> = {};
    const changes: { field: string; from: boolean; to: boolean }[] = [];
    for (const field of ALL_FIELDS) {
      const next = dto[field];
      if (typeof next !== 'boolean' || next === current[field]) continue;
      data[field] = next;
      changes.push({ field, from: current[field], to: next });
    }
    if (changes.length === 0) return this.capabilities();

    // GO §5.1 — réglage + audit dans LA MÊME transaction : un PATCH sans
    // trace (ou une trace sans PATCH) est impossible.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.paymentSettings.update({
        where: { id: 'singleton' },
        data,
      });
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'payment.settings.update',
          resourceType: 'paymentSettings',
          resourceId: 'singleton',
          details: { changes },
        },
        tx,
      );
      return row;
    });
    return {
      walletPaymentEnabled: updated.walletPaymentEnabled,
      cardOrderPaymentEnabled: updated.cardOrderPaymentEnabled,
      cardTopupEnabled: updated.cardTopupEnabled,
    };
  }

  /**
   * GO §5.2 — gate serveur sur la ligne `PaymentMethod` CARTE (activation
   * admin indépendante des interrupteurs) : si le moyen existe et est
   * désactivé, aucun chemin serveur n'accepte un paiement carte, même par
   * appel API direct.
   */
  async assertCardMethodActive(): Promise<void> {
    const method = await this.prisma.paymentMethod.findFirst({
      where: { type: PaymentMethodType.CARD },
      select: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (method && !method.isActive) {
      throw new ConflictException({
        message:
          'Le moyen de paiement par carte est désactivé par l’administrateur : ' +
          'cette opération est refusée (aucun débit, aucun paiement créé).',
        code: 'PAYMENT_METHOD_DISABLED',
        capability: 'card',
      });
    }
  }

  /**
   * Disponibilité TECHNIQUE du traitement carte, indépendante des
   * interrupteurs — GO revue §5b : la lecture est ALIGNÉE sur le
   * connecteur que `PaymentProviderService.resolve()` résoudrait
   * RÉELLEMENT (même helper pur `stripeUsability`, même ordre de
   * primauté : Stripe actif d'abord, simulateur seulement en repli
   * d'un Stripe ABSENT ou INACTIF ; un Stripe actif mais inutilisable
   * est un refus, jamais un repli silencieux). Une identité déclarée ≠
   * vérifiée est donc « unavailable » ici exactement comme resolve()
   * la refuse (anciennement affichée « configured » → faux affichage).
   * Aucune valeur chiffrée n'est lue ni renvoyée.
   */
  async cardProviderStatus(): Promise<
    | { kind: 'simulator' }
    | { kind: 'unavailable'; reason: string }
    | { kind: 'configured'; currencies: string[] }
  > {
    const stripe = await this.prisma.paymentProviderSetting.findUnique({
      where: { code: 'stripe' },
      select: {
        isActive: true,
        environment: true,
        secretKeyEnc: true,
        merchantAccount: true,
        lastCheckAccount: true,
        allowedCurrencies: true,
      },
    });
    if (stripe?.isActive) {
      const usable = stripeUsability(stripe);
      if (!usable.usable) {
        return { kind: 'unavailable', reason: stripeUnusableReason(usable.code) };
      }
      return {
        kind: 'configured',
        currencies: cardCurrenciesOf(stripe.allowedCurrencies),
      };
    }
    if (isPaymentSimulatorEnabled()) return { kind: 'simulator' };
    return {
      kind: 'unavailable',
      reason:
        'aucun prestataire de carte actif en mode test (clé secrète manquante ou identité marchande non vérifiée : « Tester la connexion »)',
    };
  }

  /**
   * GO revue §5b — capacités EFFECTIVES pour le client : interrupteurs ∩
   * ligne CARTE active (si elle existe) ∩ connecteur réellement résolvable
   * ∩ devise du connecteur. Les 3 booléens d'interrupteur restent les
   * valeurs BRUTES (indépendantes, jamais masquées) ; `cardAvailable` /
   * `cardCurrencies` / `cardUnavailableReason` décrivent la disponibilité
   * opérationnelle. Le gate serveur (`assertEnabled` /
   * `assertCardMethodActive`) reste appliqué à chaque opération : ce
   * n'est que du masquage UI honnête.
   */
  async effectiveCapabilities(): Promise<EffectivePaymentCapabilities> {
    const caps = await this.capabilities();
    const method = await this.prisma.paymentMethod.findFirst({
      where: { type: PaymentMethodType.CARD },
      select: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    const methodOk = !method || method.isActive;
    const status = await this.cardProviderStatus();
    if (!methodOk) {
      return {
        ...caps,
        cardAvailable: false,
        cardCurrencies: [],
        cardUnavailableReason:
          'le moyen de paiement par carte est désactivé par l’administrateur',
      };
    }
    if (status.kind === 'unavailable') {
      return {
        ...caps,
        cardAvailable: false,
        cardCurrencies: [],
        cardUnavailableReason: status.reason,
      };
    }
    const cardCurrencies =
      status.kind === 'simulator'
        ? await this.simulatedCurrencies()
        : status.currencies;
    return {
      ...caps,
      cardAvailable: true,
      cardCurrencies,
      cardUnavailableReason: null,
    };
  }

  /** Devises du simulateur (ligne `simulated`, grille par défaut si absente). */
  private async simulatedCurrencies(): Promise<string[]> {
    const sim = await this.prisma.paymentProviderSetting.findUnique({
      where: { code: 'simulated' },
      select: { allowedCurrencies: true },
    });
    return cardCurrenciesOf(sim?.allowedCurrencies);
  }

  /**
   * État ADMIN d'un moyen (« désactivé » / « configuration incomplète » /
   * « opérationnel ») — explication honnête, JAMAIS de secret.
   */
  async methodState(method: {
    type: PaymentMethodType;
    isActive: boolean;
    config: Prisma.JsonValue;
    configEnc: string | null;
  }): Promise<MethodStateView> {
    if (!method.isActive) {
      return {
        state: 'disabled',
        stateReason:
          'Désactivé : ce moyen n’est jamais proposé au client et aucune nouvelle opération ne peut le passer.',
      };
    }

    if (method.type === PaymentMethodType.CARD) {
      const caps = await this.capabilities();
      if (!caps.cardOrderPaymentEnabled && !caps.cardTopupEnabled) {
        return {
          state: 'disabled',
          stateReason:
            'Désactivé : les parcours carte (règlement de commande et recharge) sont tous deux désactivés dans les réglages.',
        };
      }
      const status = await this.cardProviderStatus();
      if (status.kind === 'simulator') {
        return {
          state: 'operational',
          stateReason:
            'Opérationnel (simulateur de recette activé) : le prestataire est simulé, aucun paiement réel.',
        };
      }
      if (status.kind === 'unavailable') {
        return {
          state: 'incomplete',
          stateReason: `Configuration incomplète : ${status.reason}. La carte reste masquée au client tant que ce n’est pas réglé.`,
        };
      }
      if (status.currencies.length > 0 && !status.currencies.includes('USD')) {
        return {
          state: 'incomplete',
          stateReason:
            'Configuration incomplète : le prestataire n’autorise pas la devise USD (aucune conversion de change automatique).',
        };
      }
      const parcours = [
        caps.cardOrderPaymentEnabled ? 'règlement de commande' : null,
        caps.cardTopupEnabled ? 'recharge' : null,
      ].filter(Boolean);
      return {
        state: 'operational',
        stateReason: `Opérationnel : prestataire configuré (mode test), parcours actif(s) : ${
          parcours.join(' et ') || 'aucun'
        }.`,
      };
    }

    const config = method.config;
    const hasConfig =
      config !== null &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      Object.keys(config as Record<string, unknown>).length > 0;
    if (!hasConfig) {
      return {
        state: 'incomplete',
        stateReason:
          'Configuration incomplète : aucune coordonnée d’affichage (config non secrète) renseignée — le client ne peut pas régler par ce moyen.',
      };
    }
    return {
      state: 'operational',
      stateReason: 'Opérationnel : moyen actif avec ses coordonnées d’affichage.',
    };
  }
}
