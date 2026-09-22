import { CoolifyEvidenceConnector } from './evidence-connectors/coolify-evidence.connector';
import { ProviderDeploymentObservation } from './deployment-evidence';

// 17B.4B — matrice COOLIFY exhaustive et déterministe (habitée UNIQUEMENT ici).
// Invariants : jamais de faux ACTIVE (exited*), jamais de faux TERMINAL suicidaire
// (running:crash → TERMINAL, exited avant crash), HTTP exigé quand la santé n'est
// pas prouvée, PROVIDER_SUFFICIENT réservé à running:healthy. NO_PROOF_AVAILABLE
// n'est jamais ACTIVE ni FAILED à lui seul.
describe('CoolifyEvidenceConnector — matrice de statuts', () => {
  const c = new CoolifyEvidenceConnector();

  it('identité provider : COOLIFY, canal de statut présent, résolution de l’identifiant opaque (resourceId)', () => {
    expect(c.providerKind).toBe('COOLIFY');
    expect(c.hasStatusChannel()).toBe(true);
    expect(c.resolveResourceId({ deploymentId: 'd-1', resourceId: 'app-abc', fqdn: null })).toBe('app-abc');
    expect(c.resolveResourceId({ deploymentId: 'd-1', resourceId: '', fqdn: null })).toBe(null);
  });

  // Normalisation insensible à la casse et aux espaces périphériques.
  it('casse/espaces normalisés (déterministe)', () => {
    expect(c.normalize('  RUNNING:HEALTHY  ')).toEqual(c.normalize('running:healthy'));
  });

  it('running:healthy → RUNNING/HEALTHY/PROVIDER_SUFFICIENT (preuve SANS HTTP)', () => {
    expect(c.normalize('running:healthy')).toEqual({
      lifecycle: 'RUNNING',
      health: 'HEALTHY',
      proofPolicy: 'PROVIDER_SUFFICIENT',
      detail: 'running:healthy',
    });
  });

  it('running seul et running:unknown → RUNNING/UNKNOWN/HTTP_REQUIRED', () => {
    for (const raw of ['running', 'running:unknown', 'running:starting']) {
      const obs = c.normalize(raw);
      expect(obs.lifecycle).toBe('RUNNING');
      expect(obs.health).toBe('UNKNOWN');
      expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    }
  });

  it('running:unhealthy → RUNNING/UNHEALTHY/HTTP_REQUIRED (peut servir quand même)', () => {
    expect(c.normalize('running:unhealthy')).toEqual(
      expect.objectContaining({
        lifecycle: 'RUNNING',
        health: 'UNHEALTHY',
        proofPolicy: 'HTTP_REQUIRED',
      }),
    );
  });

  it('transitions/build → TRANSITIONAL/NOT_APPLICABLE/NO_PROOF_AVAILABLE', () => {
    for (const raw of [
      'building',
      'building:healthy',
      'building:unhealthy',
      'starting',
      'starting:healthy',
      'queued',
      'in_progress',
      'processing',
      'pending',
      'deploying',
    ]) {
      const obs = c.normalize(raw);
      expect(obs).toEqual(
        expect.objectContaining({
          lifecycle: 'TRANSITIONAL',
          health: 'NOT_APPLICABLE',
          proofPolicy: 'NO_PROOF_AVAILABLE',
        }),
      );
    }
  });

  it('échecs fermes → TERMINAL (jamais ACTIVE), y compris running:crash', () => {
    for (const raw of ['failed', 'error', 'cancelled', 'canceled', 'crash', 'running:crash']) {
      const obs = c.normalize(raw);
      expect(obs.lifecycle).toBe('TERMINAL');
      expect(obs.proofPolicy).toBe('NO_PROOF_AVAILABLE');
      expect(obs.proofPolicy).not.toBe('PROVIDER_SUFFICIENT');
    }
  });

  it('exited* → TRANSITIONAL, JAMAIS TERMINAL ni ACTIVE (et vérifié AVANT le seuil crash)', () => {
    for (const raw of ['exited', 'exited:healthy', 'exited:0', 'exited:crash']) {
      const obs = c.normalize(raw);
      expect(obs.lifecycle).toBe('TRANSITIONAL');
      expect(obs.proofPolicy).toBe('NO_PROOF_AVAILABLE');
    }
  });

  it('statut inconnu/timeout/réseau → UNKNOWN/UNKNOWN/NO_PROOF_AVAILABLE (état conservé)', () => {
    for (const raw of ['unknown', 'timeout', 'network error', '???', '']) {
      const obs = c.normalize(raw);
      expect(obs).toEqual(
        expect.objectContaining({
          lifecycle: 'UNKNOWN',
          health: 'UNKNOWN',
          proofPolicy: 'NO_PROOF_AVAILABLE',
        }),
      );
    }
  });

  it('NO_PROOF_AVAILABLE n’est JAMAIS ACTIVE ni FAILED — toutes les observations du connecteur respectent la clause', () => {
    const raws = [
      'running:healthy',
      'running',
      'running:unhealthy',
      'building',
      'exited',
      'crash',
      'garbage',
    ];
    for (const raw of raws) {
      const obs: ProviderDeploymentObservation = c.normalize(raw);
      if (obs.proofPolicy === 'NO_PROOF_AVAILABLE') {
        expect(obs.httpServed).toBeUndefined();
      }
    }
    // Aucune observation du connecteur ne porte connectorProof (Coolify n'a pas
    // de preuve propre) : le moteur ne peut donc pas être abusé par un faux champ.
    for (const raw of raws) {
      expect(c.normalize(raw).connectorProof).toBeUndefined();
    }
    // La politique suffisante n'est déclarée QUE par running:healthy.
    const suffisantes = raws.filter((raw) => c.normalize(raw).proofPolicy === 'PROVIDER_SUFFICIENT');
    expect(suffisantes).toEqual(['running:healthy']);
  });
});