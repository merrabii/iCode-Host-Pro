import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  HostingPack,
  HostingService,
  HostingServiceAllocation,
  HostingServiceAllocationStatus,
  HostingServiceStatus,
  Product,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
 * reste consommé) ; RELEASED ne consomme plus. La libération réelle est
 * implémentée en 17B.4F-C : ici aucune allocation n'est créée dans le parcours
 * live (aucun endpoint, aucun appelant), la réservation transactionnelle avec
 * verrou (`SELECT … FOR UPDATE`) arrive en 17B.4F-C.
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
   * Réservation d'un slot sur un service (17B.4F-C ajoutera le verrou
   * transactionnel ; l'unicité de la clé est déjà garantie en base). Un service
   * CANCELLED n'est JAMAIS réservable.
   */
  async reserve(params: {
    hostingServiceId: string;
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<HostingServiceAllocation> {
    const service = await this.get(params.hostingServiceId, params.actorUserId);
    if (service.status === HostingServiceStatus.CANCELLED) {
      throw new ForbiddenException('Aucune réservation possible sur un service annulé.');
    }
    if (!params.idempotencyKey || !params.idempotencyKey.trim()) {
      throw new BadRequestException('Clé de réservation manquante.');
    }
    try {
      return await this.prisma.hostingServiceAllocation.create({
        data: {
          hostingServiceId: service.id,
          idempotencyKey: params.idempotencyKey,
          status: HostingServiceAllocationStatus.RESERVED,
        },
      });
    } catch (error) {
      throw this.mapUnique(error, 'Clé de réservation déjà utilisée.');
    }
  }

  /**
   * Liaison d'une réservation à UN déploiement (unicité DB : un Deployment ne
   * peut appartenir qu'à une seule allocation). Ownership du service ET du
   * déploiement exigé — aucun lien inter-clients possible.
   */
  async bind(params: {
    allocationId: string;
    actorUserId: string;
    deploymentId: string;
  }): Promise<HostingServiceAllocation> {
    const allocation = await this.prisma.hostingServiceAllocation.findUnique({
      where: { id: params.allocationId },
    });
    if (!allocation) {
      throw new NotFoundException('Allocation introuvable.');
    }
    const service = await this.get(allocation.hostingServiceId, params.actorUserId);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: params.deploymentId },
    });
    if (!deployment || deployment.userId !== service.userId) {
      throw new NotFoundException('Déploiement introuvable.');
    }
    if (allocation.status === HostingServiceAllocationStatus.RELEASED) {
      throw new ForbiddenException('Allocation déjà libérée.');
    }
    if (allocation.deploymentId === params.deploymentId) {
      return allocation; // retry idempotent : déjà liée à CE déploiement
    }
    if (allocation.deploymentId) {
      throw new ConflictException('Allocation déjà liée à un autre déploiement.');
    }
    try {
      return await this.prisma.hostingServiceAllocation.update({
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
