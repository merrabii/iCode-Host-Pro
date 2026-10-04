import { Injectable, Logger } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { HostingServiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { C4ProtocolService } from '../hosting/c4-protocol.service';
import { isHostingC4Enabled } from '../hosting/c4-flag';
import {
  PanelKind,
  PanelTarget,
  PanelTransportFactory,
} from '../servers/panel-transport.factory';

/**
 * Q5 (GO item 5) — CAS des HostingService DANS LA TRANSACTION du caller :
 * les services hébergement basculent avec l'abonnement qu'ils portent (jamais
 * ceux d'un autre abonnement du même client). Probe schéma préalable : base
 * pré-C1 sans table `HostingService` → skip silencieux (compat), jamais
 * d'erreur. Utilisé par la suspension automatique (RenewalService) ET par les
 * transitions admin (SubscriptionsService) pour que statut abonnement et statut
 * service ne divergent JAMAIS.
 */
export async function applyHostingStatusInTx(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  from: HostingServiceStatus,
  to: HostingServiceStatus,
): Promise<number> {
  const tables = await tx.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'HostingService'
    ) AS "exists"`;
  if (!tables[0]?.exists) return 0;
  const cas = await tx.hostingService.updateMany({
    where: { subscriptionId, status: from },
    data: { status: to },
  });
  return cas.count;
}

/**
 * Q5 (GO item 5 + GO commercial « suspension ») — effets provider de la
 * suspension ET de la réactivation d'une souscription.
 *
 * Contrats GO :
 *  - **Arrêt RÉVERSIBLE** des applications concernées via le protocole de
 *    transport existant (`PanelTransport.stopApplication`) — **aucune
 *    suppression de ressources ni de données** (jamais `deleteApplication`) ;
 *  - **Réactivation contrôlée** = relance (`startApplication`), sans double
 *    facturation (aucune écriture de facture ici) ;
 *  - **Respect du protocole C4** : sous `HOSTING_C4_ENABLED=true`, chaque
 *    dispatch est une tentative durable `CONFIGURE` (`beginDispatch` refuse si
 *    un arrêt/C4 est opposable, la consignation `settle` trace l'issue) ;
 *    sous OFF : appel direct + catch best-effort (contrat historique) ;
 *  - **Capacité provider manquante** (panneau non Coolify, jeton illisible…) →
 *    blocage EXPLICITE comptabilisé (`blocked`) + audit, jamais de faux succès ;
 *  - **Échecs visibles et récupérables** : chaque échec/blocage est audité
 *    (`suspension.app_*`), le recompte est renvoyé à l'appelant (admin), et une
 *    nouvelle action (suspendre/réactiver à nouveau) rejoue l'effet ;
 *  - Jamais d'appel réseau dans la transaction métier (post-commit uniquement).
 */

export interface SuspensionEffectsSummary {
  /** Applications concernées (avec cible provider connue). */
  apps: number;
  /** Arrêts/relances réellement confirmés par le panneau. */
  done: number;
  /** Bloqués explicitement (capacité absente, arrêt/C4 opposable, sans cible). */
  blocked: number;
  /** Échecs visibles (réseau/HTTP) — récupérables par une nouvelle action. */
  failed: number;
}

const EMPTY: SuspensionEffectsSummary = { apps: 0, done: 0, blocked: 0, failed: 0 };

type Op = 'stop' | 'start';

@Injectable()
export class SuspensionEffectsService {
  private readonly log = new Logger(SuspensionEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly panelFactory: PanelTransportFactory,
    private readonly c4: C4ProtocolService,
  ) {}

  /** Arrêt réversible des apps de la souscription (après CAS de suspension). */
  suspendApps(params: {
    subscriptionId: string;
    holder: string;
    orderId?: string | null;
  }): Promise<SuspensionEffectsSummary> {
    return this.run('stop', params);
  }

  /** Relance des apps de la souscription (après CAS de réactivation). */
  resumeApps(params: {
    subscriptionId: string;
    holder: string;
    orderId?: string | null;
  }): Promise<SuspensionEffectsSummary> {
    return this.run('start', params);
  }

  // ──────────────────────────── moteur ──────────────────────────────────────

  private async run(
    op: Op,
    params: { subscriptionId: string; holder: string; orderId?: string | null },
  ): Promise<SuspensionEffectsSummary> {
    const services = await this.prisma.hostingService.findMany({
      where: { subscriptionId: params.subscriptionId },
      select: { id: true, orderId: true },
    });
    if (services.length === 0) return { ...EMPTY };
    const serviceIds = services.map((s) => s.id);
    const orderIds = [
      ...new Set(
        [...services.map((s) => s.orderId), params.orderId ?? null].filter(
          (v): v is string => !!v,
        ),
      ),
    ];
    const deps = await this.prisma.deployment.findMany({
      where: {
        coolifyUuid: { not: null },
        OR: [
          { hostingServiceId: { in: serviceIds } },
          ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ],
      },
      select: {
        id: true,
        orderId: true,
        coolifyUuid: true,
        server: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const summary: SuspensionEffectsSummary = { apps: deps.length, done: 0, blocked: 0, failed: 0 };
    for (const dep of deps) {
      const outcome = await this.dispatchOne(op, {
        deploymentId: dep.id,
        orderId: dep.orderId ?? params.orderId ?? null,
        uuid: dep.coolifyUuid!,
        server: dep.server,
        holder: params.holder,
      });
      if (outcome === 'done') summary.done += 1;
      else if (outcome === 'blocked') summary.blocked += 1;
      else summary.failed += 1;
    }
    if (deps.length > 0) {
      await this.bestEffortAudit({
        action: op === 'stop' ? 'suspension.apps_stopped' : 'suspension.apps_started',
        resourceType: 'subscription',
        resourceId: params.subscriptionId,
        details: { ...summary, holder: params.holder, c4: isHostingC4Enabled() },
      });
    }
    return summary;
  }

  private async dispatchOne(
    op: Op,
    p: {
      deploymentId: string;
      orderId: string | null;
      uuid: string;
      server: {
        panelProvider: string | null;
        apiBaseUrl: string | null;
        apiTokenEnc: string | null;
        strictTls: boolean;
      } | null;
      holder: string;
    },
  ): Promise<'done' | 'blocked' | 'failed'> {
    // ── Cible provider : capacité préalable, sinon blocage explicite ────────
    if (!p.server || !p.server.apiBaseUrl || !p.server.apiTokenEnc) {
      return this.recordBlock(op, p, 'sans_cible', 'Serveur panneau non configuré pour cette application.');
    }
    let target: PanelTarget;
    try {
      target = {
        provider: (p.server.panelProvider ?? 'COOLIFY') as PanelKind,
        baseUrl: p.server.apiBaseUrl,
        token: this.crypto.decrypt(p.server.apiTokenEnc),
        user: null,
        strictTls: p.server.strictTls,
      };
    } catch {
      return this.recordBlock(op, p, 'jeton_indefin', 'Jeton API panneau indéchiffrable (ENCRYPTION_KEY ?).');
    }

    // ── C4 (sous ON) : tentative durable AVANT le dispatch ──────────────────
    const c4Enabled = isHostingC4Enabled();
    let attemptId: string | null = null;
    if (c4Enabled) {
      try {
        const ticket = await this.c4.beginDispatchStandalone({
          nature: 'CONFIGURE',
          scope: { type: 'DEPLOYMENT', id: p.deploymentId },
          holder: p.holder,
          orderId: p.orderId,
          targetIntent: { type: 'application', op, uuid: p.uuid },
        });
        attemptId = ticket.attemptId;
      } catch (err) {
        // Refus C4 (arrêt opposable, tentative déjà ouverte…) → blocage
        // explicite de CET action, les autres corrections continuent.
        const msg = err instanceof Error ? err.message : String(err);
        const conflict = err instanceof ConflictException;
        if (conflict) return this.recordBlock(op, p, 'c4_refuse', msg);
        // Erreur inattendue (schéma, DB) : pas de faux succès, échec visible.
        return this.recordFail(op, p, msg, 'failed');
      }
    }

    // ── Dispatch transport (post-commit, jamais dans la TX métier) ──────────
    try {
      const transport = this.panelFactory.create();
      if (op === 'stop') await transport.stopApplication(target, p.uuid);
      else await transport.startApplication(target, p.uuid);
      if (attemptId) {
        await this.c4.settleStandalone({ attemptId, holder: p.holder, outcome: 'SUCCESS' });
      }
      return 'done';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Capacité provider manquante (ex. panneau non Coolify) → PERMANENT :
      // bloqué explicitement, jamais présenté comme réussi.
      const capability =
        /non disponible pour ce fournisseur|Coolify uniquement/i.test(msg) ||
        /indéchiffrable|ENCRYPTION_KEY/i.test(msg);
      if (attemptId) {
        await this.c4
          .settleStandalone({
            attemptId,
            holder: p.holder,
            outcome: capability ? 'PERMANENT_FAILURE' : 'FAILED_RETRYABLE',
          })
          .catch((e) =>
            this.log.warn(`settle ${op} dep=${p.deploymentId} failed: ${String(e)}`),
          );
      }
      if (capability) return this.recordBlock(op, p, 'capacite_absente', msg);
      return this.recordFail(op, p, msg, 'failed');
    }
  }

  // ──────────────────────────── journalisation ─────────────────────────────

  private async recordBlock(
    op: Op,
    p: { deploymentId: string; holder: string },
    reason: string,
    detail: string,
  ): Promise<'blocked'> {
    await this.bestEffortAudit({
      action: op === 'stop' ? 'suspension.app_stop_blocked' : 'suspension.app_start_blocked',
      resourceType: 'deployment',
      resourceId: p.deploymentId,
      details: { reason, detail, holder: p.holder },
    });
    return 'blocked';
  }

  private async recordFail(
    op: Op,
    p: { deploymentId: string; holder: string },
    detail: string,
    kind: 'failed',
  ): Promise<typeof kind> {
    await this.bestEffortAudit({
      action: op === 'stop' ? 'suspension.app_stop_failed' : 'suspension.app_start_failed',
      resourceType: 'deployment',
      resourceId: p.deploymentId,
      details: { detail, holder: p.holder, kind },
    });
    return kind;
  }

  /** Audit best-effort : un échec de journalisation n'annule jamais l'effet. */
  private async bestEffortAudit(entry: {
    action: string;
    resourceType: string;
    resourceId: string;
    details: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.audit.record(entry);
    } catch (e) {
      this.log.warn(`audit ${entry.action} failed: ${String(e)}`);
    }
  }
}
