import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  HostingServiceAllocationStatus,
  PackStatus,
  Prisma,
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
import {
  SuspensionEffectsService,
  SuspensionEffectsSummary,
  applyHostingStatusInTx,
} from '../store/suspension-effects.service';

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
    private readonly effects: SuspensionEffectsService,
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

  /**
   * B0.7 — apps hébergées encore rattachées à CETTE souscription : par la
   * commande qui l'a créée (`orderId`) et/ou par le pack de son produit
   * (`packId`). Les deux critères sont scopés sur `userId` (jamais de compte
   * d'un autre client). 0 ⇒ aucune condition de blocage.
   */
  private async countLinkedDeployments(
    userId: string,
    sub: Pick<Subscription, 'orderId' | 'productId'>,
  ): Promise<number> {
    const product = await this.prisma.product.findUnique({
      where: { id: sub.productId },
      select: { packId: true },
    });
    const packId = product?.packId ?? null;
    if (!sub.orderId && !packId) return 0;
    const where: Prisma.DeploymentWhereInput =
      sub.orderId && packId
        ? { userId, OR: [{ orderId: sub.orderId }, { packId }] }
        : sub.orderId
          ? { userId, orderId: sub.orderId }
          : { userId, packId: packId! };
    return this.prisma.deployment.count({ where });
  }

  /** USER: list own subscriptions (product included). */
  async listMySubscriptions(actor: Actor) {
    return this.prisma.subscription.findMany({
      where: { userId: actor.sub },
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
                storageLimit: true,
                maxApps: true,
                deploymentModule: { select: { id: true, code: true, name: true } },
              },
            },
          },
        },
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

  /**
   * USER: cancel an own ACTIVE/SUSPENDED subscription → CANCELLED.
   * B0.7 — l'annulation est REFUSÉE tant que des applications hébergées sont
   * encore rattachées à la souscription (Deployment.orderId) ou à SON pack
   * (Deployment.packId) : annuler laisserait des apps orphelines sans abonnement
   * actif. Aucune écriture n'a lieu quand le refus s'applique (fail-closed).
   */
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
    const linked = await this.countLinkedDeployments(actor.sub, sub);
    if (linked > 0) {
      throw new ConflictException(
        `Annulation impossible : ${linked} application(s) hébergée(s) sont encore rattachées à cette souscription. Supprimez-les d'abord depuis votre espace client.`,
      );
    }

    // ── 17B.4F-C4 (D10) — gate d'annulation ATOMIQUE ──────────────────────
    // Aucune écriture (ni transition Subscription) tant qu'une allocation est
    // consommante (RESERVED/BOUND/RELEASING) ou qu'un service hébergement de
    // cette souscription n'est pas terminé (CANCELLED). Verrous dans l'ordre
    // global User → HostingService (le checkout et les réservations prennent
    // le verrou Service avant les allocations → pas de fenêtre concurrente).
    // Zéro nettoyage silencieux. La transition Subscription vit dans la MÊME
    // TX : sous OFF/C3, la table `HostingServiceAllocation` absente ⇒ skip
    // silencieux (compat pré-C1, contrat historique inchangé).
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.sub} FOR UPDATE`;
      const tables = await tx.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'HostingServiceAllocation'
        ) AS "exists"`;
      if (tables[0]?.exists) {
        const services = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT "id", "status" FROM "HostingService"
          WHERE "subscriptionId" = ${sub.id} OR "orderId" = ${sub.orderId ?? ''}
          FOR UPDATE`;
        if (services.length > 0) {
          const consuming = await tx.hostingServiceAllocation.count({
            where: {
              hostingServiceId: { in: services.map((s) => s.id) },
              status: {
                in: [
                  HostingServiceAllocationStatus.RESERVED,
                  HostingServiceAllocationStatus.BOUND,
                  HostingServiceAllocationStatus.RELEASING,
                ],
              },
            },
          });
          if (consuming > 0) {
            throw new ConflictException(
              `Annulation impossible : ${consuming} slot(s) d'hébergement encore consommant(s) sur cette souscription. Libérez-les d'abord (suppression des apps ou support).`,
            );
          }
          const nonTerminal = services.filter(
            (s) => s.status !== 'CANCELLED',
          ).length;
          if (nonTerminal > 0) {
            throw new ConflictException(
              `Annulation impossible : ${nonTerminal} service(s) hébergement non terminé(s) sur cette souscription. Laissez la libération aboutir (ou contactez le support).`,
            );
          }
        }
      }
      return tx.subscription.update({
        where: { id },
        data: { status: SubscriptionStatus.CANCELLED },
      });
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

  /**
   * ADMIN: apply a whitelisted subscription status transition.
   *
   * Q5 (GO item 5) — transition SOUS VERROU : la ligne est verrouillée
   * `FOR UPDATE`, la transition est RECALCULÉE sur l'état lu sous verrou (deux
   * actions concurrentes → une seule gagne, jamais de transition sautée) ;
   * les services hébergement de CETTE souscription basculent dans la MÊME
   * transaction (ACTIVE ↔ SUSPENDED, probe schéma) ; les effets provider
   * (arrêt/relance des apps — réversibles, AUCUNE suppression) sont exécutés
   * post-commit et RETOURNÉS dans `effects` : blocages/échecs sont visibles
   * (audits `suspension.app_*`) et RÉJOUABLES en relançant l'action.
   *
   * Réactivation (SUSPENDED → ACTIVE) = « réactivation contrôlée » (GO) :
   * aucun encaissement ni écriture de facture — sans double facturation.
   */
  async updateSubscription(
    id: string,
    dto: UpdateSubscriptionDto,
    actor: Actor,
  ): Promise<Subscription & { effects?: SuspensionEffectsSummary }> {
    const existing = await this.prisma.subscription.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Souscription introuvable.');
    }
    if (dto.status === existing.status) {
      return existing; // idempotent
    }

    const committed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; status: SubscriptionStatus; orderId: string | null }>
      >`SELECT "id", "status", "orderId" FROM "Subscription" WHERE "id" = ${id} FOR UPDATE`;
      const cur = rows[0];
      if (!cur) {
        throw new NotFoundException('Souscription introuvable.');
      }
      if (cur.status === dto.status) {
        return { raced: true as const, from: cur.status, to: cur.status, orderId: cur.orderId };
      }
      // Transition RECALCULÉE sous verrou (jamais l'état lu avant verrou).
      const transition = SUBSCRIPTION_TRANSITIONS[`${cur.status}->${dto.status}`];
      if (!transition) {
        throw new BadRequestException(
          `Transition ${cur.status} → ${dto.status} non autorisée.`,
        );
      }
      const cas = await tx.subscription.updateMany({
        where: { id, status: cur.status },
        data: { status: transition.to },
      });
      if (cas.count !== 1) {
        return null; // perdu la course — l'état committé est relu ci-dessous
      }
      // Services hébergement du SEUL abonnement concerné, MÊME transaction.
      // Seules les VRAIES paires (SUSPENDRE / RÉACTIVER) basculent les
      // services : PENDING→ACTIVE (approbation) ne touche aucune app.
      if (cur.status === SubscriptionStatus.ACTIVE && transition.to === SubscriptionStatus.SUSPENDED) {
        await applyHostingStatusInTx(tx, id, 'ACTIVE', 'SUSPENDED');
      } else if (
        cur.status === SubscriptionStatus.SUSPENDED &&
        transition.to === SubscriptionStatus.ACTIVE
      ) {
        await applyHostingStatusInTx(tx, id, 'SUSPENDED', 'ACTIVE');
      }
      return {
        raced: false as const,
        from: cur.status,
        to: transition.to,
        action: transition.action,
        orderId: cur.orderId,
      };
    });

    if (!committed) {
      // Course perdue : on relit — si l'action est déjà appliquée, idempotent.
      const fresh = await this.prisma.subscription.findUnique({ where: { id } });
      if (fresh && fresh.status === dto.status) return fresh;
      throw new ConflictException('Transition concurrente — réessayez.');
    }
    if (committed.raced) {
      const fresh = await this.prisma.subscription.findUnique({ where: { id } });
      if (fresh) return fresh;
      throw new NotFoundException('Souscription introuvable.');
    }

    const updated = await this.prisma.subscription.findUniqueOrThrow({ where: { id } });

    // Effets provider POST-COMMIT (jamais dans la TX) — jamais de suppression.
    // Même paire que les services : seul un VRAI suspendre/réactiver déclenche
    // un appel provider (l'approbation PENDING→ACTIVE n'arrête/relance rien).
    let effects: SuspensionEffectsSummary | undefined;
    try {
      if (
        committed.from === SubscriptionStatus.ACTIVE &&
        committed.to === SubscriptionStatus.SUSPENDED
      ) {
        effects = await this.effects.suspendApps({
          subscriptionId: id,
          holder: actor.sub,
          orderId: committed.orderId,
        });
      } else if (
        committed.from === SubscriptionStatus.SUSPENDED &&
        committed.to === SubscriptionStatus.ACTIVE
      ) {
        effects = await this.effects.resumeApps({
          subscriptionId: id,
          holder: actor.sub,
          orderId: committed.orderId,
        });
      }
    } catch (e) {
      // L'état committé est la vérité : l'échec d'effet reste visible (audit).
      await this.audit
        .record({
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'suspension.effects_failed',
          resourceType: 'subscription',
          resourceId: id,
          details: { to: committed.to, error: String(e) },
        })
        .catch(() => undefined);
    }

    const details: Prisma.InputJsonObject = {
      from: committed.from,
      to: committed.to,
      productId: existing.productId,
      ...(effects ? { effects: { ...effects } } : {}),
    };
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: committed.action,
      resourceType: 'subscription',
      resourceId: id,
      details,
    });
    return effects ? { ...updated, effects } : updated;
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