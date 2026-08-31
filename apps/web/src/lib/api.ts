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

// Admin (Phase 4) audit journal helpers.
export interface AuditEntry {
  id: string;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  details?: unknown;
  createdAt: string;
}
export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  perPage: number;
}
export interface AuditQuery {
  action?: string;
  resourceType?: string;
  actorId?: string;
  page?: number;
  perPage?: number;
}
export function listAudit(t: string, query: AuditQuery = {}): Promise<ApiResult> {
  const q = new URLSearchParams();
  if (query.action) q.set('action', query.action);
  if (query.resourceType) q.set('resourceType', query.resourceType);
  if (query.actorId) q.set('actorId', query.actorId);
  if (query.page) q.set('page', String(query.page));
  if (query.perPage) q.set('perPage', String(query.perPage));
  const s = q.toString();
  return apiJson(`/api/audit${s ? `?${s}` : ''}`, t);
}

// ── Phase 5 (ADR-020) — invitations ─────────────────────────────────────────
export type InvitationStatus = 'pending' | 'used' | 'revoked' | 'expired';
export interface Invitation {
  id: string;
  email: string;
  expiresAt: string;
  usedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  status: InvitationStatus;
}
export const listInvitations = (t: string) => apiJson('/api/invitations', t);
export const createInvitation = (t: string, email: string) =>
  apiJson('/api/invitations', t, { method: 'POST', body: JSON.stringify({ email }) });
export const revokeInvitation = (t: string, id: string) =>
  apiJson(`/api/invitations/${id}/revoke`, t, { method: 'POST' });

/**
 * Public: accept a one-time invitation (no access token needed — sets the
 * refresh cookie like login does).
 */
export async function acceptInvite(input: {
  token: string;
  email: string;
  password: string;
  name?: string;
}): Promise<ApiResult> {
  try {
    const res = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: String(e) } };
  }
}

/** Build the one-time invite link surfaced in /manager/invitations. */
export function inviteLink(token: string, email: string): string {
  const q = new URLSearchParams({ invite: token, email });
  return `/auth?${q.toString()}`;
}

// ── Phase 5 (ADR-021) — client workspace (Subscription / Service) ───────────
export interface ProductRef {
  id: string;
  name: string;
  kind?: string;
  status?: string;
}
export interface Subscription {
  id: string;
  userId?: string;
  productId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  product?: ProductRef;
  user?: { id: string; email: string; name?: string | null };
  services?: Array<{ id: string; name: string; status: string }>;
}
export interface ServerRef {
  id: string;
  name: string;
  hostname: string;
}
export interface Service {
  id: string;
  name: string;
  status: string;
  subscriptionId: string;
  server?: ServerRef | null;
  subscription?: {
    id: string;
    status?: string;
    product?: ProductRef;
    user?: { id: string; email: string; name?: string | null };
  };
  createdAt: string;
  updatedAt: string;
}

// Client-scoped.
export const listMySubscriptions = (t: string) => apiJson('/api/client/subscriptions', t);
export const createMySubscription = (t: string, productId: string) =>
  apiJson('/api/client/subscriptions', t, { method: 'POST', body: JSON.stringify({ productId }) });
export const cancelMySubscription = (t: string, id: string) =>
  apiJson(`/api/client/subscriptions/${id}/cancel`, t, { method: 'PATCH' });
export const listMyServices = (t: string) => apiJson('/api/client/services', t);
export const createMyService = (t: string, subscriptionId: string, name: string) =>
  apiJson('/api/client/services', t, { method: 'POST', body: JSON.stringify({ subscriptionId, name }) });

// ── Phase 6 (ADR-022) — mail settings + invitation emails ────────────────────
/** Masked view of the SMTP settings — the stored password is NEVER exposed. */
export interface MailSettings {
  id: string | null;
  enabled: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface TestMailResult {
  ok: boolean;
  message?: string;
}
/** Payload returned by createInvitation (token + Phase 6 emailSent flag). */
export interface CreatedInvitation {
  id: string;
  email: string;
  expiresAt: string;
  token: string;
  emailSent: boolean;
}
export const getMailSettings = (t: string) => apiJson('/api/admin/mail', t);
export const updateMailSettings = (t: string, dto: Partial<MailSettings> & { password?: string }) =>
  apiJson('/api/admin/mail', t, { method: 'PUT', body: JSON.stringify(dto) });
export const sendTestMail = (t: string, to: string) =>
  apiJson('/api/admin/mail/test', t, { method: 'POST', body: JSON.stringify({ to }) });

// Admin-scoped.
export const adminListSubscriptions = (t: string) => apiJson('/api/admin/subscriptions', t);
export const adminUpdateSubscription = (t: string, id: string, status: string) =>
  apiJson(`/api/admin/subscriptions/${id}`, t, { method: 'PATCH', body: JSON.stringify({ status }) });
export const adminListServices = (t: string) => apiJson('/api/admin/services', t);
export const adminUpdateService = (
  t: string,
  id: string,
  patch: { status?: string; serverId?: string | null },
) => apiJson(`/api/admin/services/${id}`, t, { method: 'PATCH', body: JSON.stringify(patch) });