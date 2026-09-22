import { Injectable } from '@nestjs/common';
import {
  DeploymentEvidenceConnector,
  ProviderDeploymentContext,
  ProviderDeploymentObservation,
  ProviderRawStatus,
} from '../deployment-evidence';

/**
 * 17B.4B — connecteur d'évidence COOLIFY.
 *
 * SEUL ENDROIT où le vocabulaire Coolify (statuts bruts, uuid d'app) existe
 * dans le chemin du réconciliateur. Le ReconcileService et la couche évidence
 * restent génériques : c'est CE connecteur qui tranche un statut brut en
 * observation (matrice exhaustive, déterministe, sans faux ACTIVE/FAILED).
 *
 * Matrice (ordres STRICTS, validés en tests) :
 *  1. `exited*` (avec ou sans suffixe santé) → TRANSITIONAL : un conteneur
 *     arrêté ne prouve NI la mise en ligne NI un échec ferme (reset possible
 *     vers running). Vérifié AVANT la famille terminale (`running:crash` n'est
 *     jamais ACTIVE : Crash → TERMINAL).
 *  2. `failed`, `error`, `cancelled`, `canceled`, `crash` (y compris en suffixe,
 *     ex. `running:crash`) → TERMINAL — un échec ferme, jamais ACTIVE.
 *  3. `running:healthy` → RUNNING/HEALTHY/PROVIDER_SUFFICIENT : preuve de mise
 *     en ligne SANS appel HTTP (le statut suffit).
 *  4. `running` seul, `running:unknown`, `running:<autre>` → RUNNING/UNKNOWN/
 *     HTTP_REQUIRED : porteur mais à confirmer par une preuve HTTP 2xx/3xx.
 *  5. `running:unhealthy` → RUNNING/UNHEALTHY/HTTP_REQUIRED : un container
 *     vivant mais malsain peut quand même servir → preuve HTTP exigée.
 *  6. `building*`, `starting*`, `queued`, `in_progress`, `processing`,
 *     `pending`, `deploying` → TRANSITIONAL (build/transition), aucune preuve.
 *  7. tout le reste (status inconnu, timeout, erreur réseau, illisible) →
 *     UNKNOWN — le moteur conserve l'état courant (ni ACTIVE, ni FAILED).
 *
 * NO_PROOF_AVAILABLE n'est JAMAIS ACTIVE ni FAILED à lui seul ; RESTE dans les
 * mains du moteur. `providerKind` = valeur de Server.panelProvider desservie.
 */
@Injectable()
export class CoolifyEvidenceConnector implements DeploymentEvidenceConnector {
  readonly providerKind = 'COOLIFY';

  resolveResourceId(context: ProviderDeploymentContext): string | null {
    return context.resourceId || null;
  }

  hasStatusChannel(): boolean {
    return true;
  }

  normalize(raw: ProviderRawStatus): ProviderDeploymentObservation {
    const s = raw.trim().toLowerCase();

    // 1) exited* d'abord — jamais ACTIVE ni TERMINAL (reset possible vers run).
    if (s.includes('exited')) {
      return this.transitional('conteneur arrêté (exited) — en ré-attente');
    }

    // 2) Famille terminale ferme : TOKEN EXACT, ou suffixe d'un `running:`.
    //    (`network error`, `timeout`, `???'` ne sont PAS des statuts fermes — ils
    //    retombent en UNKNOWN ; un `error`/`failed`/`crash` isolé ou `running:crash`
    //    est un échec ferme, jamais ACTIVE).
    const TERMINAL_TOKENS = ['failed', 'error', 'cancelled', 'canceled', 'crash'];
    const sWithoutPrefix = s.startsWith('running:') ? s.slice('running:'.length) : '';
    if (TERMINAL_TOKENS.includes(s) || TERMINAL_TOKENS.includes(sWithoutPrefix)) {
      return {
        lifecycle: 'TERMINAL',
        health: 'NOT_APPLICABLE',
        proofPolicy: 'NO_PROOF_AVAILABLE',
        detail: 'échec ferme côté provider (failed/error/cancelled/crash)',
      };
    }

    // 3) running:healthy → preuve suffisante sans HTTP.
    if (s === 'running:healthy') {
      return {
        lifecycle: 'RUNNING',
        health: 'HEALTHY',
        proofPolicy: 'PROVIDER_SUFFICIENT',
        detail: 'running:healthy',
      };
    }

    // 4/5) running (seul/inconnu/autre suffixe) et running:unhealthy.
    if (s.startsWith('running')) {
      const health = s === 'running:unhealthy' ? 'UNHEALTHY' : 'UNKNOWN';
      return {
        lifecycle: 'RUNNING',
        health,
        proofPolicy: 'HTTP_REQUIRED',
        detail: s,
      };
    }

    // 6) Transitions de build/déploiement — aucune preuve exploitable.
    if (
      ['building', 'starting', 'queued', 'in_progress', 'processing', 'pending', 'deploying'].some(
        (x) => s.startsWith(x),
      )
    ) {
      return this.transitional('build/transition en cours');
    }

    // 7) Inconnu — conserve l'état courant.
    return this.unknown('statut provider illisible ou inconnu');
  }

  private transitional(detail: string): ProviderDeploymentObservation {
    return {
      lifecycle: 'TRANSITIONAL',
      health: 'NOT_APPLICABLE',
      proofPolicy: 'NO_PROOF_AVAILABLE',
      detail,
    };
  }

  private unknown(detail: string): ProviderDeploymentObservation {
    return {
      lifecycle: 'UNKNOWN',
      health: 'UNKNOWN',
      proofPolicy: 'NO_PROOF_AVAILABLE',
      detail,
    };
  }
}