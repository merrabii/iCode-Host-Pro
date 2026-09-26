import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HostingPack,
  HostingService,
  HostingServiceAllocation,
  HostingServiceAllocationStatus,
  HostingServiceStatus,
  Prisma,
  Product,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FingerprintConfigError,
  FingerprintKeyring,
  FingerprintPayloadError,
  ReservationPayload,
  computeFingerprint,
  directIdempotencyKey,
  loadKeyring,
  normalizeClientRequestId,
  verifyFingerprint,
} from './hosting-fingerprint';

/**
 * Phase 17B.4F-B1 — fondation métier `HostingService` + `HostingServiceAllocation`.
 *
 * `HostingService` = UNE instance de service achetée (1 ligne par achat) :
 * l'unité à laquelle le quota futur sera appliqué (JAMAIS globalement par
 * utilisateur ni par pack). Les limites du pack sont FIGÉES en snapshots à la
 * création et ne sont jamais recalculées depuis le catalogue ensuite — la
 * mutation d'un pack/produit ne modifie donc jamais silencieusement le contrat
 * acheté.
 *
 * `HostingServiceAllocation` = réservation persistante d'un slot d'app sur CE
 * service. Statuts CONSOMMANTS : RESERVED | BOUND | RELEASING (un slot incertain
 * reste consommé) ; RELEASED ne consomme plus. 17B.4F-C1 ajoute le moteur de
 * réservation TRANSACTIONNELLE (verrou `SELECT … FOR UPDATE`, quota, empreinte
 * HMAC versionnée, transitions locales) — SANS aucun appel réseau ni aucun
 * branchement sur les parcours live (aucun endpoint, aucun appelant) : la
 * reprise provider (lease/fencing + rapprochement par identité distante) reste
 * explicitement hors périmètre (C2–C4).
 *
 * Sécurité (règles H) : l'ownership est TOUJOURS `userId` (issue du jeton
 * serveur, jamais d'un input client) ; une commande/abonnement étranger est
 * refusé comme INEXISTANT (404) pour ne jamais fuiter l'existence d'une
 * ressource d'un autre client ; aucune donnée provider ni secret ne traverse
 * ce service (aucun transport de panel/DNS n'est injecté).
 */

/** Statuts d'allocation qui CONSOMMENT un slot du service. */
export const CONSUMING_ALLOCATION_STATUSES: readonly HostingServiceAllocationStatus[] = [
  HostingServiceAllocationStatus.RESERVED,
  HostingServiceAllocationStatus.BOUND,
  HostingServiceAllocationStatus.RELEASING,
];

/** Vrai si ce statut consomme encore un slot (RELEASED seul est libéré). */
export function consumesSlot(status: HostingServiceAllocationStatus): boolean {
  return CONSUMING_ALLOCATION_STATUSES.includes(status);
}

/** Snapshots contractuels figés à l'achat. */
export interface HostingServiceSnapshots {
  /** null = illimité (convention explicite du repo) ; 0 = aucun slot. */
  maxAppsSnapshot: number | null;
  ramMbSnapshot: number;
  cpuCoresSnapshot: number;
  storageLimitGbSnapshot: number | null;
  packNameSnapshot: string | null;
  productNameSnapshot: string | null;
}

export interface CreateHostingServiceInput {
  orderId?: string | null;
  subscriptionId?: string | null;
  productId?: string | null;
  packId?: string | null;
  deploymentModuleId?: string | null;
  status?: HostingServiceStatus;
  snapshots: HostingServiceSnapshots;
}

/**
 * Invariants de snapshots : entier ≥ 0 pour RAM/maxApps/storage, fini ≥ 0 pour
 * le CPU (fraction autorisée ex 0.5) ; `maxAppsSnapshot = null` = illimité.
 * Une valeur négative est TOUJOURS refusée (aussi verrouillée par CHECK en base).
 */
