import { SetMetadata } from '@nestjs/common';

export const ALLOW_IMPERSONATION_KEY = 'allowImpersonationMutation';

/**
 * Opts a mutating route OUT of the impersonation read-only block. Used ONLY on
 * the impersonation self-cleanup endpoints (e.g. POST /auth/impersonate/return),
 * which must be callable with an impersonation Bearer token present.
 */
export const AllowImpersonationMutation = () =>
  SetMetadata(ALLOW_IMPERSONATION_KEY, true);