import { DeploymentModuleKind } from '@prisma/client';
import {
  buildLegacyClassificationReport,
  classifyLegacyProject,
  LegacyProjectFacts,
} from './legacy-classification';

/** Projets legacy figés : la classification est pure (aucune écriture, aucun provider). */
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
};

describe('classification legacy (17B.4F-B1)', () => {
  const base = { projectId: 'proj1', moduleKind: DeploymentModuleKind.PER_CLIENT_PROJECT };

  it('15. EXACT : ownership, pack et relations déterministes', () => {
    const facts = deepFreeze<LegacyProjectFacts>({
      ...base,
      userId: 'user1',
      deployments: [
        { id: 'dep1', userId: 'user1', orderId: 'orderB' },
        { id: 'dep2', userId: 'user1', orderId: 'orderB' },
      ],
    });
    const result = classifyLegacyProject(facts);
    expect(result).toEqual({
      projectId: 'proj1',
      kind: 'EXACT',
      reason: 'SINGLE_DETERMINISTIC_LINEAGE',
      candidateOrderIds: ['orderB'],
      proposedHostingServiceId: null,
      requiresAdministrativeResolution: false,
    });
  });

  it('16. LEGACY_SHARED : projet partagé selon l’ancien modèle', () => {
    // (a) plusieurs propriétaires dans le même projet (ancien modèle partagé)
    expect(
      classifyLegacyProject({
        ...base,
        userId: 'user1',
        deployments: [
          { id: 'dep1', userId: 'user1', orderId: 'order1' },
          { id: 'dep2', userId: 'user2', orderId: 'order1' },
        ],
      }),
    ).toMatchObject({ kind: 'LEGACY_SHARED', reason: 'SHARED_PROJECT_UNDER_LEGACY_MODEL', requiresAdministrativeResolution: true });
    // (b) ancien module A (projet partagé unique), propriétaire unique
    expect(
      classifyLegacyProject({
        projectId: 'proj2',
        userId: 'user1',
        moduleKind: DeploymentModuleKind.SHARED_PROJECT,
        deployments: [{ id: 'dep1', userId: 'user1', orderId: 'order1' }],
      }),
    ).toMatchObject({ kind: 'LEGACY_SHARED', reason: 'SHARED_PROJECT_UNDER_LEGACY_MODEL' });
  });

  it('17. AMBIGUOUS : plusieurs services possibles, ou ownership non prouvé', () => {
    // (a) deux commandes candidates → plusieurs services possibles
    expect(
      classifyLegacyProject({
        ...base,
        userId: 'user1',
        deployments: [
          { id: 'dep1', userId: 'user1', orderId: 'order1' },
          { id: 'dep2', userId: 'user1', orderId: 'order2' },
        ],
      }),
    ).toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'MULTIPLE_CANDIDATE_AUTHORITIES',
      candidateOrderIds: ['order1', 'order2'],
      proposedHostingServiceId: null,
      requiresAdministrativeResolution: true,
    });
    // (b) propriétaire du projet ≠ propriétaire des déploiements
    expect(
      classifyLegacyProject({
        ...base,
        userId: 'user9',
        deployments: [{ id: 'dep1', userId: 'user1', orderId: 'order1' }],
      }),
    ).toMatchObject({ kind: 'AMBIGUOUS', reason: 'OWNERSHIP_MISMATCH', proposedHostingServiceId: null });
  });

  it('18. ORPHAN : aucune autorité métier prouvée', () => {
    // (a) déploiements sans aucune commande
    expect(
      classifyLegacyProject({
        ...base,
        userId: 'user1',
        deployments: [{ id: 'dep1', userId: 'user1', orderId: null }],
      }),
    ).toMatchObject({ kind: 'ORPHAN', reason: 'NO_BUSINESS_AUTHORITY', requiresAdministrativeResolution: true });
    // (b) projet sans déploiement
    expect(
      classifyLegacyProject({ ...base, userId: 'user1', deployments: [] }),
    ).toMatchObject({ kind: 'ORPHAN', reason: 'NO_BUSINESS_AUTHORITY', candidateOrderIds: [] });
  });

  it('n’écrit rien et ne propose jamais de relation forcée (input gelé)', () => {
    const projects = deepFreeze<LegacyProjectFacts[]>([
      { ...base, userId: 'user1', deployments: [{ id: 'dep1', userId: 'user1', orderId: 'order1' }] },
      { projectId: 'proj2', userId: 'user1', moduleKind: null, deployments: [{ id: 'dep2', userId: 'user1', orderId: null }] },
      { projectId: 'proj3', userId: 'user1', moduleKind: null, deployments: [{ id: 'dep3', userId: 'user1', orderId: 'o1' }, { id: 'dep4', userId: 'user1', orderId: 'o2' }] },
    ]);
    const snapshot = JSON.stringify(projects);
    const report = buildLegacyClassificationReport(projects);
    expect(JSON.stringify(projects)).toBe(snapshot); // aucune mutation
    expect(report.counts).toEqual({ EXACT: 1, LEGACY_SHARED: 0, AMBIGUOUS: 1, ORPHAN: 1 });
    expect(report.requiresAdministrativeResolution).toBe(2);
    expect(report.projects.every((entry) => entry.proposedHostingServiceId === null)).toBe(true);
    // déterminisme : mêmes faits → même rapport
    expect(buildLegacyClassificationReport(projects)).toEqual(report);
  });

  it('trie et déduplique les commandes candidates', () => {
    const result = classifyLegacyProject({
      projectId: 'projX',
      userId: 'user1',
      moduleKind: null,
      deployments: [
        { id: 'd1', userId: 'user1', orderId: 'orderZ' },
        { id: 'd2', userId: 'user1', orderId: 'orderZ' },
        { id: 'd3', userId: 'user1', orderId: 'orderA' },
        { id: 'd4', userId: 'user1', orderId: null },
      ],
    });
    expect(result.kind).toBe('AMBIGUOUS');
    expect(result.candidateOrderIds).toEqual(['orderA', 'orderZ']);
  });
});
