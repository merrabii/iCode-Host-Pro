import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PackStatus,
  ProductStatus,
  Subscription,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../users/users.service';
import { UpgradeSubscriptionDto } from './dto/upgrade-subscription.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { ProvisioningService } from '../store/provisioning.service';

// Phase 5 (ADR-021): client workspace. One module, one shared service, two
// controllers — /client/* (any authenticated, ownership enforced here) and
// /admin/* (RolesGuard ADMIN at the controller). Client-side lookups always go
// through findMySubscription / where { userId } so another client's id returns
// 404 (no existence leak).
//
// Bloc 1/4 — modèle order-driven : la création ET l'upgrade d'un abonnement
// passent par la procédure de commande (store checkout) ; le paiement vaut
// approbation et le checkout crée/upgrade l'abonnement ACTIVE. La table
// `Service` a été supprimée (Décision c). Ici on ne garde que la lecture
// client, les transitions d'état admin et le helper d'upgrade interne.

// Admin subscription transitions — strict whitelist (approve/reject only from
// PENDING; suspend/activate only between ACTIVE and SUSPENDED).
const SUBSCRIPTION_TRANSITIONS: Record<
  string,
  { to: SubscriptionStatus; action: string }
> = {
  [`${SubscriptionStatus.PENDING}->${SubscriptionStatus.ACTIVE}`]: {
    to: SubscriptionStatus.ACTIVE,
    action: 'subscription.approve',
  },
  [`${SubscriptionStatus.PENDING}->${SubscriptionStatus.REJECTED}`]: {
    to: SubscriptionStatus.REJECTED,
    action: 'subscription.reject',
  },
  [`${SubscriptionStatus.ACTIVE}->${SubscriptionStatus.SUSPENDED}`]: {
    to: SubscriptionStatus.SUSPENDED,
    action: 'subscription.suspend',
  },
  [`${SubscriptionStatus.SUSPENDED}->${SubscriptionStatus.ACTIVE}`]: {
    to: SubscriptionStatus.ACTIVE,
    action: 'subscription.activate',
  },
};

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
  ) {}

  // ───────────────────────── Client-scoped ─────────────────────────────────

  /** Look up a subscription that MUST belong to the actor (404 otherwise). */
  private async findMySubscription(id: string, userId: string): Promise<Subscription> {
    const sub = await this.prisma.subscription.findFirst({
      where: { id, userId },
    });
    if (!sub) {
      throw new NotFoundException('Souscription introuvable.');
    }
    return sub;
  }

  /** USER: list own subscriptions (product included). */
  async listMySubscriptions(actor: Actor) {
    return this.prisma.subscription.findMany({
      where: { userId: actor.sub },
      include: {
        product: { select: { id: true, name: true, kind: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * User: mis à niveau d'une souscription ACTIVE vers un autre produit/pack.
   * Helper INTERNE idempotent — la MÊME ligne d'abonnement est basculée
   * (createdAt, données et apps préservés — aucune suppression). Le checkout
   * store (Bloc 1) est le seul chemin public : il repointe l'abonnement puis
   * `syncAppLimits` ré-applique les nouvelles limites (Bloc 2). Aucune route
   * publique ne l'expose (Décision 3 : tout passe par la commande).
   */
  async upgradeMySubscription(
    id: string,
    dto: UpgradeSubscriptionDto,
    actor: Actor,
  ): Promise<Subscription> {
    const sub = await this.findMySubscription(id, actor.sub);
    if (sub.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException(
        'Seule une souscription ACTIVE peut être mise à niveau.',
      );
    }
    if (sub.productId === dto.productId) {
      throw new BadRequestException(
        'Cette souscription est déjà liée à ce produit.',
      );
    }
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { pack: true },
    });
    if (!product) {
      throw new NotFoundException('Produit introuvable.');
    }
    if (
      product.status === ProductStatus.DRAFT ||
      product.status === ProductStatus.DISABLED
    ) {
      throw new BadRequestException(
        'Ce produit n’est pas disponible à la souscription.',
      );
    }
    if (!product.pack || product.pack.status !== PackStatus.ACTIVE) {
      throw new BadRequestException('Le pack de ce produit n’est pas actif.');
    }
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: { productId: dto.productId },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'subscription.upgrade',
      resourceType: 'subscription',
      resourceId: id,
      details: {
        fromProductId: sub.productId,
        toProductId: dto.productId,
        toProductName: product.name,
        toPackName: product.pack.name,
        toMaxApps: product.pack.maxApps,
      },
    });
    return updated;
  }

  /** USER: cancel an own ACTIVE/SUSPENDED subscription → CANCELLED. */
  async cancelMySubscription(id: string, actor: Actor): Promise<Subscription> {
    const sub = await this.findMySubscription(id, actor.sub);
    if (
      sub.status !== SubscriptionStatus.ACTIVE &&
      sub.status !== SubscriptionStatus.SUSPENDED &&
      sub.status !== SubscriptionStatus.PENDING
    ) {
      throw new BadRequestException(
        'Cette souscription ne peut pas être annulée.',
      );
    }
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: { status: SubscriptionStatus.CANCELLED },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'subscription.cancel',
      resourceType: 'subscription',
      resourceId: id,
      details: { from: sub.status },
    });
    return updated;
  }

  // ────────────────────────── Admin-scoped ─────────────────────────────────

  /**
   * ADMIN: list every subscription (Bloc 5 refonte — table « Abonnements »).
   * Chaque ligne porte : client, produit, pack (limites), commande liée (order
   * store) et apps déployées (Deployment) pour un aperçu complet de l'admin.
   */
  async listAllSubscriptions() {
    return this.prisma.subscription.findMany({
      include: {
        product: {
          select: {
            id: true,
            name: true,
            kind: true,
            status: true,
            pack: {
              select: {
                id: true,
                name: true,
                ramMb: true,
                cpuCores: true,
                maxApps: true,
                storageLimit: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            // NB : la table `Service` a disparu (Bloc 4) — les apps du client
            // sont les Deployment, résolus depuis le pack ACTIF du client.
            deployments: {
              select: {
                id: true,
                repoFullName: true,
                appName: true,
                status: true,
                fqdn: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
        order: {
          select: {
            id: true,
            productName: true,
            status: true,
            amountTtcCents: true,
            currency: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** ADMIN: apply a whitelisted subscription status transition. */
  async updateSubscription(
    id: string,
    dto: UpdateSubscriptionDto,
    actor: Actor,
  ): Promise<Subscription> {
    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) {
      throw new NotFoundException('Souscription introuvable.');
    }
    if (dto.status === sub.status) {
      return sub; // idempotent
    }
    const transition = SUBSCRIPTION_TRANSITIONS[`${sub.status}->${dto.status}`];
    if (!transition) {
      throw new BadRequestException(
        `Transition ${sub.status} → ${dto.status} non autorisée.`,
      );
    }
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: { status: transition.to },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: transition.action,
      resourceType: 'subscription',
      resourceId: id,
      details: { from: sub.status, to: transition.to, productId: sub.productId },
    });
    return updated;
  }

  /**
   * ADMIN: ré-synchronise les limites RAM/CPU du pack actif sur les apps déjà
   * déployées de l'abonné (Bloc 2/3 — action « Ré-synchroniser les ressources »).
   * Délègue à ProvisioningService.syncAppLimits (resize best-effort par app,
   * données préservées). Lève NotFound si la souscription n'existe pas.
   */
  async syncSubscriptionLimits(id: string) {
    await this.prisma.subscription.findUniqueOrThrow({ where: { id } });
    return this.provisioning.syncAppLimits(id);
  }
}