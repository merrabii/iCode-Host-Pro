import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthedRequest } from '../guards/jwt-auth.guard';
import { JwtPayload } from '../types';

/** Returns the authenticated user's JWT payload attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.user;
  },
);