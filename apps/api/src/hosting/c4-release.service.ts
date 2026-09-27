import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HostingServicesService } from './hosting-services.service';
import { C4ProtocolService } from './c4-protocol.service';

/** Issue app rapportee par le chemin de cleanup (this-run, reseau separe). */
export type C4AppOutcome = 'deleted' | 'absent' | 'not_created' | 'unknown' | 'failed';

/** Issue DNS rapportee par le chemin de cleanup (this-run, reseau separe). */
export type C4DnsOutcome = 'deleted' | 'absent' | 'not_created' | 'unknown' | 'failed';

/** Raison de blocage d'une liberation (incertitude conservee, jamais libere). */
export type C4ReleaseBlockedReason =
  | 'no_allocation'
  | 'inconsistent_state'
  | 'pre_protocol_uncertain'
  | 'call_uncertain'
  | 'app_not_conclusive'
  | 'dns_not_conclusive'
  | 'dns_unidentifiable';

/** Resultat d'une tentative de liberation d'allocation (C4). */
export interface C4ReleaseResult {
  status: 'released' | 'already_released' | 'pre_provider_released' | 'blocked';
  allocationId: string;
  blockedReason?: C4ReleaseBlockedReason;
}

/** Entree d'une liberation : issues concluantes obtenues HORS transaction. */
export interface C4ReleaseParams {
  allocationId: string;
  actorUserId: string;
  orderId?: string | null;
  /** Issue app de CE run reseau (delete/cleanup), jamais un booleen d'entree. */
  app: C4AppOutcome;
  /** Issue DNS de CE run reseau. */
  dns: C4DnsOutcome;
  /** Un ClientSubdomain avec `recordId` existait (DNS cree) au moment du run ? */
  dnsHadRecord: boolean;
  /** Identifiant app connu (uuid) si present avant nettoyage. */
  appIdentifier?: string | null;
  /** Identifiant DNS connu (fqdn/recordId) si present avant nettoyage. */
  dnsIdentifier?: string | null;
  /** Tentatives visibles de ce run (tracabilite de la preuve). */
  attemptIds?: string[];
  /**
   * (D6 — chemin `remove()` sous ON) Rows locales a supprimer DANS LA MEME
   * transaction que la preuve unique et `RELEASED` (atomicite exigee) :
   * `deploymentId` verifie a l'entree du remove (ownership prouve par
   * l'appelant via `actorUserId`), `removeClientSubdomain` = ownership CS
   * prouve ET DNS concluant. Absent : comportement historique inchange (le
   * caller gere ses propres rows locales hors de cette transaction).
   */
  cleanup?: {
    deploymentId: string;
    removeClientSubdomain: boolean;
    /** Proprietaire eprouve a l'entree du remove (row.userId = actor). */
    actorUserId?: string | null;
  };
}

/**
 * 17B.4F-C4 — orchestrateur de liberation des allocations sous preuves
 * suffisantes (D6/D2/H5).
 *
 * Contrat :
 *  - ZERO reseau ici : le cleanup distant (delete) a deja ete execute et
 *    consigne par le caller ; cette classe VERIFIE la suffisance des preuves
 *    par ressource, puis execute la T-release ATOMIQUE.
 *  - Suffisance : `providerIntentAt NULL` => liberation pre-provider
 *    structurelle (seule exception hors interdiction pre-protocole) ;
 *    allocation pre-protocole (intention sans tentative CREATE) =>
 *    `pre_protocol_uncertain` (slot conserve, support) ;
 *    createur non resolu => `call_uncertain` ; issue app/DNS non conclusive
 *    ou DNS cree mais non identifiable => bloque. Aucun blocage « global » :
 *    chaque allocation est jugee sur SES preuves.
 *  - T-release (UNE transaction, verrous `HostingService ->
 *    HostingServiceAllocation -> Deployment`) : recheck sous verrous,
 *    detachement de la row Deployment (ownership croise), ecriture de
 *    `C4ReleaseEvidence` (unique par allocation = UNE seule liberation locale)
 *    et `RELEASING -> RELEASED` atomiques. Reseau JAMAIS sous transaction.
 */
@Injectable()
export class C4ReleaseService {
  private readonly log = new Logger(C4ReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hosting: HostingServicesService,
    private readonly protocol: C4ProtocolService,
  ) {}

