// Thin client-side API helpers for the web app (Phase 2, ADR-017; extended Phase 3).
// Auth: an access token is minted from the httpOnly refresh cookie via
// POST /api/auth/refresh (credentials:'include') — NO token is ever stored in
// localStorage. The refresh endpoint rotates the cookie; the browser stores the
// new Set-Cookie automatically.

export interface Me {
  id: string;
  email: string;
  name?: string | null;
  role: string;
}

export interface ManagerSummary {
  products: { total: number; byStatus: Record<string, number> };
  servers: { total: number; byStatus: Record<string, number> };
  users: { total: number; active: number; byRole: Record<string, number> };
}

export interface UserAdmin {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  isActive: boolean;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** Mint an access token from the httpOnly refresh cookie, or null if not authed. */
export async function getAccessToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    return data.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Fetch the current user profile (public, no passwordHash). */
export async function fetchMe(token: string): Promise<Me | null> {
  try {
    const res = await fetch('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}

/** Authed JSON request; returns {ok,status,data} with a best-effort parsed body. */
export async function apiJson(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, data };
}

/** Best-effort error message from an ApiResult, falling back to a default. */
export function apiError(res: ApiResult, fallback: string): string {
  const d = res.data as { message?: string } | null;
  if (d?.message) return String(d.message);
  return fallback;
}

// Admin (Phase 3) helpers.
export const listUsers = (t: string) => apiJson('/api/users', t);
export const updateUser = (t: string, id: string, patch: { role?: string; isActive?: boolean }) =>
  apiJson(`/api/users/${id}`, t, { method: 'PATCH', body: JSON.stringify(patch) });
export const getManagerSummary = (t: string) => apiJson('/api/manager/summary', t);