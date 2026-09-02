import { Role } from '@prisma/client';

/** Who initiated an impersonation session (Phase 10, ADR-027). */
export interface ImpersonationMeta {
  by: string; // real actor's user id
  kind: 'admin' | 'support';
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  /** Present only on impersonation sessions — forces READ-ONLY + pinning to
   *  role USER (anti-escalation) and carries no refresh row/cookie. */
  imp?: ImpersonationMeta;
  /** Present only on short-lived admin MFA-enrollment tokens (policy requires
   *  MFA but the admin has none yet). These can ONLY hit the MFA setup/confirm
   *  endpoints (MfaEnrollOrSessionGuard) — no session is granted. */
  mfaEnroll?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  /** Empty string when the flow must NOT set a refresh cookie (impersonation). */
  refreshToken: string;
}

/** Login response that may demand an extra MFA step before tokens are issued. */
export type LoginResult =
  | AuthTokens
  | { mfaRequired: true; challengeId: string; methods: ('totp' | 'email')[] }
  | { mfaRequired: false; enroll: true; enrollToken: string };