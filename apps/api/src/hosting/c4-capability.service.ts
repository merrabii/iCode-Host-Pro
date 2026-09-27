import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isHostingC4Enabled } from './c4-flag';

/**
 * 17B.4F-C4 — capability du protocole C4 (prérequis vérifiés LIVE).
 *
 * Contrat (GO 17B.4F-C4) :
 *  - Sous `HOSTING_C4_ENABLED === 'true'`, la capability vérifie LES 5 tables
 *    dédiées (`C4ProviderAttempt`, `C4Takeover`, `C4StopRequest`,
 *    `C4ReleaseEvidence`, `C4ReadinessProof`) ET leurs contraintes (index
 *    uniques, dont l'index unique PARTIEL créatif
 *    `C4ProviderAttempt_open_creative_key`) AVANT toute mutation ; toute
 *    lacune ⇒ refus 503 avant mutation (aucun demi-protocole).
 *  - `assertOperational()` est le point d'entrée unique : no-op sous OFF,
 *    503 sous ON si le schéma est incomplet. Jamais de fallback silencieux.
 *  - Cache POSITIF sticky (process) : une migration est additive et
 *    irréversible en run — la présence confirmée n'est jamais revérifiée.
 *    Le cache négatif n'est JAMAIS un fondement : sous ON, toute sonde
 *    échouante ou négative impose le refus (fail-closed).
 *  - Erreur DB pendant une sonde → l'exception est propagée (jamais de faux
 *    OFF silencieux). Aucune écriture, aucun secret (metadata seul).
 */
@Injectable()
export class C4CapabilityService {
  /** Présence des 5 tables + contraintes confirmée (sticky, jamais revérifiée). */
  private positive = false;
  /** Dernière négativité observée — diagnostique JAMAIS utilisée comme fondement. */
  private lastNegativeAt = 0;

  private static readonly TABLES = [
    'C4ProviderAttempt',
    'C4Takeover',
    'C4StopRequest',
    'C4ReleaseEvidence',
    'C4ReadinessProof',
  ];

  constructor(private readonly prisma: PrismaService) {}

  /** Sonde live des 5 tables C4 (information_schema, lecture seule). */
  private async probeTables(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ matches: bigint }>>`
      SELECT COUNT(*)::bigint AS "matches"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('C4ProviderAttempt', 'C4Takeover', 'C4StopRequest', 'C4ReleaseEvidence', 'C4ReadinessProof')`;
    return Number(rows[0]?.matches ?? 0) === 5;
  }

  /** Sonde live des contraintes C4 : uniques + l'index unique partiel créatif. */
  private async probeConstraints(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ matches: bigint }>>`
      SELECT COUNT(*)::bigint AS "matches"
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'C4Takeover_scopeType_scopeId_key',
          'C4StopRequest_scopeType_scopeId_key',
          'C4ReleaseEvidence_allocationId_key',
          'C4ReadinessProof_orderId_key',
          'C4ProviderAttempt_open_creative_key'
        )`;
    return Number(rows[0]?.matches ?? 0) === 5;
  }

  /**
   * Capability complète C4 (5 tables ∧ contraintes). Utilisée SOUS ON avant
   * toute mutation : `false` → 503 fail-closed.
   */
  async operational(): Promise<boolean> {
    if (this.positive) return true;
    const [tables, constraints] = await Promise.all([this.probeTables(), this.probeConstraints()]);
    const ok = tables && constraints;
    if (ok) this.positive = true;
    else this.lastNegativeAt = Date.now();
    return ok;
  }

  /**
   * Point d'entrée unique des intégrations : no-op sous OFF ; sous ON, sonde
   * LIVE et 503 avant toute mutation si le schéma C4 est absent/incomplet.
   */
  async assertOperational(): Promise<void> {
    if (!isHostingC4Enabled()) return;
    if (!(await this.operational())) {
      throw new ServiceUnavailableException(
        'Protocole C4 activé mais schéma indisponible (migration C4 requise).',
      );
    }
  }

  /** Diagnostique : âge du dernier résultat négatif (ms), JAMAIS un fondement. */
  negativeCacheAgeMs(now: number = Date.now()): number | null {
    return this.lastNegativeAt ? now - this.lastNegativeAt : null;
  }
}
