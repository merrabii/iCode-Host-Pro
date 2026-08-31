import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

/** The authenticated actor performing the action (JwtPayload shaped). */
export interface Actor {
  sub: string;
  email: string;
}

export type InvitationStatus = 'pending' | 'used' | 'revoked' | 'expired';

// Phase 5 (ADR-020): public self-registration is CLOSED. New USER accounts are
// created only through an ADMIN-issued invitation: one raw one-time token per
// email (sha256-hashed at rest, like refresh tokens), returned to the admin
// exactly once (surfaced in /manager until an email strategy exists) —
// surfaced to the manager page, then validated on acceptance.
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private ttlDays(): number {
    return this.config.get<number>('inviteExpiresInDays') ?? 7;
  }

  private statusOf(inv: {
    usedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): InvitationStatus {
    if (inv.revokedAt) return 'revoked';
    if (inv.usedAt) return 'used';
    if (inv.expiresAt < new Date()) return 'expired';
    return 'pending';
  }

  /** ADMIN: issue an invitation for a brand-new email. Returns the raw token once. */
  async create(
    dto: CreateInvitationDto,
    actor: Actor,
  ): Promise<{ id: string; email: string; expiresAt: Date; token: string }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException('Un compte existe déjà avec cet email.');
    }
    const pending = await this.prisma.invitation.findFirst({
      where: { email: dto.email, usedAt: null, revokedAt: null },
    });
    if (pending) {
      throw new ConflictException('Une invitation est déjà en attente pour cet email.');
    }

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.invitation.create({
      data: {
        email: dto.email,
        tokenHash: this.hashToken(token),
        issuerId: actor.sub,
        expiresAt: new Date(Date.now() + this.ttlDays() * 24 * 60 * 60 * 1000),
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'invite.create',
      resourceType: 'invitation',
      resourceId: invitation.id,
      details: { email: dto.email },
    });
    return {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      token,
    };
  }

  /** ADMIN: list all invitations with a derived status. */
  async list(): Promise<Array<{ status: InvitationStatus; [k: string]: unknown }>> {
    const invites = await this.prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((i) => ({ ...i, status: this.statusOf(i) }));
  }

  /** ADMIN: revoke a still-usable invitation (idempotent). */
  async revoke(
    id: string,
    actor: Actor,
  ): Promise<{ id: string; email: string; status: InvitationStatus }> {
    const inv = await this.prisma.invitation.findUnique({ where: { id } });
    if (!inv) {
      throw new NotFoundException('Invitation introuvable.');
    }
    if (inv.usedAt) {
      throw new BadRequestException('Une invitation utilisée ne peut pas être révoquée.');
    }
    if (inv.revokedAt) {
      return { id: inv.id, email: inv.email, status: 'revoked' }; // idempotent
    }
    await this.prisma.invitation.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'invite.revoke',
      resourceType: 'invitation',
      resourceId: inv.id,
      details: { email: inv.email },
    });
    return { id: inv.id, email: inv.email, status: 'revoked' };
  }

  /**
   * Validate a one-time token and create the invited account (role USER).
   * Called by AuthService on POST /api/auth/accept-invite. Returns the created
   * user so the caller can issue tokens; journals invite.accept.
   */
  async consume(
    token: string,
    email: string,
    password: string,
    name?: string,
  ): Promise<User> {
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!inv) throw new BadRequestException('Jeton d’invitation invalide.');
    if (inv.revokedAt) throw new BadRequestException('Cette invitation a été révoquée.');
    if (inv.usedAt) throw new BadRequestException('Cette invitation a déjà été utilisée.');
    if (inv.expiresAt < new Date()) throw new BadRequestException('Cette invitation a expiré.');
    if (inv.email.toLowerCase() !== email.toLowerCase()) {
      throw new BadRequestException('Cet email ne correspond pas à l’invitation.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: inv.email,
        passwordHash,
        name: name ?? null,
        role: Role.USER,
      },
    });
    await this.prisma.invitation.update({
      where: { id: inv.id },
      data: { usedAt: new Date() },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'invite.accept',
      resourceType: 'invitation',
      resourceId: inv.id,
      details: { email: user.email, issuerId: inv.issuerId ?? null },
    });
    return user;
  }
}
