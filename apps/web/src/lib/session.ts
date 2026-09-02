'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchMe, getSessionToken, Me } from '@/lib/api';

export type SessionPhase = 'loading' | 'denied' | 'ready';

/** Role ladder (mirror of apps/api auth/roles.ts ROLE_RANK). */
export const ROLE_RANK: Record<string, number> = {
  USER: 0,
  SUPPORT_L1: 1,
  SUPPORT_L2: 2,
  SUPPORT_L3: 3,
  ADMIN: 99,
};
export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? -1;
}
export function isSupportRole(role: string): boolean {
  return roleRank(role) >= 1 && roleRank(role) < 99;
}
export function isAdminRole(role: string): boolean {
  return role === 'ADMIN';
}

export const ROLE_LABEL: Record<string, string> = {
  USER: 'Client',
  SUPPORT_L1: 'Support L1',
  SUPPORT_L2: 'Support L2',
  SUPPORT_L3: 'Support L3',
  ADMIN: 'Administrateur',
};
export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

interface Session {
  phase: SessionPhase;
  me: Me | null;
  token: string;
}

async function bootstrap(
  requireRank: number,
  router: ReturnType<typeof useRouter>,
): Promise<Session> {
  const t = await getSessionToken();
  if (!t) {
    router.replace('/auth');
    return { phase: 'denied', me: null, token: '' };
  }
  const m = await fetchMe(t);
  if (!m || roleRank(m.role) < requireRank) {
    return { phase: 'denied', me: null, token: '' };
  }
  return { phase: 'ready', me: m, token: t };
}

function useBootstrap(requireRank: number) {
  const router = useRouter();
  const [session, setSession] = useState<Session>({ phase: 'loading', me: null, token: '' });

  useEffect(() => {
    (async () => {
      const s = await bootstrap(requireRank, router);
      setSession(s);
    })();
  }, [router, requireRank]);

  return session;
}

/** Any authenticated user (client workspace, profile) — accept role USER+ */
export function useAnySession() {
  return useBootstrap(ROLE_RANK.USER);
}

/** Support staff (L1/L2/L3) — the support console. */
export function useSupportSession() {
  return useBootstrap(ROLE_RANK.SUPPORT_L1);
}

/** Admin console. */
export function useAdminSession() {
  return useBootstrap(ROLE_RANK.ADMIN);
}
