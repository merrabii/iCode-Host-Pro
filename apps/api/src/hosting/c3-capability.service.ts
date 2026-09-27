import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 17B.4F-C3 — capability du parcours C3 (contrat C1 + C3 vérifiés LIVE).
 *
 * Contrat (plan corrigé, point « cache négatif ») :
 *  - `operational()` = colonnes C1 (`requestFingerprint`, `providerIntentAt`
 *    sur `HostingServiceAllocation`) ET table dédiée `OrderProvisioningTracking`
 *    présentes. Sous `HOSTING_C3_ENABLED === 'true'`, un résultat `false` impose
 *    un 503 fail-closed AVANT toute écriture métier (jamais de demi-parcours).
 *  - Cache POSITIF sticky (process) : une migration est additive et irréversible
 *    en run — la présence confirmée n'est jamais revérifiée.
 *  - Cache négatif JAMAIS utilisable comme seul fondement : toute classification
 *    « legacy » (parcours OFF sans tracking) passe par une sonde LIVE
 *    `information_schema` à l'appel (`tableAvailable()`). Une migration arrivée
 *    entre deux appels est donc vue immédiatement (test T-corr.1) — un ordre C3
 *    n'est JAMAIS classé legacy sur la foi d'un cache négatif.
 *  - Erreur DB pendant la sonde → l'exception est propagée (jamais de classement
 *    legacy sur une sonde en échec, jamais de faux OFF silencieux).
 * Aucune écriture, aucun secret, aucun accès aux tables métier (metadata seul).
 */
@Injectable()
export class C3CapabilityService {
  /** Présence C1 confirmée (sticky, jamais revérifiée). */
  private c1Positive = false;
  /** Présence C3 confirmée (sticky, jamais revérifiée). */
  private tablePositive = false;
  /** Dernière négativité observée — diagnostique JAMAIS utilisée comme seul fondement. */
  private lastNegativeAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Sonde live des colonnes C1 (information_schema, lecture seule). */
  private async probeC1Columns(): Promise<boolean> {
    if (this.c1Positive) return true;
    const rows = await this.prisma.$queryRaw<Array<{ matches: bigint }>>`
      SELECT COUNT(*)::bigint AS "matches"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'HostingServiceAllocation'
        AND column_name IN ('requestFingerprint', 'providerIntentAt')`;
    const matches = Number(rows[0]?.matches ?? 0);
    const ok = matches === 2;
    if (ok) this.c1Positive = true;
    else this.lastNegativeAt = Date.now();
    return ok;
  }

  /** Sonde live de la table dédiée C3 (information_schema, lecture seule). */
  private async probeTable(): Promise<boolean> {
    if (this.tablePositive) return true;
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'OrderProvisioningTracking'
      ) AS "exists"`;
    const ok = !!rows[0]?.exists;
    if (ok) this.tablePositive = true;
    else this.lastNegativeAt = Date.now();
    return ok;
  }

  /**
   * Disponibilité de la table C3. Toute erreur DB est propagée (fail-closed :
   * jamais de classification legacy sur une sonde en échec).
   */
  async tableAvailable(): Promise<boolean> {
    return this.probeTable();
  }

  /** Disponibilité des colonnes C1. Toute erreur DB est propagée. */
  async c1ColumnsAvailable(): Promise<boolean> {
    return this.probeC1Columns();
  }

  /**
   * Capability complète du parcours C3 (C1 ∧ C3). Utilisée SOUS ON avant
   * toute écriture métier : `false` → 503 fail-closed.
   */
  async operational(): Promise<boolean> {
    const [c1, table] = await Promise.all([this.probeC1Columns(), this.probeTable()]);
    return c1 && table;
  }

  /**
   * Résolution du tracking d'une commande pour le ROUTAGE :
   *  - table absente (sonde LIVE, jamais un cache seul) → `null` (legacy sûr,
   *    invariant « aucune commande C3 sans table à sa création ») ;
   *  - table présente → lecture `OrderProvisioningTracking` ; `null` = commande
   *    sans tracking (ancien achat / produit non pack) ;
   *  - toute erreur DB (sonde OU lecture) → exception propagée (jamais legacy).
   */
  async resolveTracking(orderId: string): Promise<{ intent: unknown } | null> {
    const table = await this.probeTable();
    if (!table) return null;
    return this.prisma.orderProvisioningTracking.findUnique({
      where: { orderId },
      select: { intent: true },
    });
  }

  /** Diagnostique : âge du dernier résultat négatif (ms), JAMAIS un fondement. */
  negativeCacheAgeMs(now: number = Date.now()): number | null {
    return this.lastNegativeAt ? now - this.lastNegativeAt : null;
  }
}
