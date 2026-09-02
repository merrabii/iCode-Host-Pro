import { Role } from '@prisma/client';

/**
 * Linear support ladder (Phase 10, ADR-027):
 * USER < SUPPORT_L1 < SUPPORT_L2 < SUPPORT_L3 < ADMIN.
 * Single source of truth for the role ordering — shared by RolesGuard,
 * the tickets module, the support console and any rank-aware web hook.
 */
export const ROLE_RANK: Record<Role, number> = {
  [Role.USER]: 0,
  [Role.SUPPORT_L1]: 1,
  [Role.SUPPORT_L2]: 2,
  [Role.SUPPORT_L3]: 3,
  [Role.ADMIN]: 99,
};

/** Numeric rank of a role (-1 for anything unexpected). */
export function roleRank(role: Role): number {
  return ROLE_RANK[role] ?? -1;
}

/** True when `actor`'s rank meets or exceeds the required ranking. */
export function meetsRole(actor: Role, required: Role): boolean {
  return roleRank(actor) >= roleRank(required);
}

/**
 * The support tier ranks, ordered low→high (L1 first). Useful to list which
 * support levels outrank a user for ticket escalation targets.
 */
export const SUPPORT_LADDER: Role[] = [
  Role.SUPPORT_L1,
  Role.SUPPORT_L2,
  Role.SUPPORT_L3,
];