import {
  GoneException,
  Inject,
  Injectable,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { InvitationsService } from '../invitations/invitations.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { AuthTokens, JwtPayload } from './types';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => InvitationsService))
    private readonly invitations: InvitationsService,
  ) {}

  /**
   * Phase 5 (ADR-020): inscription libre fermée. Un compte USER ne se crée plus
   * qu'en acceptant une invitation ADMIN via /auth/accept-invite.
   */
  async register(_dto: RegisterDto): Promise<never> {
    throw new GoneException(
      'Inscription fermée — un compte se crée uniquement via une invitation.',
    );
  }

  /** Accept a one-time invitation and return a fresh token pair (+ refresh cookie). */
  async acceptInvite(dto: AcceptInviteDto): Promise<AuthTokens> {
    const user = await this.invitations.consume(
      dto.token,
      dto.email,
      dto.password,
      dto.name,
    );
    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account disabled');
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
    });
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
    });
    if (
      !record ||
      record.revokedAt !== null ||
      record.expiresAt < new Date()
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotation: revoke the presented token, issue a fresh pair.
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.refresh',
      resourceType: 'user',
      resourceId: user.id,
    });
    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
    });
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (record?.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
      await this.audit.record({
        actorId: record.userId,
        actorEmail: user?.email ?? null,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: record.userId,
      });
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    // Secret + expiration come from the JwtModule config (auth.module.ts), so
    // signing and the JwtAuthGuard verification share the same settings.
    const accessToken = await this.jwt.signAsync(payload);

    const refreshToken = randomBytes(48).toString('base64url');
    const days = this.config.get<number>('refreshExpiresInDays') ?? 30;
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken };
  }
}