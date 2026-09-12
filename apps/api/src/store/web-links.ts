/**
 * URLs publiques du tunnel / des emails boutique. Le web (Next.js) est servi sur
 * `PUBLIC_BASE_URL` (défaut localhost:3000, même valeur que config.publicBaseUrl).
 * Ne pas injecter ConfigService ici : ces services sont construits par des specs
 * jest avec un constructeur énuméré — un helper env-only reste non invasif.
 */
export function webBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** Page de connexion / espace d'auth du client. */
export const loginUrl = () => `${webBaseUrl()}/auth`;

/** Espace client (abonnements, apps, factures). */
export const clientAreaUrl = () => `${webBaseUrl()}/client`;