export function assertSnapshotsValid(snapshots: HostingServiceSnapshots): void {
  if (!Number.isInteger(snapshots.ramMbSnapshot) || snapshots.ramMbSnapshot < 0) {
    throw new BadRequestException('Snapshot RAM invalide : un entier ≥ 0 est exigé.');
  }
  if (!Number.isFinite(snapshots.cpuCoresSnapshot) || snapshots.cpuCoresSnapshot < 0) {
    throw new BadRequestException('Snapshot CPU invalide : une valeur finie ≥ 0 est exigée.');
  }
  if (
    snapshots.maxAppsSnapshot !== null &&
    (!Number.isInteger(snapshots.maxAppsSnapshot) || snapshots.maxAppsSnapshot < 0)
  ) {
    throw new BadRequestException(
      'Snapshot de quota invalide : null (illimité) ou un entier ≥ 0 est exigé.',
    );
  }
  if (
    snapshots.storageLimitGbSnapshot !== null &&
    (!Number.isInteger(snapshots.storageLimitGbSnapshot) || snapshots.storageLimitGbSnapshot < 0)
  ) {
    throw new BadRequestException('Snapshot de stockage invalide : null ou un entier ≥ 0 est exigé.');
  }
}

/**
 * Dérivation des snapshots AU MOMENT de l'achat, depuis le pack et le produit
 * choisis. Copie de VALEURS : la mutation ultérieure du pack/produit dans le
 * catalogue ne modifie jamais une ligne déjà créée (test « snapshots gelés »).
 */
export function snapshotsFromPack(
  pack: Pick<HostingPack, 'name' | 'ramMb' | 'cpuCores' | 'storageLimit' | 'maxApps'>,
  product?: Pick<Product, 'name'> | null,
): HostingServiceSnapshots {
  const snapshots: HostingServiceSnapshots = {
    maxAppsSnapshot: pack.maxApps ?? null,
    ramMbSnapshot: pack.ramMb,
    cpuCoresSnapshot: pack.cpuCores,
    storageLimitGbSnapshot: pack.storageLimit ?? null,
    packNameSnapshot: pack.name,
    productNameSnapshot: product?.name ?? null,
  };
  assertSnapshotsValid(snapshots);
  return snapshots;
}

/** Résultat d'une réservation : création OU rejeu idempotent de la même ligne. */
export interface ReserveSlotResult {
  allocation: HostingServiceAllocation;
  /** true = rejeu (aucune ligne créée, aucun quota consommé de plus). */
  replayed: boolean;
}

/**
 * Écriture de l'intention provider : résultat EXPLICITE (aucun réseau).
 * `applied: false` avec motif = l'état de l'allocation l'interdit (écriture
 * irréversible NON appliquée), jamais une exception masquant le diagnostic.
 */
export type ProviderIntentResult =
  | { applied: true; providerIntentAt: Date }
  | { applied: false; reason: 'already_present' | 'invalid_state' | 'terminal' };

/** Compensation pré-provider : résultat EXPLICITE (aucun réseau). */
export type ReleasePreProviderResult =
  | { released: true }
  | { released: false; reason: 'already_released' | 'intent_present' | 'linked' | 'invalid_state' };

/** État verrouillé d'une allocation (colonnes scalaires + propriétaire). */
interface AllocationLockRow {
  id: string;
  hostingServiceId: string;
  deploymentId: string | null;
  idempotencyKey: string;
  status: HostingServiceAllocationStatus;
  requestFingerprint: string | null;
  providerIntentAt: Date | null;
  reservedAt: Date;
  boundAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  ownerUserId: string;
}

