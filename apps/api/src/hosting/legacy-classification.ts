import { DeploymentModuleKind } from '@prisma/client';

/**
 * Phase 17B.4F-B1 — CLASSIFICATION des données legacy (PLAN / RAPPORT UNIQUEMENT).
 *
 * Mécanisme PUR : aucun accès base, aucune écriture, aucun appel provider, aucun
 * backfill exécuté. Le rapport sert à décider, en 17B.4F-D, quelles lignes
 * historiques (ClientProject / Deployment) peuvent être rattachées à quel
 * `HostingService` — après résolution administrative des cas non-exacts.
 *
 * Classes :
 *  - EXACT           : ownership, pack et relations déterministes → un seul
 *                      service possible, rattachement prévu en 17B.4F-D.
 *  - LEGACY_SHARED   : projet partagé selon l'ancien modèle (ancien module
 *                      partagé ou plusieurs propriétaires dans le même projet).
 *  - AMBIGUOUS       : plusieurs services possibles, ou ownership non prouvé →
 *                      AUCUNE relation forcée, résolution administrative.
 *  - ORPHAN          : aucune autorité métier (commande) ne peut être prouvée →
 *                      AUCUNE relation forcée, résolution administrative.
 *
 * Règles (ordre déterministe) :
 *  1. aucune commande candidate            → ORPHAN
 *  2. plusieurs commandes candidates       → AMBIGUOUS
 *  3. projet partagé (multi-propriétaire ou ancien module partagé) → LEGACY_SHARED
 *  4. propriétaire du projet ≠ propriétaire des déploiements → AMBIGUOUS
 *  5. sinon                               → EXACT
 */

export type LegacyClassificationKind = 'EXACT' | 'LEGACY_SHARED' | 'AMBIGUOUS' | 'ORPHAN';

export type LegacyClassificationReason =
  | 'SINGLE_DETERMINISTIC_LINEAGE'
  | 'SHARED_PROJECT_UNDER_LEGACY_MODEL'
  | 'MULTIPLE_CANDIDATE_AUTHORITIES'
  | 'OWNERSHIP_MISMATCH'
  | 'NO_BUSINESS_AUTHORITY';

/** Faits bruts lus par l'appelant (aucune donnée provider ici : pas d'UUID panneau). */
export interface LegacyProjectFacts {
  projectId: string;
  /** Propriétaire de la ligne ClientProject. */
  userId: string;
  /** Ancien module du projet (null = inconnu / legacy antérieur). */
  moduleKind: DeploymentModuleKind | null;
  deployments: Array<{
    id: string;
    userId: string;
    /** Autorité métier : la commande qui a livré l'app (null = legacy sans commande). */
    orderId: string | null;
  }>;
}

export interface LegacyClassification {
  projectId: string;
  kind: LegacyClassificationKind;
  reason: LegacyClassificationReason;
  /** Commandes candidates, dédupliquées et triées (déterminisme). */
  candidateOrderIds: string[];
  /** B1 : JAMAIS de relation forcée — toujours null, résolution = 17B.4F-D. */
  proposedHostingServiceId: null;
  requiresAdministrativeResolution: boolean;
}

export interface LegacyClassificationReport {
  projects: LegacyClassification[];
  counts: Record<LegacyClassificationKind, number>;
  requiresAdministrativeResolution: number;
}

const EMPTY_COUNTS = (): Record<LegacyClassificationKind, number> => ({
  EXACT: 0,
  LEGACY_SHARED: 0,
  AMBIGUOUS: 0,
  ORPHAN: 0,
});

/**
 * Classification pure d'un projet legacy. Ne MUTATE PAS ses entrées et ne
 * produit AUCUN effet de bord (testable par gel profond de l'input).
 */
export function classifyLegacyProject(facts: LegacyProjectFacts): LegacyClassification {
  const candidateOrderIds = [
    ...new Set(
      facts.deployments
        .map((deployment) => deployment.orderId)
        .filter((orderId): orderId is string => orderId !== null),
    ),
  ].sort();
  const owners = [...new Set(facts.deployments.map((deployment) => deployment.userId))];

  let kind: LegacyClassificationKind;
  let reason: LegacyClassificationReason;

  if (candidateOrderIds.length === 0) {
    kind = 'ORPHAN';
    reason = 'NO_BUSINESS_AUTHORITY';
  } else if (candidateOrderIds.length > 1) {
    kind = 'AMBIGUOUS';
    reason = 'MULTIPLE_CANDIDATE_AUTHORITIES';
  } else if (owners.length > 1 || facts.moduleKind === DeploymentModuleKind.SHARED_PROJECT) {
    kind = 'LEGACY_SHARED';
    reason = 'SHARED_PROJECT_UNDER_LEGACY_MODEL';
  } else if (owners.length === 0 || owners[0] !== facts.userId) {
    kind = 'AMBIGUOUS';
    reason = 'OWNERSHIP_MISMATCH';
  } else {
    kind = 'EXACT';
    reason = 'SINGLE_DETERMINISTIC_LINEAGE';
  }

  return {
    projectId: facts.projectId,
    kind,
    reason,
    candidateOrderIds,
    proposedHostingServiceId: null,
    requiresAdministrativeResolution: kind !== 'EXACT',
  };
}

/** Rapport de classification sur un ensemble de projets legacy (aucune écriture). */
export function buildLegacyClassificationReport(
  projects: LegacyProjectFacts[],
): LegacyClassificationReport {
  const classified = projects.map(classifyLegacyProject);
  const counts = EMPTY_COUNTS();
  for (const entry of classified) counts[entry.kind] += 1;
  return {
    projects: classified,
    counts,
    requiresAdministrativeResolution: classified.filter(
      (entry) => entry.requiresAdministrativeResolution,
    ).length,
  };
}
