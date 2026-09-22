import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { HttpAvailabilityService } from '../common/http-availability.service';
import { PanelKind, PanelTarget, PanelTransportFactory } from '../servers/panel-transport.factory';
import {
  DEPLOYMENT_EVIDENCE_CONNECTORS,
  DeploymentEvidenceConnector,
  ProviderDeploymentContext,
  ProviderDeploymentObservation,
  unknownObservation,
} from './deployment-evidence';

/**
 * 17B.4B — COUCHE ÉVIDENCE : seule orchestratrice des preuves de mise en ligne,
 * agnostique provider. APPORTE l'observation d'un Deployment au ReconcileService
 * (générique). Le vocabulaire du panel (Coolify et les autres à venir) reste
 * cantonné aux connecteurs du registre — jamais dans le moteur.
 *
 * Règles (rapports 17B.4A/B, testées) :
 *  - jamais de mutation externe : transport utilisé EN LECTURE SEULE
 *    (deploymentStatus) ; HTTP uniquement pour une politique HTTP_REQUIRED ;
 *  - preuves connecteur UNIQUEMENT pour une politique CONNECTOR_REQUIRED ;
 *  - un provider indisponible/injoignable/illisible → observation UNKNOWN
 *    (le moteur conserve l'état courant, replanifie, compteur terminal inchangé) ;
 *  - s'IL N'EXISTE AUCUN CANAL DE STATUT (pas de serveur, provider inconnu,
 *    pas de connecteur, canal sans statut, app sans uuid) : une preuve HTTP sur
 *    le fqdn devient la SEULE preuve possible (RUNNING/HTTP_REQUIRED), sinon
 *    observation UNKNOWN — jamais une décision inventée.
 */
@Injectable()
export class DeploymentEvidenceService {
  private readonly log = new Logger(DeploymentEvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly panelFactory: PanelTransportFactory,
    private readonly crypto: CryptoService,
    private readonly httpAvailability: HttpAvailabilityService,
    @Inject(DEPLOYMENT_EVIDENCE_CONNECTORS)
    private readonly connectors: DeploymentEvidenceConnector[],
  ) {}

  /**
   * UNIQUE point d'entrée du moteur : observe par IDENTIFIANT. La couche
   * évidence recharge elle-même la row Deployment (serverId, fqdn, resourceId)
   * et est la SEULE à connaître ces champs provider — ReconcileService ne les
   * lit jamais. Un futur renommage interne (resourceId…) ne touchera donc que
   * CE fichier et le registre des connecteurs.
   */
  async observe(deploymentId: string): Promise<ProviderDeploymentObservation> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, coolifyUuid: true, fqdn: true, serverId: true },
    });
    if (!deployment) {
      return unknownObservation('déploiement introuvable');
    }

    const connector = await this.resolveConnector(deployment.serverId);
    if (!connector || !connector.hasStatusChannel()) {
      return this.httpOnlyObservation(deployment);
    }

    // SEUL point d'adaptation de frontière : cette couche est la SEULE à lire
    // la colonne historique `coolifyUuid` et à la convertir en identifiant
    // OPACQUE `resourceId`. La colonne ne dépasse JAMAIS ce fichier.
    const resourceId = deployment.coolifyUuid;
    if (!resourceId) {
      // App inexistante côté provider (définitionnellement injoignable) :
      // sans resourceId aucun statut à lire — seule la preuve HTTP reste possible.
      return this.httpOnlyObservation(deployment);
    }
    const context: ProviderDeploymentContext = {
      deploymentId: deployment.id,
      resourceId,
      fqdn: deployment.fqdn,
    };
    if (!connector.resolveResourceId(context)) {
      // Identifiant jugé invalide/absent par le connecteur → quel app lire ?
      // Aucun statut à interroger : seule la preuve HTTP reste possible.
      return this.httpOnlyObservation(deployment);
    }

    const target = await this.buildTarget(deployment.serverId);
    if (!target) {
      return this.httpOnlyObservation(deployment);
    }

    let raw: { rawStatus: string; detail?: string };
    try {
      raw = await this.panelFactory.create().deploymentStatus(target, context.resourceId);
    } catch (e) {
      this.log.warn(`evidence: statut panel injoignable deployment=${deployment.id}: ${String(e)}`);
      return unknownObservation('statut panel injoignable');
    }

    let observation = connector.normalize(raw.rawStatus);
    if (observation.proofPolicy === 'HTTP_REQUIRED') {
      observation = await this.applyHttpProof(deployment, observation);
    } else if (observation.proofPolicy === 'CONNECTOR_REQUIRED' && connector.prove) {
      observation = await this.applyConnectorProof(context, observation, connector);
    }
    return observation;
  }

  /** Connecteur du provider de `serverId`, ou null (serveur absent/inconnu). */
  private async resolveConnector(serverId: string | null): Promise<DeploymentEvidenceConnector | null> {
    if (!serverId) return null;
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { panelProvider: true },
    });
    if (!server) return null;
    const provider = String(server.panelProvider);
    if (!provider || provider === 'NONE') return null;
    return this.connectors.find((c) => c.providerKind === provider) ?? null;
  }

  /** Aucun canal de statut exploitable → HTTP seul (si fqdn), sinon UNKNOWN. */
  private async httpOnlyObservation(deployment: {
    id: string;
    fqdn: string | null;
  }): Promise<ProviderDeploymentObservation> {
    if (!deployment.fqdn) {
      return unknownObservation('aucun canal de preuve (statut ni fqdn)');
    }
    const served = await this.httpAvailability.isServed(deployment.fqdn);
    return {
      lifecycle: 'RUNNING',
      health: 'UNKNOWN',
      proofPolicy: 'HTTP_REQUIRED',
      httpServed: served,
      detail: served ? 'prouvé par HTTP (2xx/3xx)' : 'non prouvé par HTTP',
    };
  }

  private async applyHttpProof(
    deployment: { id: string; fqdn: string | null },
    observation: ProviderDeploymentObservation,
  ): Promise<ProviderDeploymentObservation> {
    if (!deployment.fqdn) return observation;
    const served = await this.httpAvailability.isServed(deployment.fqdn);
    return {
      ...observation,
      httpServed: served,
      detail: served ? 'prouvé par HTTP (2xx/3xx)' : 'non prouvé par HTTP',
    };
  }

  private async applyConnectorProof(
    context: ProviderDeploymentContext,
    observation: ProviderDeploymentObservation,
    connector: DeploymentEvidenceConnector,
  ): Promise<ProviderDeploymentObservation> {
    try {
      const result = await connector.prove!({
        deployment: context,
        observation,
      });
      return {
        ...observation,
        connectorProof: { label: 'preuve connecteur', ...result },
      };
    } catch (e) {
      this.log.warn(`evidence: preuve connecteur échouée deployment=${context.deploymentId}: ${String(e)}`);
      return observation;
    }
  }

  /** Cible panel (buildTarget local) : décrypte apiTokenEnc À LA VOLÉE, jamais exposé. */
  private async buildTarget(serverId: string | null): Promise<PanelTarget | null> {
    if (!serverId) return null;
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: {
        panelProvider: true,
        apiBaseUrl: true,
        apiTokenEnc: true,
        strictTls: true,
      },
    });
    if (!server || !server.apiBaseUrl || !server.apiTokenEnc) return null;
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc);
    } catch {
      this.log.warn(`evidence: jeton API du serveur ${serverId} indéchiffrable (ENCRYPTION_KEY ?)`);
      return null;
    }
    return {
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl,
      token,
      user: null,
      strictTls: server.strictTls,
    };
  }
}