@Injectable()
export class HostingServicesService {
  constructor(private readonly prisma: PrismaService) {}

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
    );
  }

  /** P2002 → Conflict (message métier), sinon re-throw tel quel. */
  private mapUnique(error: unknown, message: string): unknown {
    return this.isUniqueViolation(error) ? new ConflictException(message) : error;
  }

  /** Keyring d'empreinte chargé À L'APPEL : config absente → 503, boot intact. */
  private fingerprintKeyring(): FingerprintKeyring {
    try {
      return loadKeyring();
    } catch (error) {
      throw this.mapFingerprint(error);
    }
  }

  /** Traduction des erreurs d'empreinte : config/version → 503, payload → 400. */
  private mapFingerprint(error: unknown): unknown {
    if (error instanceof FingerprintConfigError) {
      return new ServiceUnavailableException(
        "Configuration d'empreinte de réservation indisponible : réservation refusée.",
      );
    }
    if (error instanceof FingerprintPayloadError) {
      return new BadRequestException('Payload de réservation invalide.');
    }
    return error;
  }

  /** Vérifie une empreinte stockée ; toute erreur d'empreinte = refus traduit. */
  private matchesFingerprint(
    stored: string | null,
    payload: ReservationPayload,
    keyring: FingerprintKeyring,
  ): boolean {
    try {
      return verifyFingerprint(stored, payload, keyring);
    } catch (error) {
      throw this.mapFingerprint(error);
    }
  }

  /**
   * Verrou d'allocation avec ordre DÉTERMINISTE des verrous (deux
   * instructions successives dans la même transaction) :
   *  ① `HostingService` `FOR UPDATE` d'abord (identifié par sous-requête sur
   *     l'allocation) — l'ownership (`userId`) est vérifié SOUS ce verrou ;
   *  ② `HostingServiceAllocation` `FOR UPDATE` ensuite.
   * 0 ligne à n'importe quelle étape, ou propriétaire différent → 404 (aucune
   * confirmation d'existence). Ordre global du moteur, identique pour
   * `reserveSlot` et toutes les primitives : HostingService →
   * HostingServiceAllocation → Deployment (jamais l'inverse, donc aucun
   * inter-verrou possible avec la réservation qui prend le service en premier).
   */
  private async lockAllocation(
    tx: Prisma.TransactionClient,
    allocationId: string,
    actorUserId: string,
  ): Promise<AllocationLockRow> {
    // ① verrou de LIGNE sur le service propriétaire AVANT l'allocation
    const services = await tx.$queryRaw<Array<{ userId: string }>>`
      SELECT s."userId" FROM "HostingService" AS s
      WHERE s."id" = (
        SELECT a."hostingServiceId" FROM "HostingServiceAllocation" AS a
        WHERE a."id" = ${allocationId}
      )
      FOR UPDATE`;
    const service = services[0];
    if (!service || service.userId !== actorUserId) {
      throw new NotFoundException('Allocation introuvable.');
    }

    // ② verrou de LIGNE sur l'allocation (propriétaire déjà vérifié)
    const rows = await tx.$queryRaw<AllocationLockRow[]>`
      SELECT a.* FROM "HostingServiceAllocation" AS a
      WHERE a."id" = ${allocationId}
      FOR UPDATE OF a`;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Allocation introuvable.');
    }
    return { ...row, ownerUserId: service.userId };
  }

  /**
   * Création logique d'un service acheté : snapshots validés, provenance
   * (commande/abonnement) APPARTENANT AU MÊME propriétaire — sinon 404 (aucune
   * confirmation d'existence d'une ressource étrangère).
   */
  async create(ownerUserId: string, input: CreateHostingServiceInput): Promise<HostingService> {
    if (!ownerUserId) {
      throw new BadRequestException('Propriétaire du service manquant.');
    }
    assertSnapshotsValid(input.snapshots);

    if (input.orderId) {
      const order = await this.prisma.order.findUnique({
        where: { id: input.orderId },
        include: { customer: { select: { userId: true } } },
      });
      if (!order || order.customer.userId !== ownerUserId) {
        throw new NotFoundException('Commande introuvable.');
      }
    }

    if (input.subscriptionId) {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: input.subscriptionId },
      });
      if (!subscription || subscription.userId !== ownerUserId) {
        throw new NotFoundException('Abonnement introuvable.');
      }
      if (
        input.orderId &&
        subscription.orderId &&
        subscription.orderId !== input.orderId
      ) {
        throw new BadRequestException("Cet abonnement n'est pas lié à cette commande.");
      }
    }

    try {
      return await this.prisma.hostingService.create({
        data: {
          userId: ownerUserId,
          orderId: input.orderId ?? null,
          subscriptionId: input.subscriptionId ?? null,
          productId: input.productId ?? null,
          packId: input.packId ?? null,
          deploymentModuleId: input.deploymentModuleId ?? null,
          ...(input.status ? { status: input.status } : {}),
          maxAppsSnapshot: input.snapshots.maxAppsSnapshot,
          ramMbSnapshot: input.snapshots.ramMbSnapshot,
          cpuCoresSnapshot: input.snapshots.cpuCoresSnapshot,
          storageLimitGbSnapshot: input.snapshots.storageLimitGbSnapshot,
          packNameSnapshot: input.snapshots.packNameSnapshot,
          productNameSnapshot: input.snapshots.productNameSnapshot,
        },
      });
    } catch (error) {
      throw this.mapUnique(
        error,
        'Un service existe déjà pour cette commande ou cet abonnement.',
      );
    }
  }

  /**
   * Lecture par ownership. Un service d'un autre client est INEXISTANT (404) :
   * jamais de 403 qui confirmerait son existence (aucune fuite entre clients).
   */
  async get(id: string, actorUserId: string): Promise<HostingService> {
    const service = await this.prisma.hostingService.findUnique({ where: { id } });
    if (!service || service.userId !== actorUserId) {
      throw new NotFoundException('Service hébergement introuvable.');
    }
    return service;
  }

  /**
   * ── 17B.4F-C1 : moteur de réservation transactionnel ──────────────────────
   *
   * Contrat (TOUT dans UNE transaction, ZÉRO appel réseau) :
   *  ① `SELECT … FOR UPDATE` sur `HostingService` avec `id` + `userId`
   *     (0 ligne → 404, jamais 403 : aucune fuite d'existence) ;
   *  ② relecture de la ligne par clé DÉRIVÉE `direct:v1:user:service:uuid` ;
   *  ③ si elle existe (rejeu) → retour de la MÊME allocation APRÈS vérification
   *     d'empreinte (payload exact) : SANS création, SANS re-vérification de
   *     statut/quota (lecture seule, aucune nouvelle exécution, jamais de 2ᵉ
   *     ligne) — y compris pour un service entre-temps suspendu ou une
   *     allocation déjà RELEASED (terminal) ;
   *  ④ sinon → statut réservable `ACTIVE` SEUL, quota (`maxAppsSnapshot`
   *     null = illimité), création `RESERVED` avec empreinte stockée.
   *
   * Échecs DB/ownership/compatibilité/empreinte/config = refus fail-closed ;
   * la clé de configuration d'empreinte absente refuse la réservation (503)
   * SANS empêcher le démarrage de l'API.
   */
  async reserveSlot(params: {
    hostingServiceId: string;
    actorUserId: string;
    clientRequestId: string;
    payload: ReservationPayload;
  }): Promise<ReserveSlotResult> {
    if (!params.actorUserId) {
      throw new BadRequestException('Utilisateur manquant.');
    }
    let clientRequestId: string;
    try {
      clientRequestId = normalizeClientRequestId(params.clientRequestId);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const keyring = this.fingerprintKeyring();
    let fingerprint: string;
    try {
      fingerprint = computeFingerprint(params.payload, keyring);
    } catch (error) {
      throw this.mapFingerprint(error);
    }
    const idempotencyKey = directIdempotencyKey(
      params.actorUserId,
      params.hostingServiceId,
      clientRequestId,
    );

    return this.prisma.$transaction(async (tx) => {
      // ① verrou de LIGNE sur le service, ownership inclus (→ 404 si étranger)
      const locked = await tx.$queryRaw<HostingService[]>`
        SELECT * FROM "HostingService"
        WHERE "id" = ${params.hostingServiceId} AND "userId" = ${params.actorUserId}
        FOR UPDATE`;
      const service = locked[0];
      if (!service) {
        throw new NotFoundException('Service hébergement introuvable.');
      }

      // ②③ rejeu : même clé + empreinte identique → MÊME allocation
      const existing = await tx.hostingServiceAllocation.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        if (existing.hostingServiceId !== service.id) {
          throw new ConflictException('Clé de réservation déjà utilisée.');
        }
        if (!this.matchesFingerprint(existing.requestFingerprint, params.payload, keyring)) {
          throw new ConflictException('Rejeu refusé : empreinte de réservation différente.');
        }
        return { allocation: existing, replayed: true };
      }

      // ④ création : ACTIVE seul, puis quota, puis écriture
      if (service.status !== HostingServiceStatus.ACTIVE) {
        throw new ForbiddenException(
          service.status === HostingServiceStatus.CANCELLED
            ? 'Aucune réservation possible sur un service annulé.'
            : 'Aucune réservation possible sur un service non actif.',
        );
      }
      const consuming = await tx.hostingServiceAllocation.count({
        where: {
          hostingServiceId: service.id,
          status: { in: [...CONSUMING_ALLOCATION_STATUSES] },
        },
      });
      const maxApps = service.maxAppsSnapshot;
      if (maxApps !== null && consuming + 1 > maxApps) {
        throw new ForbiddenException('Quota de slots atteint sur ce service.');
      }
      try {
        const allocation = await tx.hostingServiceAllocation.create({
          data: {
            hostingServiceId: service.id,
            idempotencyKey,
            status: HostingServiceAllocationStatus.RESERVED,
            requestFingerprint: fingerprint,
          },
        });
        return { allocation, replayed: false };
      } catch (error) {
        if (!this.isUniqueViolation(error)) {
          throw error;
        }
        // Course défensive : un concurrent aurait créé la MÊME clé.
        const concurrent = await tx.hostingServiceAllocation.findUnique({
          where: { idempotencyKey },
        });
        if (concurrent && this.matchesFingerprint(concurrent.requestFingerprint, params.payload, keyring)) {
          return { allocation: concurrent, replayed: true };
        }
        throw new ConflictException('Clé de réservation déjà utilisée.');
      }
    });
  }

  /**
   * Marqueur local IRRÉVOCABLE « intention d'appel provider committée AVANT
   * toute écriture réseau » (audit/reconciliation C2+). Écriture ATOMIQUE sous
   * verrou d'allocation, JAMAIS sur `RELEASED`, JAMAIS effacée. Ne prouve NI
   * un résultat provider NI une reprise distante.
   */
  async markProviderIntent(params: {
    allocationId: string;
    actorUserId: string;
  }): Promise<ProviderIntentResult> {
    return this.prisma.$transaction(async (tx) => {
      const allocation = await this.lockAllocation(tx, params.allocationId, params.actorUserId);
      if (allocation.status === HostingServiceAllocationStatus.RELEASED) {
        return { applied: false, reason: 'terminal' } as const;
      }
      if (allocation.providerIntentAt) {
        return { applied: false, reason: 'already_present' } as const;
      }
      if (
        allocation.status !== HostingServiceAllocationStatus.RESERVED &&
        allocation.status !== HostingServiceAllocationStatus.BOUND
      ) {
        return { applied: false, reason: 'invalid_state' } as const;
      }
      const providerIntentAt = new Date();
      await tx.hostingServiceAllocation.update({
        where: { id: allocation.id },
        data: { providerIntentAt },
      });
      return { applied: true, providerIntentAt } as const;
    });
  }

  /**
   * Compensation PRÉ-provider (même transaction, mêmes conditions) : exige
   * `RESERVED` + `providerIntentAt NULL` + `deploymentId NULL` — sinon refus
   * explicite. Aucun réseau : c'est la contrepartie locale d'un abandon avant
   * tout appel distant.
   */
  async releasePreProvider(params: {
    allocationId: string;
    actorUserId: string;
  }): Promise<ReleasePreProviderResult> {
    return this.prisma.$transaction(async (tx) => {
      const allocation = await this.lockAllocation(tx, params.allocationId, params.actorUserId);
      if (allocation.status === HostingServiceAllocationStatus.RELEASED) {
        return { released: false, reason: 'already_released' } as const;
      }
      if (allocation.providerIntentAt) {
        return { released: false, reason: 'intent_present' } as const;
      }
      if (allocation.deploymentId) {
        return { released: false, reason: 'linked' } as const;
      }
      if (allocation.status !== HostingServiceAllocationStatus.RESERVED) {
        return { released: false, reason: 'invalid_state' } as const;
      }
      await tx.hostingServiceAllocation.update({
        where: { id: allocation.id },
        data: {
          status: HostingServiceAllocationStatus.RELEASED,
          releasedAt: new Date(),
        },
      });
      return { released: true } as const;
    });
  }

  /**
   * `RESERVED → BOUND` sous verrou : ownership service ET déploiement exigé
   * (aucun lien inter-clients), preuve provider contractuelle, idempotent sur
   * le MÊME déploiement, `RELEASED` jamais ressuscité, `RELEASING → BOUND`
   * INTERDIT. Un déploiement déjà lié est refusé (unicité DB de secours).
   */
  async markBound(params: {
    allocationId: string;
    actorUserId: string;
    deploymentId: string;
    proof: { providerProven: boolean };
  }): Promise<HostingServiceAllocation> {
    if (params.proof?.providerProven !== true) {
      throw new PreconditionFailedException('Preuve provider (providerProven) requise avant liaison.');
    }
    return this.prisma.$transaction(async (tx) => {
      const allocation = await this.lockAllocation(tx, params.allocationId, params.actorUserId);
      if (allocation.status === HostingServiceAllocationStatus.RELEASED) {
        throw new ForbiddenException('Allocation déjà libérée.');
      }
      if (allocation.deploymentId === params.deploymentId) {
        return tx.hostingServiceAllocation.findUniqueOrThrow({ where: { id: allocation.id } });
      }
      if (allocation.deploymentId) {
        throw new ConflictException('Allocation déjà liée à un autre déploiement.');
      }
      if (allocation.status === HostingServiceAllocationStatus.RELEASING) {
        throw new ForbiddenException('Libération en cours : liaison refusée.');
      }
      if (allocation.status !== HostingServiceAllocationStatus.RESERVED) {
        throw new ForbiddenException('Liaison impossible depuis cet état.');
      }
      // ③ verrou Deployment (APRÈS Service → Allocation, ordre respecté) +
      // ownership croisé : déploiement du MÊME propriétaire que le service
      const deployments = await tx.$queryRaw<Array<{ userId: string }>>`
        SELECT d."userId" FROM "Deployment" AS d
        WHERE d."id" = ${params.deploymentId}
        FOR UPDATE`;
      const deployment = deployments[0];
      if (!deployment || deployment.userId !== allocation.ownerUserId) {
        throw new NotFoundException('Déploiement introuvable.');
      }
      try {
        return await tx.hostingServiceAllocation.update({
          where: { id: allocation.id },
          data: {
            deploymentId: params.deploymentId,
            status: HostingServiceAllocationStatus.BOUND,
            boundAt: new Date(),
          },
        });
      } catch (error) {
        throw this.mapUnique(error, 'Ce déploiement est déjà lié à une allocation.');
      }
    });
  }

  /** `RESERVED | BOUND → RELEASING` (idempotent sur `RELEASING`, `RELEASED` terminal). */
  async startReleasing(params: {
    allocationId: string;
    actorUserId: string;
  }): Promise<HostingServiceAllocation> {
    return this.prisma.$transaction(async (tx) => {
      const allocation = await this.lockAllocation(tx, params.allocationId, params.actorUserId);
      if (allocation.status === HostingServiceAllocationStatus.RELEASED) {
        throw new ForbiddenException('Allocation déjà libérée.');
      }
      if (allocation.status === HostingServiceAllocationStatus.RELEASING) {
        return tx.hostingServiceAllocation.findUniqueOrThrow({ where: { id: allocation.id } });
      }
      if (
        allocation.status !== HostingServiceAllocationStatus.RESERVED &&
        allocation.status !== HostingServiceAllocationStatus.BOUND
      ) {
        throw new ForbiddenException('Transition vers RELEASING refusée.');
      }
      return tx.hostingServiceAllocation.update({
        where: { id: allocation.id },
        data: { status: HostingServiceAllocationStatus.RELEASING },
      });
    });
  }

  /**
   * `RELEASING → RELEASED` : preuve de nettoyage provider exigée + ligne
   * déploiement DÉTACHÉE (`deploymentId NULL`) + `RELEASED` idempotent.
   * Valide un CONTRAT LOCAL : le nettoyage distant réel reste C2–C4.
   */
  async completeRelease(params: {
    allocationId: string;
    actorUserId: string;
    proof: { providerCleanupProven: boolean };
  }): Promise<HostingServiceAllocation> {
    if (params.proof?.providerCleanupProven !== true) {
      throw new PreconditionFailedException(
        'Preuve de nettoyage provider (providerCleanupProven) requise.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const allocation = await this.lockAllocation(tx, params.allocationId, params.actorUserId);
      if (allocation.status === HostingServiceAllocationStatus.RELEASED) {
        return tx.hostingServiceAllocation.findUniqueOrThrow({ where: { id: allocation.id } });
      }
      if (allocation.status !== HostingServiceAllocationStatus.RELEASING) {
        throw new ForbiddenException('Seule une libération en cours peut être finalisée.');
      }
      if (allocation.deploymentId) {
        throw new ConflictException('Le déploiement doit être détaché avant la libération.');
      }
      return tx.hostingServiceAllocation.update({
        where: { id: allocation.id },
        data: {
          status: HostingServiceAllocationStatus.RELEASED,
          releasedAt: new Date(),
        },
      });
    });
  }

  /**
   * Comptage des slots CONSOMMANTS d'un service (futur quota par
   * hostingServiceId). N'utilise JAMAIS un simple count(*) Deployment.
   */
  async countConsumingAllocations(hostingServiceId: string): Promise<number> {
    return this.prisma.hostingServiceAllocation.count({
      where: {
        hostingServiceId,
        status: { in: [...CONSUMING_ALLOCATION_STATUSES] },
      },
    });
  }
}
