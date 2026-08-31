import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, User } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';

export type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
   */
  async update(id: string, dto: UpdateUserDto, actorId: string): Promise<PublicUser> {
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
      if (user.id === actorId) {
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
    return this.toPublic(updated);
  }

  private toPublic(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}