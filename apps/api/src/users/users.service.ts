import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { UpdateUserDto } from './dto/update-user.dto';

export type PublicUser = Omit<User, 'passwordHash'>;

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
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
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

  private toPublic(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}