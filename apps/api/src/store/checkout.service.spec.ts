import { BadRequestException } from '@nestjs/common';
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
// Phase 4 — multi-domaines : `resolveSubdomainAndRoot` (choix de la racine au checkout).
// Le checkout sélectionne la racine des sous-domaines en alignant CloudflareService.
//resolveEffectiveRoot : requestedDomainId éligible → persisté ; sinon défaut
// plateforme / racine unique / ambiguïté. `requestedDomainId` ressortant sera persisté
// sur l'Order (item 12) et entre dans la clé d'idempotence (tests ci-dessus).
describe('CheckoutService — resolveSubdomainAndRoot (Phase 4, choix racine)', () => {
  const mockPrisma = {
    domain: { findMany: jest.fn() },
    cloudflareSetting: { findFirst: jest.fn() },
    paymentMethod: { findFirst: jest.fn() },
    order: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    customer: { findUnique: jest.fn() },
  };
  const mockProducts = {};
  const mockAudit = {};
  const mockLimiter = {};
  const mockMail = {};
  const mockProvisioning = {};
  const mockCloudflare = { checkSubdomainAvailability: jest.fn() };

  let service: CheckoutService;

  const product = (allowedDomainIds: string[]) => ({
    id: 'p1',
    slug: 'premium',
    freeSubdomainRule: {
      id: 'r1',
      allowedDomainIds,
      minLength: 3,
      maxLength: 40,
      rejectPattern: null,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
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

  const resolve = (p: unknown, dto: unknown) =>
    (
      service as unknown as {
        resolveSubdomainAndRoot: (p: unknown, d: unknown) => Promise<{
          requestedSubdomain: string | null;
          requestedDomainId: string | null;
        }>;
      }
    ).resolveSubdomainAndRoot(p, dto);

  it('produit sans FreeSubdomainRule → rien (requestedSubdomain null, requestedDomainId null)', async () => {
    await expect(resolve({ id: 'p0' }, {})).resolves.toEqual({
      requestedSubdomain: null,
      requestedDomainId: null,
    });
  });

  it('choix racine (requestedDomainId) éligible → CE requestedDomainId ressort pour la persistence (item 12)', async () => {
    mockPrisma.domain.findMany.mockResolvedValue([
      { id: 'dom-a', name: 'codediali.com' },
      { id: 'dom-b', name: 'arumdigital.com' },
    ]);
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.codediali.com',
    });
    const out = await resolve(product(['dom-a', 'dom-b']), {
      requestedDomainId: 'dom-a',
      subdomain: 'monapp',
    });
    expect(out).toEqual({ requestedSubdomain: 'monapp', requestedDomainId: 'dom-a' });
    expect(mockCloudflare.checkSubdomainAvailability).toHaveBeenCalledWith('monapp', 'dom-a');
  });

  it('racine UNIQUE éligible sans choix → requestedDomainId null (le provisioning figera ; défaut non arbitraire)', async () => {
    mockPrisma.domain.findMany.mockResolvedValue([{ id: 'dom-a', name: 'codediali.com' }]);
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.codediali.com',
    });
    const out = await resolve(product(['dom-a']), { subdomain: 'monapp' });
    expect(out.requestedDomainId).toBeNull();
    expect(out.requestedSubdomain).toBe('monapp');
  });

  it('choix racine hors éligibles → rejet BadRequest (#7), jamais de fallback', async () => {
    mockPrisma.domain.findMany.mockResolvedValue([{ id: 'dom-a', name: 'codediali.com' }]);
    await expect(resolve(product(['dom-a']), { requestedDomainId: 'dom-z', subdomain: 'monapp' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('plusieurs éligibles, aucun choix, pas de défaut plateforme → ambiguïté (BadRequest, #10)', async () => {
    mockPrisma.domain.findMany.mockResolvedValue([
      { id: 'dom-a', name: 'codediali.com' },
      { id: 'dom-b', name: 'arumdigital.com' },
    ]);
    mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: null });
    await expect(resolve(product(['dom-a', 'dom-b']), { subdomain: 'monapp' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('défaut PLATEFORME (rootDomainId éligible) → requestedDomainId reste null, sous-domaine vérifié sous cette racine', async () => {
    mockPrisma.domain.findMany.mockResolvedValue([
      { id: 'dom-a', name: 'codediali.com' },
      { id: 'dom-b', name: 'arumdigital.com' },
    ]);
    mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: 'dom-b' });
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.arumdigital.com',
    });
    const out = await resolve(product(['dom-a', 'dom-b']), { subdomain: 'monapp' });
    expect(out.requestedDomainId).toBeNull();
    expect(mockCloudflare.checkSubdomainAvailability).toHaveBeenCalledWith('monapp', 'dom-b');
  });
});
