import { Injectable, Logger } from '@nestjs/common';
import { DeploymentStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentEvidenceService } from './deployment-evidence.service';
import { ProviderDeploymentObservation } from './deployment-evidence';
import { reconcileBackoffDelayMs } from './reconcile-backoff';
import { ReconcileSettings } from './reconcile-settings';
import { ReconcileSettingsService } from './reconcile-settings.service';
import { ProvisioningService } from './provisioning.service';

/**
 * 17B.4B — MOTEUR de réconciliation asynchrone des déploiements restés
 * DEPLOYING après le proof-gate borné (17B.3B/3C). Appelé en `scanOnce` —
 * AUCUNE boucle, AUCUN worker ici (le timer dynamique 17B.4C appellera scanOnce
 * et relira les settings ; jamais de setInterval/@Cron dans ce service).
 *
 * Dépend UNIQUEMENT de : Prisma, ReconcileSettingsService (la configuration),
 * DeploymentEvidenceService (celui-ci OBSERVE par identifiant : la couche
 * évidence est la SEULE à charger serverId/fqdn/resourceId côté provider) et
 * ProvisioningService.activateOrderAfterProof (activation 17B.3B). Aucune
 * connaissance du panel dans le moteur : ni resourceId provider, ni choix de
 * provider, ni vocabulaire de statuts (grep de validation).
 *
 * Réflexions par cycle, candidat par candidat (les erreurs d'un candidat sont
 * isolées : jamais un candidat pourri ne bloque le batch ni le service).
 * L'ordre d'un candidat ne dépend que de son échéance (reconcileNextAt asc).
 * `now` est injectable pour des tests déterministes (horloge contrôlée).
 */

/** Statistiques agrégées d'un scan — observables par tests et monitoring. */
export interface ReconcileScanStats {
  /** false si le moteur est désactivé par la configuration (aucune lecture). */
  enabled: boolean;
  /** Candidats lus en base (findMany). */
  scanned: number;
  /** Leases gagnés (claim atomique count=1). */
  claimed: number;
  /** Candidats perdus face à un concurrent (claim count=0, aucun appel panel). */
  lostRace: number;
  /** Activations lancées via activateOrderAfterProof. */
  activated: number;
  /** Transitions DEPLOYING→FAILED gagnées (2 échecs terminaux consécutifs). */
  failedTerminal: number;
  /** Replanifications (backoff) réussies. */
  rescheduled: number;
  /** Erreurs gérées (observation, activation, replanification) — jamais fatales. */
  errors: number;
  /** Alertes de seuil de tentatives journalisées (best-effort, exactement une). */
  alerts: number;
}

export const RECONCILE_TERMINAL_THRESHOLD = 2;

@Injectable()
export class ReconcileService {
  private readonly log = new Logger(ReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ReconcileSettingsService,
    private readonly evidence: DeploymentEvidenceService,
    private readonly provisioning: ProvisioningService,
  ) {}

  async scanOnce(now: Date = new Date()): Promise<ReconcileScanStats> {
    const stats: ReconcileScanStats = {
      enabled: true,
      scanned: 0,
      claimed: 0,
      lostRace: 0,
      activated: 0,
      failedTerminal: 0,
      rescheduled: 0,
      errors: 0,
      alerts: 0,
    };
    const config = this.settings.getSettings();
    if (!config.enabled) {
      stats.enabled = false;
      return stats;
    }

    const candidates = await this.prisma.deployment.findMany({
      where: {
        status: DeploymentStatus.DEPLOYING,
        reconcileNextAt: { not: null, lte: now },
      },
      orderBy: { reconcileNextAt: 'asc' },
      take: config.batchSize,
      // Clés GÉNÉRIQUES uniquement : aucune donnée provider (serverId, fqdn,
      // resourceId) ne traverse le moteur — c'est la couche évidence qui les
      // recharge pour son observation.
      select: {
        id: true,
        orderId: true,
        reconcileAttempts: true,
        reconcileTerminalFailures: true,
      },
    });
    stats.scanned = candidates.length;

    for (const candidate of candidates) {
      await this.processCandidate(candidate, config, now, stats);
    }
    return stats;
  }

