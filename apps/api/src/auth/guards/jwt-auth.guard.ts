import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { ALLOW_IMPERSONATION_KEY } from '../decorators/allow-impersonation.decorator';
import { JwtPayload } from '../types';

export type AuthedRequest = Request & { user: JwtPayload };

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Verifies the Bearer access token and attaches the JWT payload to req.user.
 *
 * Phase 10 (ADR-027) — impersonation is READ-ONLY by construction: a token
 * carrying `imp` (admin/support "as client" session) is refused on every
 * mutating verb unless the route explicitly opts out with
 * `@AllowImpersonationMutation()` (only the impersonation self-cleanup
 * endpoint does). This is the last line of defense after the role-USER pin
 * and the missing refresh cookie.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice(7);
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.imp) {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_IMPERSONATION_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed && MUTATING_METHODS.includes(req.method)) {
        throw new ForbiddenException(
          'Session d’impersonation en lecture seule — action refusée.',
        );
      }
    }

    req.user = payload;
    return true;
  }
}
