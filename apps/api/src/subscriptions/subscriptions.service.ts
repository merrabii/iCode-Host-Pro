import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ProductStatus,
  Service,
  ServiceStatus,
  Subscription,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../users/users.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

// Phase 5 (ADR-021): client workspace. One module, one shared service, two
// controllers — /client/* (any authenticated, ownership enforced here) and
// /admin/* (RolesGuard ADMIN at the controller). Client-side lookups always go
// through findMySubscription / where { userId } so another client's id returns
// 404 (no existence leak). Provisioning is a STATUS-TRANSITION STUB: no real
// provider deploy (ADR-010) and no async jobs (ADR-007), still out of scope.

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

// Admin service transitions — provisioning is a stub two-step path.
const SERVICE_TRANSITIONS: Record<
  string,
  { to: ServiceStatus; action: string }
> = {
  [`${ServiceStatus.REQUESTED}->${ServiceStatus.PROVISIONING}`]: {
    to: ServiceStatus.PROVISIONING,
    action: 'service.provision',
  },
  [`${ServiceStatus.PROVISIONING}->${ServiceStatus.ACTIVE}`]: {
    to: ServiceStatus.ACTIVE,
    action: 'service.activate',
  },
};

// `select` shape for a service returned after an admin update (relations +
// scalars; used with select, since include cannot mix scalar fields).
const SERVICE_SELECT = {
  id: true,
  name: true,
  status: true,
  serverId: true,
  createdAt: true,
  updatedAt: true,
  subscriptionId: true,
  subscription: {
    select: {
      id: true,
      status: true,
      product: { select: { id: true, name: true } },
      user: {
        select: { id: true, email: true, name: true },
      },
    },
  },
  server: { select: { id: true, name: true, hostname: true } },
} as const;

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

  /** USER: subscribe to a visible product → PENDING. */
  async createSubscription(
    dto: CreateSubscriptionDto,
    actor: Actor,
  ): Promise<Subscription> {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
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
    const subscription = await this.prisma.subscription.create({
      data: { userId: actor.sub, productId: dto.productId },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'subscription.create',
      resourceType: 'subscription',
      resourceId: subscription.id,
      details: { productId: dto.productId, productName: product.name },
    });
    return subscription;
  }

  /** USER: list own subscriptions (product + services included). */
  async listMySubscriptions(actor: Actor) {
    return this.prisma.subscription.findMany({
      where: { userId: actor.sub },
      include: {
        product: { select: { id: true, name: true, kind: true, status: true } },
        services: { select: { id: true, name: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** USER: cancel an own PENDING/ACTIVE/SUSPENDED subscription → CANCELLED. */
  async cancelMySubscription(id: string, actor: Actor): Promise<Subscription> {
    const sub = await this.findMySubscription(id, actor.sub);
    if (
      sub.status !== SubscriptionStatus.PENDING &&
      sub.status !== SubscriptionStatus.ACTIVE &&
      sub.status !== SubscriptionStatus.SUSPENDED
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

  /** USER: request a Service under an own ACTIVE subscription → REQUESTED. */
  async createMyService(dto: CreateServiceDto, actor: Actor): Promise<Service> {
    const sub = await this.findMySubscription(dto.subscriptionId, actor.sub);
    if (sub.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException(
        'Souscription non active : impossible de demander un service.',
      );
    }
    const service = await this.prisma.service.create({
      data: { name: dto.name, subscriptionId: sub.id },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'service.request',
      resourceType: 'service',
      resourceId: service.id,
      details: { name: service.name, subscriptionId: sub.id },
    });
    return service;
  }

  /**
   * USER: list own services. Deliberately WITHOUT the server — the client never
   * sees infrastructure (ADR-021), so serverId/server are not exposed here (the
   * scalar serverId is excluded via an explicit select).
   */
  async listMyServices(actor: Actor) {
    return this.prisma.service.findMany({
      where: { subscription: { userId: actor.sub } },
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        subscription: {
          select: { id: true, product: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ────────────────────────── Admin-scoped ─────────────────────────────────

  /** ADMIN: list every subscription (client, product + services). */
  async listAllSubscriptions() {
    return this.prisma.subscription.findMany({
      include: {
        product: { select: { id: true, name: true, kind: true, status: true } },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
          },
        },
        services: { select: { id: true, name: true, status: true } },
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

  /** ADMIN: list every service (client, product + assigned server). */
  async listAllServices() {
    return this.prisma.service.findMany({
      include: {
        subscription: {
          include: {
            user: {
              select: { id: true, email: true, name: true },
            },
            product: { select: { id: true, name: true } },
          },
        },
        server: { select: { id: true, name: true, hostname: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** ADMIN: assign a server and/or advance the (stubbed) provisioning status. */
  async updateService(id: string, dto: UpdateServiceDto, actor: Actor) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: { server: true },
    });
    if (!service) {
      throw new NotFoundException('Service introuvable.');
    }

    // Server assignment (client never does this).
    if (dto.serverId !== undefined && dto.serverId !== service.serverId) {
      if (dto.serverId !== null) {
        const server = await this.prisma.server.findUnique({
          where: { id: dto.serverId },
        });
        if (!server) {
          throw new BadRequestException('Serveur introuvable.');
        }
      }
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: dto.serverId ? 'service.assign' : 'service.remove',
        resourceType: 'service',
        resourceId: id,
        details: { from: service.serverId, to: dto.serverId },
      });
    }

    // Status advancement (whitelisted stub path).
    if (dto.status === undefined || dto.status === service.status) {
      return this.prisma.service.update({
        where: { id },
        data: { serverId: dto.serverId },
        select: SERVICE_SELECT,
      });
    }
    const transition = SERVICE_TRANSITIONS[`${service.status}->${dto.status}`];
    if (!transition) {
      throw new BadRequestException(
        `Transition ${service.status} → ${dto.status} non autorisée.`,
      );
    }
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: transition.action,
      resourceType: 'service',
      resourceId: id,
      details: { from: service.status, to: transition.to, name: service.name },
    });
    return this.prisma.service.update({
      where: { id },
      data: { status: transition.to, serverId: dto.serverId },
      select: SERVICE_SELECT,
    });
  }
}
