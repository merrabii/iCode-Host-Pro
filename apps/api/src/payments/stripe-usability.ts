/**
 * GO revue §5b — disponibilité OPÉRATIONNELLE du connecteur Stripe test,
 * extraite dans un helper PUR partagé par :
 *  - `PaymentProviderService.resolve()` (gate des opérations) ;
 *  - `PaymentSettingsService.cardProviderStatus()` / `effectiveCapabilities()`
 *    (disponibilité affichée à l'admin et capacités publiques).
 *
 * Un seul jeu de règles : ce qui est affiché « opérationnel » est exactement
 * ce que le serveur accepte de résolder (aucune divergence possible entre le
 * bouton affiché et le gate serveur). Aucune valeur secrète n'est lue ni
 * renvoyée ici (uniquement la PRESENCE d'une clé).
 */

/** Champs d'une ligne `PaymentProviderSetting` nécessaires au jugement. */
export interface StripeSettingFingerprint {
  environment: string;
  secretKeyEnc: string | null;
  merchantAccount: string | null;
  lastCheckAccount: string | null;
}

export type StripeUsabilityCode =
  | 'not_test'
  | 'no_secret'
  | 'identity_mismatch'
  | 'identity_unverified';

export type StripeUsability =
  | { usable: true; verifiedAccount: string }
  | {
      usable: false;
      code: StripeUsabilityCode;
      declared: string | null;
      verified: string | null;
    };

/**
 * Règles de résolution Stripe (mode test uniquement) — MÊMES règles que
 * `PaymentProviderService.resolve()` :
 *  - `environment !== 'test'` → refus (aucune activation live) ;
 *  - clé secrète absente → refus (configuration invalide) ;
 *  - identité : seul un compte VÉRIFIÉ par « Tester la connexion » ouvre les
 *    opérations ; un écart déclaré ≠ vérifié est une incohérence refusée ;
 *  - `requireMerchantAccount: false` sert UNIQUEMENT au contrôle de connexion
 *    (l'identité n'est alors pas exigée).
 */
export function stripeUsability(
  row: StripeSettingFingerprint,
  opts: { requireMerchantAccount?: boolean } = {},
): StripeUsability {
  const requireMerchant = opts.requireMerchantAccount !== false;
  const declared = row.merchantAccount ?? null;
  const verified = row.lastCheckAccount ?? null;
  if (row.environment !== 'test') {
    return { usable: false, code: 'not_test', declared, verified };
  }
  if (!row.secretKeyEnc) {
    return { usable: false, code: 'no_secret', declared, verified };
  }
  if (requireMerchant) {
    if (declared && verified && declared !== verified) {
      return { usable: false, code: 'identity_mismatch', declared, verified };
    }
    if (!verified) {
      return { usable: false, code: 'identity_unverified', declared, verified };
    }
  }
  return { usable: true, verifiedAccount: verified ?? declared ?? '' };
}

/** Raison COURTE (admin/publique, sans secret) d'une configuration inutilisable. */
export function stripeUnusableReason(code: StripeUsabilityCode): string {
  switch (code) {
    case 'not_test':
      return 'configuration live refusée (mode test uniquement)';
    case 'no_secret':
      return 'clé secrète manquante';
    case 'identity_mismatch':
      return 'identité marchande incohérente (compte déclaré ≠ compte vérifié)';
    case 'identity_unverified':
      return 'identité marchande non vérifiée (« Tester la connexion » requis)';
  }
}

/** Devise d'une ligne de configuration (défaut honnête = grille carte). */
export function cardCurrenciesOf(
  allowedCurrencies: unknown,
  fallback: readonly string[] = ['USD', 'EUR'],
): string[] {
  if (Array.isArray(allowedCurrencies)) {
    const list = allowedCurrencies.filter((c): c is string => typeof c === 'string');
    if (list.length) return list;
  }
  return [...fallback];
}