  /**
   * Traitement d'un candidat : claim atomique (une seule victoire par échéance),
   * alerte de seuil best-effort exactement une fois, observation, puis matrice.
   */
  private async processCandidate(
    candidate: {
      id: string;
      orderId: string | null;
      reconcileAttempts: number;
      reconcileTerminalFailures: number;
    },
    config: ReconcileSettings,
    now: Date,
    stats: ReconcileScanStats,
  ): Promise<void> {
    const prevAttempts = candidate.reconcileAttempts;
    const prevFailures = candidate.reconcileTerminalFailures;

    // CLAIM atomique : on pose le lease AVANT toute lecture externe. Un concurrent
    // qui a déjà avancé l'échéance → count 0 → ils ont gagné, aucun appel panel.
    const claim = await this.prisma.deployment.updateMany({
      where: { id: candidate.id, status: DeploymentStatus.DEPLOYING, reconcileNextAt: { not: null, lte: now } },
      data: {
        reconcileNextAt: new Date(now.getTime() + config.leaseMs),
        reconcileAttempts: { increment: 1 },
        reconcileLastCheckedAt: now,
      },
    });
    if (claim.count === 0) {
      stats.lostRace += 1;
      return;
    }
    stats.claimed += 1;
    const attemptsAfter = prevAttempts + 1;

    // Alerte best-effort, EXACTEMENT une fois (compteur monotone : la transition
    // prev<threshold<=after ne peut être franchie qu'une seule fois par l'unique
    // propriétaire du claim). Ne fait JAMAIS échouer, ne change ni status ni FAILED.
    if (
      prevAttempts < config.attemptAlertThreshold &&
      attemptsAfter >= config.attemptAlertThreshold
    ) {
      try {
        await this.prisma.auditLog.create({
          data: {
            action: 'reconcile.attempt_alert',
            resourceType: 'deployment',
            resourceId: candidate.id,
            details: { attempts: attemptsAfter },
          },
        });
        stats.alerts += 1;
      } catch (e) {
        this.log.warn(`reconcile: alerte de seuil non journalisée deployment=${candidate.id}: ${String(e)}`);
      }
    }

    // Observation isolée : une exception (panel injoignable, erreur interne)
    // conserve l'état courant, préserve le compteur terminal et replanifie.
    // Le moteur ne transmet QUE l'identifiant : la couche évidence recharge elle-
    // même les données provider (serverId/fqdn/resourceId) — un futur renommage
    // interne ne modifiera JAMAIS ce point d'appel.
    let obs: ProviderDeploymentObservation;
    try {
      obs = await this.evidence.observe(candidate.id);
    } catch (e) {
      this.log.warn(`reconcile: observation échouée deployment=${candidate.id}: ${String(e)}`);
      stats.errors += 1;
      await this.safeReschedule(candidate.id, now, config, attemptsAfter, prevFailures, stats);
      return;
    }

    switch (obs.lifecycle) {
      case 'TERMINAL':
        await this.onTerminal(candidate, obs, attemptsAfter, prevFailures, config, now, stats);
        return;
      case 'RUNNING':
        await this.onRunning(candidate, obs, attemptsAfter, config, now, stats);
        return;
      case 'TRANSITIONAL':
        // Build en cours (légitime) : reset du compteur terminal, replanification.
        await this.safeReschedule(candidate.id, now, config, attemptsAfter, 0, stats);
        return;
      case 'UNKNOWN':
        // Indéterminé : on PRÉSERVE le compteur terminal, replanification sans
        // famine (le backoff reste borné par maxBackoffMs).
        await this.safeReschedule(candidate.id, now, config, attemptsAfter, prevFailures, stats);
        return;
    }
  }

