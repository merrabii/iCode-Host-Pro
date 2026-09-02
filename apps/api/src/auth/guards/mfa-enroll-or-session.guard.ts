import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtAuthGuard, AuthedRequest } from './jwt-auth.guard';

/**
 * Phase 10 (ADR-027): accepts BOTH a normal session bearer (self-service MFA on
 * /profil) AND a short-lived `mfaEnroll` token (issued by login when the admin
 * policy requires MFA but the admin has none — no session tokens are granted).
 * Impersonation sessions are always refused: an impersonator must never touch
 * MFA enrollment.
 */
@Injectable()
export class MfaEnrollOrSessionGuard extends JwtAuthGuard {
  override async canActivate(context: Parameters<JwtAuthGuard['canActivate']>[0]): Promise<boolean> {
    const ok = await super.canActivate(context);
    if (!ok) return false;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user.imp) {
      throw new ForbiddenException(
        'Enrollment MFA impossible en session d’impersonation.',
      );
    }
    if (req.user.mfaEnroll) {
      return true;
    }
    // A normal session token with no mfaEnroll flag is fine for self-service too.
    return true;
  }
}
