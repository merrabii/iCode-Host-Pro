import { C3CapabilityService } from './c3-capability.service';

/**
 * 17B.4F-C3 — capability du parcours C3. Contrat testé (plan corrigé) :
 *  - `operational()` = colonnes C1 (2) ET table C3 présentes ;
 *  - cache POSITIF sticky : présence confirmée ⇒ plus aucune sonde ;
 *  - cache négatif JAMAIS seul fondement : chaque appel re-sonde live ;
 *  - erreur DB pendant la sonde ⇒ exception propagée (jamais legacy) ;
 *  - `resolveTracking` : table absente ⇒ null (sans lecture) ; table présente ⇒
 *    lecture du tracking ; toute erreur propagée.
 */
describe('C3CapabilityService (17B.4F-C3)', () => {
  type Impl = {
    columns?: unknown[];
    tables?: unknown[];
    throwOn?: 'columns' | 'tables' | 'read';
  };

  const make = (impl: Impl = {}) => {
    const $queryRaw = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (impl.throwOn === 'columns' && sql.includes('information_schema.columns')) {
        throw new Error('DB down (columns)');
      }
      if (impl.throwOn === 'tables' && sql.includes('information_schema.tables')) {
        throw new Error('DB down (tables)');
      }
      if (sql.includes('information_schema.columns')) return impl.columns ?? [];
      if (sql.includes('information_schema.tables')) return impl.tables ?? [];
      return [];
    });
    const findUnique = jest.fn(() => {
      if (impl.throwOn === 'read') throw new Error('DB down (read)');
      return Promise.resolve(null);
    });
    const prisma = { $queryRaw, orderProvisioningTracking: { findUnique } };
    return { svc: new C3CapabilityService(prisma as never), $queryRaw, findUnique };
  };

  const C1_OK = [{ matches: 2n }];
  const C1_KO = [{ matches: 1n }];
  const TABLE_OK = [{ exists: true }];
  const TABLE_KO = [{ exists: false }];

  it('operational() = C1 (2 colonnes) ∧ table présente', async () => {
    const { svc, $queryRaw } = make({ columns: C1_OK, tables: TABLE_OK });
    await expect(svc.operational()).resolves.toBe(true);
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('colonnes C1 incomplètes ⇒ false (fail-closed)', async () => {
    const { svc } = make({ columns: C1_KO, tables: TABLE_OK });
    await expect(svc.operational()).resolves.toBe(false);
  });

  it('table C3 absente ⇒ false (fail-closed)', async () => {
    const { svc } = make({ columns: C1_OK, tables: TABLE_KO });
    await expect(svc.operational()).resolves.toBe(false);
  });

  it('cache POSITIF sticky : présence confirmée ⇒ plus aucune sonde', async () => {
    const { svc, $queryRaw } = make({ columns: C1_OK, tables: TABLE_OK });
    await expect(svc.operational()).resolves.toBe(true);
    await expect(svc.operational()).resolves.toBe(true);
    await expect(svc.operational()).resolves.toBe(true);
    expect($queryRaw).toHaveBeenCalledTimes(2); // jamais 6
    expect(await svc.c1ColumnsAvailable()).toBe(true);
    expect(await svc.tableAvailable()).toBe(true);
    expect($queryRaw).toHaveBeenCalledTimes(2); // sticky : aucune sonde neuve
  });

  it('cache négatif JAMAIS seul fondement : chaque appel re-sonde live (T-corr.1)', async () => {
    const impl: Impl = { columns: C1_OK, tables: TABLE_KO };
    const { svc, $queryRaw } = make(impl);
    await expect(svc.operational()).resolves.toBe(false);
    expect($queryRaw).toHaveBeenCalledTimes(2);
    // La migration arrive entre deux appels : re-sonde live → vu immédiatement.
    // (C1 est resté positif en cache sticky → UNE seule sonde tables supplémentaire.)
    impl.tables = TABLE_OK;
    await expect(svc.operational()).resolves.toBe(true);
    expect($queryRaw).toHaveBeenCalledTimes(3);
    // L'âge négatif reste un simple diagnostic (jamais un fondement) même après
    // qu'un résultat positif sticky a été obtenu.
    expect(svc.negativeCacheAgeMs()).not.toBeNull();
  });

  it('erreur DB pendant la sonde ⇒ exception propagée (jamais faux legacy/OFF)', async () => {
    const { svc } = make({ columns: C1_OK, tables: TABLE_OK, throwOn: 'tables' });
    await expect(svc.operational()).rejects.toThrow('DB down (tables)');
    await expect(svc.tableAvailable()).rejects.toThrow('DB down (tables)');
  });

  it('resolveTracking : table absente ⇒ null SANS lire la table (sonde live)', async () => {
    const { svc, findUnique } = make({ tables: TABLE_KO });
    await expect(svc.resolveTracking('ord1')).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('resolveTracking : table présente + row ⇒ intent retourné', async () => {
    const { svc, findUnique } = make({ tables: TABLE_OK });
    findUnique.mockResolvedValue({ intent: { business: { productId: 'p1' } } } as never);
    await expect(svc.resolveTracking('ord1')).resolves.toEqual({
      intent: { business: { productId: 'p1' } },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { orderId: 'ord1' },
      select: { intent: true },
    });
  });

  it('resolveTracking : table présente + aucune row ⇒ null (ancien achat)', async () => {
    const { svc, findUnique } = make({ tables: TABLE_OK });
    findUnique.mockResolvedValue(null);
    await expect(svc.resolveTracking('ord-old')).resolves.toBeNull();
  });

  it('resolveTracking : erreur DB en LECTURE ⇒ propagée (jamais legacy)', async () => {
    const { svc } = make({ tables: TABLE_OK, throwOn: 'read' });
    await expect(svc.resolveTracking('ord1')).rejects.toThrow('DB down (read)');
  });

  it('resolveTracking : erreur DB pendant la SONDE ⇒ propagée (jamais legacy)', async () => {
    const { svc } = make({ throwOn: 'tables' });
    await expect(svc.resolveTracking('ord1')).rejects.toThrow('DB down (tables)');
  });

  it('negativeCacheAgeMs : null sans négatif observé, âge après négativité', async () => {
    const { svc } = make({ columns: C1_OK, tables: TABLE_OK });
    expect(svc.negativeCacheAgeMs()).toBeNull();
    const { svc: ko } = make({ columns: C1_OK, tables: TABLE_KO });
    await ko.operational();
    const now = Date.now();
    const age = ko.negativeCacheAgeMs(now);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThanOrEqual(now);
  });
});
