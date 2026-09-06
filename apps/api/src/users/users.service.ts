import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { DeploymentsService } from '../deployments/deployments.service';

// Public shape NEVER carries passwordHash nor the at-rest secrets (MFA TOTP
// secret, GitHub token). mfaEnabled/oauthProvider are the safe public signals.
// Phase 13: inclut clientProject pour Module B (projet Coolify dédié).
export type PublicUser = Omit<User, 'passwordHash' | 'mfaSecretEnc' | 'githubTokenEnc'> & {
  clientProject?: { id: string; name: string; projectUuid: string } | null;
};

/** The authenticated actor performing an admin action (JwtPayload shaped). */
export interface Actor {
  sub: string;
  email: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deployments: DeploymentsService,
  ) {}

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toPublic(user);
  }

  /** Admin: list every account (public shape, no passwordHash). */
  async findAll(): Promise<PublicUser[]> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        clientProjects: {
          include: { module: true },
          where: { module: { kind: 'PER_CLIENT_PROJECT' } },
          take: 1, // un client peut avoir un seul projet Module B par serveur/module
        },
      },
    });
    return users.map((u) => this.toPublic(u));
  }

  /**
   * Admin: update role and/or active state with platform lock-out guards.
   * - The guards only apply when the change REMOVES an ACTIVE admin. Demoting or
   *   deactivating an already-inactive admin never reduces the active-admin pool,
   *   so it is always allowed (fixes being unable to demote an inactive admin).
   * - You may never change your own role or deactivate your own active account.
   * - The platform must keep at least one active ADMIN: removing the last active
   *   ADMIN is refused (ForbiddenException).
   * - Every applied change is journaled to the audit log (Phase 4).
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    actor: Actor,
  ): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const nextRole = dto.role ?? user.role;
    const nextActive = dto.isActive ?? user.isActive;
    const isActiveAdmin = user.role === Role.ADMIN && user.isActive;

    // Only a change that removes an ACTIVE admin threatens a lock-out.
    const removingActiveAdmin =
      isActiveAdmin && (nextRole !== Role.ADMIN || nextActive === false);

    if (removingActiveAdmin) {
      // Never allow self-demotion / self-deactivation of an active admin.
      if (user.id === actor.sub) {
        throw new ForbiddenException(
          'Vous ne pouvez pas modifier votre propre rôle ou désactiver votre propre compte.',
        );
      }
      // Keep at least one active platform administrator.
      const activeAdmins = await this.prisma.user.count({
        where: { role: Role.ADMIN, isActive: true },
      });
      if (activeAdmins <= 1) {
        throw new ForbiddenException(
          'Impossible : au moins un administrateur actif doit rester sur la plateforme.',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { role: nextRole, isActive: nextActive },
    });

    // Journal the applied changes (one entry per logical transition).
    if (nextRole !== user.role) {
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: user.role === Role.USER ? 'user.promote' : 'user.demote',
        resourceType: 'user',
        resourceId: user.id,
        details: { fromRole: user.role, toRole: nextRole },
      });
    }
    if (nextActive !== user.isActive) {
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: user.isActive ? 'user.deactivate' : 'user.activate',
        resourceType: 'user',
        resourceId: user.id,
        details: { fromActive: user.isActive, toActive: nextActive },
      });
    }

    return this.toPublic(updated);
  }

  private toPublic(user: User & { clientProjects?: Array<{ id: string; name: string; projectUuid: string; module: { kind: string } }> }): PublicUser {
    const {
      passwordHash: _passwordHash,
      mfaSecretEnc: _mfaSecretEnc,
      githubTokenEnc: _githubTokenEnc,
      clientProjects: _clientProjects,
      ...rest
    } = user;
    // Phase 13: inclure le premier clientProject de type PER_CLIENT_PROJECT
    const cp = user.clientProjects?.find((p) => p.module.kind === 'PER_CLIENT_PROJECT');
    const clientProject = cp ? { id: cp.id, name: cp.name, projectUuid: cp.projectUuid } : null;
    return { ...rest, clientProject };
  }

  /**
   * Crée le projet Coolify dédié du client (Module B) — admin action.
   * Appelle getOrCreateClientProject qui est idempotent (POST /projects + @@unique).
   */
  async createClientProject(
    userId: string,
    actor: Actor,
  ): Promise<{ id: string; name: string; projectUuid: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Récupère l'abonnement ACTIVE → produit → pack → module
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: {
        product: {
          include: {
            pack: {
              include: {
                deploymentModule: { include: { server: true } },
              },
            },
          },
        },
      },
    });
    if (!sub?.product?.pack?.deploymentModule) {
      throw new NotFoundException(
        'Aucun module de déploiement configuré sur le pack actif du client.',
      );
    }

    const module = sub.product.pack.deploymentModule;
    if (module.kind !== 'PER_CLIENT_PROJECT') {
      throw new ForbiddenException(
        'Le module du pack n\'est pas de type "projet par client" (Module B).',
      );
    }
    if (!module.server) {
      throw new NotFoundException('Le module n\'a pas de serveur Coolify configuré.');
    }

    const result = await this.deployments.getOrCreateClientProject(
      userId,
      module.server,
      module,
    );

    // Audit log
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'clientProject.create',
      resourceType: 'clientProject',
      resourceId: result.id,
      details: { userId, moduleId: module.id, projectUuid: result.projectUuid },
    });

    return { id: result.id, name: `${module.perClientPrefix}-${userId}`, projectUuid: result.projectUuid };
  }
}