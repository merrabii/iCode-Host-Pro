import { CheckoutService } from './checkout.service';

// Bloc C — régression prod (2026-09-14) : la clé d'idempotence DOIT inclure le
// sous-domaine demandé. Sans lui, re-commander le MÊME produit avec un sous-domaine
// DIFFÉRENT (même montant/options) produisait la MÊME clé → replay de l'ancienne
// commande, sans jamais provisionner la nouvelle app. Deux sous-domaines = deux
// commandes distinctes.
//
// Ces tests visent la méthode privée idempotencyKey (fonction pure de hachage) :
// pas de réseau, pas de Prisma réel. Les dépendances sont des mocks vides.
describe('CheckoutService — idempotencyKey inclut le sous-domaine', () => {
  const mockPrisma = {};
  const mockProducts = {};
  const mockAudit = {};
  const mockLimiter = {};
  const mockMail = {};
  const mockProvisioning = {};
  const mockCloudflare = {};

  let service: CheckoutService;

  const key = (
    dto: { productSlug: string },
    methodId: string,
    amountTtcCents: number,
    billingEmail: string,
    subdomain: string | null,
    rootDomainId?: string | null,
  ): string =>
    (service as unknown as {
      idempotencyKey: (
        d: typeof dto,
        m: string,
        a: number,
        e: string,
        s: string | null,
        r: string | null,
      ) => string;
    }).idempotencyKey(dto, methodId, amountTtcCents, billingEmail, subdomain, rootDomainId ?? null);

  const base = { productSlug: 'deploy-github-app' };

  beforeEach(() => {
    service = new CheckoutService(
      mockPrisma as never,
      mockProducts as never,
      mockAudit as never,
      mockLimiter as never,
      mockMail as never,
      mockProvisioning as never,
      mockCloudflare as never,
    );
  });

  it('deux configurations identiques SAUF sous-domaine ⇒ clés différentes (pas de replay)', () => {
    const k1 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha');
    const k2 = key(base, 'pm1', 4900, 'mourad@example.com', 'beta');
    expect(k1).not.toEqual(k2);
  });

  it('deux configurations IDENTIQUES (même sous-domaine) ⇒ MÊME clé', () => {
    const k1 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha');
    const k2 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha');
    expect(k1).toEqual(k2);
  });

  it('le passage d’un sous-domaine (vs null) ⇒ clé différente', () => {
    const kNull = key(base, 'pm1', 4900, 'mourad@example.com', null);
    const kSome = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha');
    expect(kNull).not.toEqual(kSome);
  });

  it('produits sans sous-domaine : null ⇒ payload inchangé (compatibilité)', () => {
    // Deux configs sans sous-domaine, tout le reste identique ⇒ MÊME clé (replay
    // inchangé pour les produits sans sous-domaine, comportement historique).
    const k1 = key(base, 'pm1', 4900, 'mourad@example.com', null);
    const k2 = key(base, 'pm1', 4900, 'mourad@example.com', null);
    expect(k1).toEqual(k2);
  });

  it('Phase 4 — même sous-domaine, racine DIFFÉRENTE ⇒ clés différentes', () => {
    const k1 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha', 'dom1');
    const k2 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha', 'dom2');
    expect(k1).not.toEqual(k2);
  });

  it('Phase 4 — config identique y compris racine ⇒ MÊME clé', () => {
    const k1 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha', 'dom1');
    const k2 = key(base, 'pm1', 4900, 'mourad@example.com', 'alpha', 'dom1');
    expect(k1).toEqual(k2);
  });
});