  /** Libere une allocation si — et seulement si — ses preuves sont suffisantes. */
  async releaseAfterCleanup(params: C4ReleaseParams): Promise<C4ReleaseResult> {
    const allocation = await this.prisma.hostingServiceAllocation.findUnique({
      where: { id: params.allocationId },
      select: {
        id: true,
        status: true,
        providerIntentAt: true,
        hostingServiceId: true,
      },
    });
    if (!allocation) {
      return {
        status: 'blocked',
        allocationId: params.allocationId,
        blockedReason: 'no_allocation',
      };
    }
    if (allocation.status === 'RELEASED') {
      return { status: 'already_released', allocationId: params.allocationId };
    }

    // ── Liberation PRE-provider structurelle (aucune intention posee) ───────
    if (!allocation.providerIntentAt) {
      try {
        const res = await this.hosting.releasePreProvider({
          allocationId: params.allocationId,
          actorUserId: params.actorUserId,
        });
        return res.released
          ? { status: 'pre_provider_released', allocationId: params.allocationId }
          : {
              status: 'blocked',
              allocationId: params.allocationId,
              blockedReason: 'inconsistent_state',
            };
      } catch {
        return {
          status: 'blocked',
          allocationId: params.allocationId,
          blockedReason: 'inconsistent_state',
        };
      }
    }

    // ── Pre-protocole : intention posee sans AUCUNE tentative CREATE ────────
    // Aucune adoption automatique (GO regle 2) : slot conserve, support.
    if (await this.protocol.isPreProtocol(allocation)) {
      this.log.warn('release: allocation pre-protocole — slot conserve (support)');
      return {
        status: 'blocked',
        allocationId: params.allocationId,
        blockedReason: 'pre_protocol_uncertain',
      };
    }

    // ── Createur non resolu (tentative DISPATCHED ou outcome UNKNOWN) ──────
    if ((await this.protocol.unresolvedCreative(params.allocationId)) > 0) {
      return {
        status: 'blocked',
        allocationId: params.allocationId,
        blockedReason: 'call_uncertain',
      };
    }

    // ── Suffisance PAR RESSOURCE : app ─────────────────────────────────────
    let appEvidence = params.app;
    if (appEvidence !== 'deleted' && appEvidence !== 'absent' && appEvidence !== 'not_created') {
      // Pas de conclusion de CE run : seule une tentative CREATE conclusive
      // REFUSED (aucune ressource creee) peut prouver la non-existence.
      const refused = await this.prisma.c4ProviderAttempt.count({
        where: {
          allocationId: params.allocationId,
          nature: 'CREATE',
          phase: 'RETURNED',
          outcome: 'REFUSED',
        },
      });
      if (refused > 0) appEvidence = 'not_created';
      else {
        return {
          status: 'blocked',
          allocationId: params.allocationId,
          blockedReason: 'app_not_conclusive',
        };
      }
    }

    // ── Suffisance PAR RESSOURCE : DNS ─────────────────────────────────────
    let dnsEvidence = params.dns;
    if (params.dnsHadRecord) {
      if (dnsEvidence !== 'deleted' && dnsEvidence !== 'absent') {
        return {
          status: 'blocked',
          allocationId: params.allocationId,
          blockedReason: 'dns_not_conclusive',
        };
      }
    } else if (dnsEvidence !== 'deleted' && dnsEvidence !== 'absent' && dnsEvidence !== 'not_created') {
      // Aucun recordId local : prouver que le DNS n'a JAMAIS reussi (tentative
      // CONFIGURE conclusive sans SUCCESS) — sinon « cree mais non identifiable ».
      const dnsSuccess = await this.prisma.c4ProviderAttempt.count({
        where: {
          allocationId: params.allocationId,
          nature: 'CONFIGURE',
          phase: 'RETURNED',
          outcome: 'SUCCESS',
        },
      });
      if (dnsSuccess > 0) {
        return {
          status: 'blocked',
          allocationId: params.allocationId,
          blockedReason: 'dns_unidentifiable',
        };
      }
      const dnsConclusive = await this.prisma.c4ProviderAttempt.count({
        where: {
          allocationId: params.allocationId,
          nature: 'CONFIGURE',
          phase: 'RETURNED',
          outcome: { in: ['REFUSED', 'PERMANENT_FAILURE', 'ABSENT'] },
        },
      });
      if (dnsConclusive === 0 && params.dns !== 'not_created') {
        return {
          status: 'blocked',
          allocationId: params.allocationId,
          blockedReason: 'dns_not_conclusive',
        };
      }
      dnsEvidence = 'not_created';
    }

    const appOutcome = appEvidence === 'not_created' ? 'NOT_CREATED' : appEvidence.toUpperCase();
    const dnsOutcome = dnsEvidence === 'not_created' ? 'NOT_CREATED' : dnsEvidence.toUpperCase();

    // ── T-release : UNE transaction, verrous ordonnes, aucune methode imbriquee
    let released = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.hosting.startReleasingInTx(tx, {
          allocationId: params.allocationId,
          actorUserId: params.actorUserId,
        });
        const locked = await tx.hostingServiceAllocation.findUnique({
          where: { id: params.allocationId },
          select: {
            status: true,
            providerIntentAt: true,
            deploymentId: true,
            hostingService: { select: { userId: true } },
          },
        });
        if (!locked || locked.status === 'RELEASED') return; // liberation concurrente gagnee
        // Recheck sous verrous : createur non resolu / intention disparue.
        if (!(await locked.providerIntentAt)) {
          throw new ConflictException('Intention provider absente sous verrou — liberation refusee.');
        }
        if ((await this.protocol.unresolvedCreativeInTx(tx, params.allocationId)) > 0) {
          throw new ConflictException('Createur non resolu sous verrou — liberation refusee.');
        }
        // Detachement/suppression locale + preuve + RELEASED : UNE transaction
        // (D6 — l'atomicite est exigee pour le parcours remove(), qui passe
        // `cleanup` : deployment + ClientSubdomain supprimes ICI, avec la
        // preuve unique et le passage RELEASED ; rollback conjoint sinon).
        if (params.cleanup) {
          await this.deleteLocalRowsInTx(tx, params.cleanup, locked.hostingService.userId);
        } else if (locked.deploymentId) {
          // Comportement historique (order-cancel) : detachement ownership-strict
          // du deployment seul ; les autres rows locales restent au caller.
          const dep = await tx.deployment.findUnique({
            where: { id: locked.deploymentId },
            select: { id: true, userId: true },
          });
          if (dep && dep.userId !== locked.hostingService.userId) {
            throw new ConflictException('Deployment etranger — liberation refusee.');
          }
          await tx.deployment.deleteMany({ where: { id: locked.deploymentId } });
        }
        // Preuve durable unique par allocation (H5 : une seule liberation).
        await tx.c4ReleaseEvidence.create({
          data: {
            allocationId: params.allocationId,
            orderId: params.orderId ?? null,
            ownerUserId: params.actorUserId,
            appIdentifier: params.appIdentifier ?? null,
            dnsIdentifier: params.dnsIdentifier ?? null,
            appOutcome,
            dnsOutcome,
            attemptIds: (params.attemptIds ?? []) as never,
            details: {
              dnsHadRecord: params.dnsHadRecord,
              app: appEvidence,
              dns: dnsEvidence,
            },
          },
        });
        await this.hosting.completeReleaseInTx(tx, {
          allocationId: params.allocationId,
          actorUserId: params.actorUserId,
          evidence: { appOutcome, dnsOutcome },
        });
        released = true;
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('libérée')) {
        return { status: 'already_released', allocationId: params.allocationId };
      }
      throw error;
    }

    return released
      ? { status: 'released', allocationId: params.allocationId }
      : { status: 'already_released', allocationId: params.allocationId };
  }

  /**
   * Suppression locale atomique (rows Deployment/ClientSubdomain) EXECUTEE
   * SOUS le verrou de liberation, dans LA transaction de la preuve (D6) :
   * si la transaction echoue, rollback CONJOINT (rows + preuve + RELEASED).
   * Ownership croise : une row Deployment d'un autre utilisateur bloque la
   * liberation ; `cleanup.actorUserId` (row.userId = actor, eprouve a
   * l'entree du remove) est accepte en plus du proprietaire du service.
   * `removeClientSubdomain` n'est vrai que si l'ownership CS est eprouve ET
   * le DNS concluant — sinon la row CS est conservee (adressable).
   */
  private async deleteLocalRowsInTx(
    tx: Prisma.TransactionClient,
    cleanup: NonNullable<C4ReleaseParams['cleanup']>,
    serviceUserId: string,
  ): Promise<void> {
    const dep = await tx.deployment.findUnique({
      where: { id: cleanup.deploymentId },
      select: { id: true, userId: true },
    });
    if (dep && dep.userId !== serviceUserId && dep.userId !== (cleanup.actorUserId ?? null)) {
      throw new ConflictException('Deployment etranger — liberation refusee.');
    }
    if (cleanup.removeClientSubdomain) {
      await tx.clientSubdomain.deleteMany({ where: { deploymentId: cleanup.deploymentId } });
    }
    await tx.deployment.deleteMany({ where: { id: cleanup.deploymentId } });
  }
}
