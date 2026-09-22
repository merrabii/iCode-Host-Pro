import type { InjectionToken } from '@nestjs/common';

/**
 * 17B.4B — contrat d'OBSERVATION des déploiements, agnostique provider.
 *
 * C'est la SEULE passerelle entre le ReconcileService (générique, aucune
 * connaissance du panel) et les panels réels (Coolify aujourd'hui, d'autres
 * demain). Le vocabulaire provider (UUID, noms de statuts, endpoints) ne vit
 * QUE dans les connecteurs d'évidence, jamais dans le moteur.
 *
 * Module de types PUR (aucune logique métier), importable de partout sans
 * effet de bord. Les valeurs sont des unions closes : le moteur raisonne par
 * exhaustivité (switch) et les tests vérifient le mapping table par table.
 */

/** Cycle de vie d'un déploiement, tranché depuis le statut brut du provider. */
export type ProviderLifecycle = 'RUNNING' | 'TRANSITIONAL' | 'TERMINAL' | 'UNKNOWN';

/** Santé annoncée par le provider (quand il en expose une). */
export type ProviderHealth = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' | 'NOT_APPLICABLE';

/**
 * Politique de preuve de mise en ligne :
 *  - PROVIDER_SUFFICIENT : le statut du provider prouve à lui seul la mise en
 *    ligne (ex. running:healthy) → AUCUN appel HTTP ;
 *  - HTTP_REQUIRED : le statut est porteur mais ne suffit pas (ex. running
 *    sans santé, running:unhealthy) → une preuve HTTP 2xx/3xx est exigée ;
 *  - CONNECTOR_REQUIRED : le provider expose une preuve propre (endpoint de
 *    santé) → `prove()` du connecteur est appelée ;
 *  - NO_PROOF_AVAILABLE : aucune preuve exploitable (transition, terminé,
 *    inconnu, greenfield sans fqdn) → jamais ACTIVE, jamais FAILED à ce titre.
 */
export type AvailabilityProofPolicy =
  | 'PROVIDER_SUFFICIENT'
  | 'HTTP_REQUIRED'
  | 'CONNECTOR_REQUIRED'
  | 'NO_PROOF_AVAILABLE';

/** Statut brut OCDÉE par un provider — opaque pour le moteur. */
export type ProviderRawStatus = string;

/**
 * Observation d'un déploiement : décision pure du connecteur, consommée par le
 * moteur. `httpServed` n'est jamais décidé ici (la couche évidence l'appelle) ;
 * `connectorProof` porte le résultat d'une preuve CONNECTOR_REQUIRED.
 */
export interface ProviderDeploymentObservation {
  lifecycle: ProviderLifecycle;
  health: ProviderHealth;
  proofPolicy: AvailabilityProofPolicy;
  /** Renseigné uniquement quand proofPolicy = HTTP_REQUIRED (résultat de la
   *  vérification HTTP de la couche évidence). */
  httpServed?: boolean;
  /** Renseigné uniquement quand proofPolicy = CONNECTOR_REQUIRED. */
  connectorProof?: { label: string; satisfied: boolean };
  /** Détail libre (diagnostic, path safe — jamais de secret). */
  detail?: string;
}

/** Contexte OPACQUE d'un déploiement transmis aux connecteurs d'évidence.
 *  Construit EXCLUSIVEMENT par la couche évidence (l'adaptateur) : le moteur
 *  n'en voit jamais, et aucun vocabulaire provider (uuid, url, jeton) n'apparaît
 *  ici. `resourceId` est l'identifiant générique de l'app côté provider ;
 *  un fournisseur ne connaît rien d'autre de la row Deployment. */
export interface ProviderDeploymentContext {
  deploymentId: string;
  resourceId: string;
  fqdn?: string | null;
}

/** Entrée d'une preuve propre au provider (CONNECTOR_REQUIRED). */
export interface ConnectorProofInput {
  deployment: ProviderDeploymentContext;
  observation: ProviderDeploymentObservation;
}

/** Résultat d'une preuve propre au provider. */
export interface ConnectorProofResult {
  satisfied: boolean;
  detail?: string;
}

/**
 * Connecteur d'évidence d'un provider de panel. Une implémentation par provider,
 * enregistrée dans le registre DI `DEPLOYMENT_EVIDENCE_CONNECTORS`.
 *  - `providerKind` : valeur de `Server.panelProvider` que le connecteur sert
 *    (ex. 'COOLIFY'). SANS correspondance → aucune observation (lifecycle UNKNOWN).
 *  - `resolveResourceId` : valide/résout l'identifiant OPACQUE déjà fourni dans
 *    le contexte par la couche évidence (`resourceId`), ou null s'il est absent.
 *  - `hasStatusChannel` : true si le provider expose un statut de build.
 *  - `normalize` : tranche un statut brut en observation (matrice exhaustive).
 *  - `prove?` : preuve propre au provider (endpoint de santé), appelée UNIQUEMENT
 *    quand proofPolicy = CONNECTOR_REQUIRED. Un connecteur sans preuve propre ne
 *    déclare JAMAIS CONNECTOR_REQUIRED dans normalize.
 */
export interface DeploymentEvidenceConnector {
  providerKind: string;
  resolveResourceId(context: ProviderDeploymentContext): string | null;
  hasStatusChannel(): boolean;
  normalize(raw: ProviderRawStatus): ProviderDeploymentObservation;
  prove?(input: ConnectorProofInput): Promise<ConnectorProofResult>;
}

/** Registre DI des connecteurs d'évidence (injecté en tableau multi-provider). */
export const DEPLOYMENT_EVIDENCE_CONNECTORS: InjectionToken<DeploymentEvidenceConnector[]> = Symbol(
  'DEPLOYMENT_EVIDENCE_CONNECTORS',
);

/** Observation de repli quand AUCUNE preuve n'est disponible (injoignable,
 *  illisible, aucun canal de statut). Jamais ACTIVE, jamais FAILED à ce titre,
 *  jamais une décision inventée : le moteur conserve l'état courant. */
export function unknownObservation(detail?: string): ProviderDeploymentObservation {
  return {
    lifecycle: 'UNKNOWN',
    health: 'UNKNOWN',
    proofPolicy: 'NO_PROOF_AVAILABLE',
    detail,
  };
}