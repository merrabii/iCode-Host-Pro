import { BadRequestException } from '@nestjs/common';
import { StoreSubdomainController } from './store-subdomain.controller';

// Phase 4 — multi-domaines : le check public /store/subdomain/check doit résoudre la
// racine de la MÊME façon que CloudflareService.resolveEffectiveRoot (priorité
// effective/requested → défaut plateforme → intersection allowedDomainIds∩ACTIVE,
// 1=utilisée / >1=ambigüité sans choix / 0=erreur). AUCUN fallback arbitraire
// (`allowedDomainIds[0]`, premier ACTIVE). Vérifie items 18/19 + [7]/[10].
describe('StoreSubdomainController.check — Phase 4 (multi-domaines)', () => {
  const mockPrisma = {
    product: { findUnique: jest.fn() },
    domain: { findMany: jest.fn() },
    cloudflareSetting: { findFirst: jest.fn() },
  };
  const mockCloudflare = { checkSubdomainAvailability: jest.fn() };

  let controller: StoreSubdomainController;

  const dto = (over: Record<string, unknown> = {}) => ({
    productSlug: 'premium',
    subdomain: 'monapp',
    ...over,
  });

  const rule = (allowedDomainIds: string[]) => ({
    minLength: 3,
    maxLength: 40,
    rejectPattern: null,
    reservedPrefixes: [],
    allowedDomainIds,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new StoreSubdomainController(mockPrisma as never, mockCloudflare as never);
  });

  it('produit sans FreeSubdomainRule → BadRequest (pas de sous-domaine)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ freeSubdomainRule: null });
    await expect(controller.check(dto())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('racine explicite (requestedDomainId) éligible → check sur CE domaine (#5/#18)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      freeSubdomainRule: rule(['dom-a', 'dom-b']),
    });
    mockPrisma.domain.findMany.mockResolvedValue([
      { id: 'dom-a', name: 'codediali.com' },
      { id: 'dom-b', name: 'arumdigital.com' },
    ]);
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.codediali.com',
    });
    const out = await controller.check(dto({ requestedDomainId: 'dom-a' }));
    expect(mockCloudflare.checkSubdomainAvailability).toHaveBeenCalledWith('monapp', 'dom-a');
    expect(out.available).toBe(true);
    expect(out.reason).toBeUndefined();
  });

  it('racine explicitement hors whitelist → invalid, AUCUN check, AUCUN fallback (#7)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      freeSubdomainRule: rule(['dom-a']),
    });
    mockPrisma.domain.findMany.mockResolvedValue([{ id: 'dom-a', name: 'codediali.com' }]);
    const out = await controller.check(dto({ requestedDomainId: 'dom-z' }));
    expect(out).toEqual({ available: false, fqdn: 'monapp.…', reason: 'invalid' });
    expect(mockCloudflare.checkSubdomainAvailability).not.toHaveBeenCalled();
  });

  it('défaut PLATEFORME (rootDomainId éligible) → utilisé sans demander de choix (#1/#19)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      freeSubdomainRule: rule(['dom-a', 'dom-b']),
    });
    mockPrisma.domain.findMany.mockResolvedValue([
      { id: 'dom-a', name: 'codediali.com' },
      { id: 'dom-b', name: 'arumdigital.com' },
    ]);
    mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: 'dom-b' });
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.arumdigital.com',
    });
    const out = await controller.check(dto());
    expect(mockCloudflare.checkSubdomainAvailability).toHaveBeenCalledWith('monapp', 'dom-b');
    expect(out.available).toBe(true);
  });

  it('plusieurs racines éligibles, aucun choix ni défaut → ambiguïté (invalid), jamais de pick (#10)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      freeSubdomainRule: rule(['dom-a', 'dom-b']),
    });
    mockPrisma.domain.findMany.mockResolvedValue([
      { id: 'dom-a', name: 'codediali.com' },
      { id: 'dom-b', name: 'arumdigital.com' },
    ]);
    mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: null });
    const out = await controller.check(dto());
    expect(out.available).toBe(false);
    expect(out.reason).toBe('invalid');
    expect(mockCloudflare.checkSubdomainAvailability).not.toHaveBeenCalled();
  });

  it('racine UNIQUE éligible → utilisée sans ambiguïté (le [0] est prouvé unique)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ freeSubdomainRule: rule(['dom-a']) });
    mockPrisma.domain.findMany.mockResolvedValue([{ id: 'dom-a', name: 'codediali.com' }]);
    mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: null });
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.codediali.com',
    });
    const out = await controller.check(dto());
    expect(mockCloudflare.checkSubdomainAvailability).toHaveBeenCalledWith('monapp', 'dom-a');
    expect(out.available).toBe(true);
  });

  it('aucune racine éligible → invalid (#10)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ freeSubdomainRule: rule(['dom-a']) });
    mockPrisma.domain.findMany.mockResolvedValue([]);
    const out = await controller.check(dto());
    expect(out.available).toBe(false);
    expect(out.reason).toBe('invalid');
    expect(mockCloudflare.checkSubdomainAvailability).not.toHaveBeenCalled();
  });

  it('allowedDomainIds=[] ⇒ toutes les racines ACTIVE (le findMany ne filtre pas par id)', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ freeSubdomainRule: rule([]) });
    mockPrisma.domain.findMany.mockResolvedValue([{ id: 'dom-a', name: 'codediali.com' }]);
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      fqdn: 'monapp.codediali.com',
    });
    await controller.check(dto());
    const where = mockPrisma.domain.findMany.mock.calls[0][0].where;
    expect(where.id).toBeUndefined(); // pas de filtre whitelist
    expect(where.status).toBe('ACTIVE');
  });

  it('sous-domaine déjà pris derrière la racine explicite → reason taken', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({
      freeSubdomainRule: rule(['dom-a']),
    });
    mockPrisma.domain.findMany.mockResolvedValue([{ id: 'dom-a', name: 'codediali.com' }]);
    mockCloudflare.checkSubdomainAvailability.mockResolvedValue({
      available: false,
      fqdn: 'monapp.codediali.com',
    });
    const out = await controller.check(dto({ requestedDomainId: 'dom-a' }));
    expect(out).toEqual({ available: false, fqdn: 'monapp.codediali.com', reason: 'taken' });
  });
});