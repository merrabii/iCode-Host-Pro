import { Prisma } from '@prisma/client';
import {
  ORDER_LIFECYCLE_SCHEMA,
  RENEWAL_SCHEMA,
  SWEEP_LEASE_TTL_MS,
  acquireSweepLease,
  releaseSweepLease,
  sweepSchemaPrereqsOk,
} from './sweep-guards';

/**
 * Q6 (GO item 6) — gardes des sweeps : probe de schéma avant mutation et
 * lease multi-processus en base (`SweepLease`).
 */
describe('sweep-guards (Q6 — prérequis de schéma + lease multi-processus)', () => {
  const dbMock = () =>
    ({
      $queryRaw: jest.fn(async () => []),
      sweepLease: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
      },
    }) as unknown as Prisma.TransactionClient & {
      $queryRaw: jest.Mock;
      sweepLease: { updateMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    };

  describe('sweepSchemaPrereqsOk', () => {
    it('tables + colonnes exigées présentes → true (les 2 listes du dépôt)', async () => {
      const db = dbMock();
      db.$queryRaw.mockImplementation(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const table = String(values[0]);
          // Union des colonnes exigées pour cette table (Order figure dans
          // les 2 listes avec des colonnes différentes).
          const reqs = [...ORDER_LIFECYCLE_SCHEMA, ...RENEWAL_SCHEMA].filter(
            (r) => r.table === table,
          );
          if (reqs.length === 0) return [];
          const cols = [...new Set(reqs.flatMap((r) => r.columns ?? ['id']))];
          return cols.map((c) => ({ column_name: c }));
        },
      );

      await expect(sweepSchemaPrereqsOk(db, ORDER_LIFECYCLE_SCHEMA)).resolves.toBe(true);
      await expect(sweepSchemaPrereqsOk(db, RENEWAL_SCHEMA)).resolves.toBe(true);
    });

    it('table absente (0 ligne) → false', async () => {
      const db = dbMock();
      db.$queryRaw.mockResolvedValueOnce([]); // Order absente
      await expect(sweepSchemaPrereqsOk(db, ORDER_LIFECYCLE_SCHEMA)).resolves.toBe(false);
    });

    it('colonne exigée absente → false (colonnes partiellement présentes)', async () => {
      const db = dbMock();
      db.$queryRaw.mockImplementation(async () => [
        { column_name: 'status' }, // Order sans renewsOrderId
      ]);
      await expect(sweepSchemaPrereqsOk(db, ORDER_LIFECYCLE_SCHEMA)).resolves.toBe(false);
    });

    it('lecture en erreur → false (jamais de mutation dans le doute)', async () => {
      const db = dbMock();
      db.$queryRaw.mockRejectedValueOnce(new Error('pg down'));
      await expect(sweepSchemaPrereqsOk(db, RENEWAL_SCHEMA)).resolves.toBe(false);
    });

    it('liste vide → true (aucun prérequis = rien à vérifier)', async () => {
      const db = dbMock();
      await expect(sweepSchemaPrereqsOk(db, [])).resolves.toBe(true);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('acquireSweepLease / releaseSweepLease', () => {
    it('row expirée volée par CAS → jeton retourné', async () => {
      const db = dbMock();
      db.sweepLease.updateMany.mockResolvedValue({ count: 1 });

      const token = await acquireSweepLease(db, 'renewal');

      expect(token).toEqual(expect.any(String));
      expect(db.sweepLease.updateMany).toHaveBeenCalledWith({
        where: { name: 'renewal', expiresAt: { lt: expect.any(Date) } },
        data: { holder: token, expiresAt: expect.any(Date) },
      });
      // TTL borné : le porteur planté rend la passe au plus tard après ici.
      const expires = (db.sweepLease.updateMany.mock.calls[0][0].data.expiresAt as Date).getTime();
      const stolenAt = (db.sweepLease.updateMany.mock.calls[0][0].where.expiresAt.lt as Date).getTime();
      expect(expires - stolenAt).toBe(SWEEP_LEASE_TTL_MS);
    });

    it('row vivante tenue par un autre processus → null (pas de passe)', async () => {
      const db = dbMock();
      db.sweepLease.updateMany.mockResolvedValue({ count: 0 }); // steal : rien à voler
      db.sweepLease.findUnique.mockResolvedValue({
        name: 'renewal',
        holder: 'autre-processus',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(acquireSweepLease(db, 'renewal')).resolves.toBeNull();
      expect(db.sweepLease.create).not.toHaveBeenCalled();
    });

    it('absence de row → création (jeton du créateur)', async () => {
      const db = dbMock();
      const token = await acquireSweepLease(db, 'renewal');
      expect(token).toEqual(expect.any(String));
      expect(db.sweepLease.create).toHaveBeenCalledWith({
        data: { name: 'renewal', holder: token, expiresAt: expect.any(Date) },
      });
    });

    it('course de création (P2002) → null (l’autre porteur tient la passe)', async () => {
      const db = dbMock();
      db.sweepLease.create.mockRejectedValueOnce(new Error('unique violation'));
      await expect(acquireSweepLease(db, 'renewal')).resolves.toBeNull();
    });

    it('base indisponible (steal en erreur) → null (aucun passage sans exclusion)', async () => {
      const db = dbMock();
      db.sweepLease.updateMany.mockRejectedValueOnce(new Error('pg down'));
      await expect(acquireSweepLease(db, 'renewal')).resolves.toBeNull();
    });

    it('release : n’expired que SA row (conditionnée par le jeton), à l’époque', async () => {
      const db = dbMock();
      await releaseSweepLease(db, 'renewal', 'mon-jeton');
      expect(db.sweepLease.updateMany).toHaveBeenCalledWith({
        where: { name: 'renewal', holder: 'mon-jeton' },
        data: { expiresAt: new Date(0) },
      });
    });

    it('release best-effort : une erreur ne propage jamais', async () => {
      const db = dbMock();
      db.sweepLease.updateMany.mockRejectedValueOnce(new Error('pg down'));
      await expect(releaseSweepLease(db, 'renewal', 'mon-jeton')).resolves.toBeUndefined();
    });
  });
});
