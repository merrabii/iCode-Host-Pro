import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  acquireRenewalChainBarrier,
  renewalChainRootId,
  RENEWAL_CHAIN_MAX_DEPTH,
} from './renewal-chain-barrier';

/**
 * GO limite de chaîne — parcours COMPLET de la racine `renewsOrderId` :
 *  - 49 / 50 / 51 liens → racine RÉELLE (l'ancienne « garde 50 » renvoyait
 *    un ancêtre INTERMÉDIAIRE au-delà de 50 → clé de verrou divergente) ;
 *  - racine COMMUNE quel que soit le point de départ → même clé de verrou ;
 *  - cycle / référence manquante / profondeur hors garde → refus explicite
 *    (ConflictException), jamais de racine fausse.
 */
describe('renewalChainRootId (GO limite de chaîne)', () => {
  /** Tx factice : `renews` mappe commande → mère (null = racine ; absent = ligne introuvable). */
  const txOf = (renews: Record<string, string | null>) =>
    ({
      order: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) =>
            where.id in renews ? { renewsOrderId: renews[where.id] } : null,
        ),
      },
      $queryRaw: jest.fn(async () => []),
    }) as unknown as Prisma.TransactionClient;

  /**
   * Chaîne linéaire de `edges` LIENS (n0 feuille → n1 → … → n{edges} racine) :
   * `renews[n_i] = n_{i+1}` pour i < edges, `renews[n_edges] = null`.
   */
  const chain = (edges: number): Record<string, string | null> => {
    const renews: Record<string, string | null> = {};
    for (let i = 0; i < edges; i++) renews[`n${i}`] = `n${i + 1}`;
    renews[`n${edges}`] = null;
    return renews;
  };

  it('49 liens → racine réelle (dernier maillon), jamais un ancêtre intermédiaire', async () => {
    const root = await renewalChainRootId(txOf(chain(49)), 'n0');
    expect(root).toBe('n49');
    expect(root).not.toBe('n48');
  });

  it('50 liens → racine réelle (limite historique exacte)', async () => {
    await expect(renewalChainRootId(txOf(chain(50)), 'n0')).resolves.toBe('n50');
  });

  it('51 liens → racine réelle (l’ancienne garde 50 renvoyait n50 en ancêtre intermédiaire)', async () => {
    const renews = chain(51);
    const root = await renewalChainRootId(txOf(renews), 'n0');
    expect(root).toBe('n51');
    expect(root).not.toBe('n50'); // régression : ancien comportement silencieux
  });

  it('racine COMMUNE depuis la feuille, le milieu et la racine (même clé de verrou)', async () => {
    const renews = chain(51);
    const tx = txOf(renews);
    const fromLeaf = await renewalChainRootId(tx, 'n0');
    const fromMid = await renewalChainRootId(tx, 'n25');
    const fromRoot = await renewalChainRootId(tx, 'n51');
    expect(fromLeaf).toBe('n51');
    expect(fromMid).toBe('n51');
    expect(fromRoot).toBe('n51');
    expect(new Set([fromLeaf, fromMid, fromRoot]).size).toBe(1);
  });

  it('cycle → refus explicite chaine_cyclique (jamais une racine fausse)', async () => {
    const renews: Record<string, string | null> = { a: 'b', b: 'a' };
    await expect(renewalChainRootId(txOf(renews), 'a')).rejects.toThrow(
      /chaine_cyclique/,
    );
    await expect(renewalChainRootId(txOf(renews), 'a')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('référence manquante (mère orpheline) → refus explicite chaine_reference_absente', async () => {
    const renews: Record<string, string | null> = { d: 'ghost-mother' };
    await expect(renewalChainRootId(txOf(renews), 'd')).rejects.toThrow(
      /chaine_reference_absente/,
    );
  });

  it('commande de départ introuvable → refus explicite chaine_reference_absente', async () => {
    await expect(renewalChainRootId(txOf({}), 'missing')).rejects.toThrow(
      /chaine_reference_absente/,
    );
  });

  it(`profondeur hors garde (> ${RENEWAL_CHAIN_MAX_DEPTH} maillons) → refus explicite chaine_profondeur_depassee`, async () => {
    const tooDeep = chain(RENEWAL_CHAIN_MAX_DEPTH + 1);
    await expect(renewalChainRootId(txOf(tooDeep), 'n0')).rejects.toThrow(
      /chaine_profondeur_depassee/,
    );
  });
});

describe('acquireRenewalChainBarrier (clé commune)', () => {
  it('déclenche pg_advisory_xact_lock sur la racine transmise (même racine → même clé)', async () => {
    const $queryRaw = jest.fn(async () => []);
    const tx = { $queryRaw } as unknown as Prisma.TransactionClient;

    await acquireRenewalChainBarrier(tx, 'root-a');
    await acquireRenewalChainBarrier(tx, 'root-a');

    expect($queryRaw).toHaveBeenCalledTimes(2);
    // Même site d'appel + même valeur racine → arguments strictement
    // identiques → hashtextextended produit la MÊME clé advisory.
    const firstCall = $queryRaw.mock.calls[0] as unknown as unknown[];
    const secondCall = $queryRaw.mock.calls[1] as unknown as unknown[];
    expect(firstCall).toEqual(secondCall);
    expect(firstCall[1]).toBe('root-a');
  });
});
