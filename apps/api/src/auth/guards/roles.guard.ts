import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuthedRequest } from './jwt-auth.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { roleRank } from '../roles';

/**
 * Enforces @Roles() metadata on routes using RANK semantics (ADR-027): a route
 * declaring `@Roles(Role.ADMIN)` is satisfied by any role whose rank is >=
 * ADMIN (i.e. nothing but ADMIN); `@Roles(Role.SUPPORT_L1)` is satisfied by
 * L1/L2/L3/ADMIN. A route with no @Roles() metadata allows anyone through.
 * Anti-escalation: an impersonation JWT is signed with role: USER (rank 0), so
 * it can never clear any support/admin requirement.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const actorRank = roleRank(req.user.role);
    return required.some((r) => actorRank >= roleRank(r));
  }
}