  /** Lifecycle TERMINAL : incrémente le compteur ; < seuil → replanifie,
   *  >= seuil → FAILED (Order reste PROVISIONING, historique informatif unique). */
  private async onTerminal(
    candidate: { id: string; orderId: string | null },
    _obs: ProviderDeploymentObservation,
    attemptsAfter: number,
    prevFailures: number,
    config: ReconcileSettings,
    now: Date,
    stats: ReconcileScanStats,
  ): Promise<void> {
    const failuresAfter = prevFailures + 1;
    if (failuresAfter < RECONCILE_TERMINAL_THRESHOLD) {
      await this.safeReschedule(candidate.id, now, config, attemptsAfter, failuresAfter, stats);
      return;
    }

    // 2e échec terminal consécutif : transition ferme DEPLOYING→FAILED, toujours
    // gardée (status DEPLOYING) et atomique — un seul gagnant.
    try {
      const res = await this.prisma.deployment.updateMany({
        where: { id: candidate.id, status: DeploymentStatus.DEPLOYING },
        data: {
          status: DeploymentStatus.FAILED,
          reconcileNextAt: null,
          reconcileTerminalFailures: failuresAfter,
          reconcileLastCheckedAt: now,
        },
      });
      if (res.count === 1) {
        stats.failedTerminal += 1;
        // Historique informatif BEST-EFFORT et UNIQUE (la transition FAILED déjà
        // gagnée empêche toute ré-écriture). L'Order reste PROVISIONING : JAMAIS
        // d'email ni de mutation provider, l'admin relance via le dashboard.
        if (candidate.orderId) {
          try {
            await this.prisma.orderStatusHistory.create({
              data: {
                orderId: candidate.orderId,
                status: OrderStatus.PROVISIONING,
                note:
                  'Échec de déploiement confirmé (2 vérifications terminales consécutives) — relance requise.',
              },
            });
          } catch (e) {
            this.log.warn(`reconcile: historique terminal non journalisé deployment=${candidate.id}: ${String(e)}`);
          }
        }
      }
    } catch (e) {
      this.log.warn(`reconcile: échec terminal non appliqué deployment=${candidate.id}: ${String(e)}`);
      stats.errors += 1;
      // L'échec interne ne fabrique JAMAIS d'état : lease toujours en place → reprise.
    }
  }

  /** Lifecycle RUNNING : reset compteur terminal ; activable UNIQUEMENT sur
   *  preuve (provider suffisant, HTTP 2xx/3xx, ou preuve connecteur satisfaite). */
  private async onRunning(
    candidate: { id: string; orderId: string | null },
    obs: ProviderDeploymentObservation,
    attemptsAfter: number,
    config: ReconcileSettings,
    now: Date,
    stats: ReconcileScanStats,
  ): Promise<void> {
    const proved =
      obs.proofPolicy === 'PROVIDER_SUFFICIENT' ||
      (obs.proofPolicy === 'HTTP_REQUIRED' && obs.httpServed === true) ||
      (obs.proofPolicy === 'CONNECTOR_REQUIRED' && obs.connectorProof?.satisfied === true);

    if (!proved) {
      // RUNNING non prouvé : replanification (jamais ACTIVE sans preuve).
      await this.safeReschedule(candidate.id, now, config, attemptsAfter, 0, stats);
      return;
    }
    if (!candidate.orderId) {
      this.log.warn(`reconcile: activation impossible sans orderId deployment=${candidate.id} — replanification sûre`);
      await this.safeReschedule(candidate.id, now, config, attemptsAfter, 0, stats);
      return;
    }

    try {
      // Activation TOTALE via la couture 17B.3B (jamais de logique dupliquée).
      await this.provisioning.activateOrderAfterProof(candidate.orderId);
    } catch (e) {
      this.log.warn(`reconcile: activation échouée deployment=${candidate.id}: ${String(e)}`);
      stats.errors += 1;
      await this.safeReschedule(candidate.id, now, config, attemptsAfter, 0, stats);
      return;
    }

    // Après activation : plus de réconciliation pour ce déploiement. Le garde
    // status=DEPLOYING rend cette écriture sûre (jamais par-dessus un ACTIVE/FAILED).
    try {
      await this.prisma.deployment.updateMany({
        where: { id: candidate.id, status: DeploymentStatus.DEPLOYING },
        data: { reconcileNextAt: null, reconcileLastCheckedAt: null },
      });
    } catch (e) {
      this.log.warn(`reconcile: libération du lease échouée deployment=${candidate.id}: ${String(e)}`);
    }
    stats.activated += 1;
  }

  /** Replanification (backoff borné) — jamais un ACTIVE/FAILED fabriqué ; si
   *  l'écriture échoue, le lease (déjà posé par le claim) protège l'échéance. */
  private async safeReschedule(
    id: string,
    now: Date,
    config: ReconcileSettings,
    attempts: number,
    terminalFailures: number,
    stats: ReconcileScanStats,
  ): Promise<void> {
    const delay = reconcileBackoffDelayMs(attempts, config);
    const nextAt = new Date(now.getTime() + delay);
    try {
      await this.prisma.deployment.updateMany({
        where: { id, status: DeploymentStatus.DEPLOYING },
        data: {
          reconcileNextAt: nextAt,
          reconcileTerminalFailures: terminalFailures,
          reconcileLastCheckedAt: now,
        },
      });
      stats.rescheduled += 1;
    } catch (e) {
      this.log.warn(`reconcile: replanification échouée deployment=${id}: ${String(e)}`);
      stats.errors += 1;
    }
  }
}