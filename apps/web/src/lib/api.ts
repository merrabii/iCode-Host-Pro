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
  // Phase 10 (ADR-027): public security signals — never the at-rest secrets.
  mfaEnabled?: boolean;
  oauthProvider?: string | null;
  oauthSubject?: string | null;
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

// ── Phase 7ter (ADR-024) — gestion admin Serveurs & Produits ─────────────────
export type PanelProvider = 'NONE' | 'HESTIA' | 'COOLIFY' | string;
export interface ServerAdmin {
  id: string;
  name: string;
  hostname: string;
  status: string;
  ipAddress?: string | null;
  port?: number | null;
  provider?: string | null;
  region?: string | null;
  quotaMaxAccounts?: number | null;
  strictTls: boolean;
  panelProvider: PanelProvider;
  // Sonde de connectivité réelle (Phase 8, ADR-025).
  lastCheckedAt?: string | null;
  lastProbeOk?: boolean | null;
  lastProbeDetail?: string | null;
  // Crédentials API panneau (Phase 9, ADR-010) — le jeton n'est JAMAIS exposé.
  apiBaseUrl?: string | null;
  apiUser?: string | null;
  hasApiToken: boolean;
  panelVerifiedAt?: string | null;
  panelOk?: boolean | null;
  panelDetail?: string | null;
  // Métriques annoncées (Phase 9bis) — auto-détectées via le panneau quand c'est
  // possible (Hestia sysinfo), sinon saisies manuellement ; null = inconnu.
  ramMb?: number | null;
  cpuCores?: number | null;
  diskGb?: number | null;
  bandwidthLimit?: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Métriques annoncées auto-détectées par le panneau (Phase 9bis). */
export interface ServerMetrics {
  ramMb?: number;
  cpuCores?: number;
  diskGb?: number;
}
export interface ServerProbe {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  httpStatus?: number;
}
export interface ServerCheckResult {
  server: ServerAdmin;
  probe: ServerProbe;
}
/** Résultat d'une vérification d'API panneau (Phase 9, ADR-010). */
export interface PanelVerifyResult {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  version?: string;
}
export interface ServerPanelVerifyResult {
  server: ServerAdmin;
  result: PanelVerifyResult;
}
export interface ProductAdmin {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface ServerPatch {
  name?: string;
  hostname?: string;
  status?: string;
  ipAddress?: string | null;
  port?: number | null;
  provider?: string | null;
  region?: string | null;
  quotaMaxAccounts?: number | null;
  strictTls?: boolean;
  panelProvider?: PanelProvider;
  // Phase 9 (ADR-010) : config API panneau. `apiToken` est un secret ENTRANT :
  // absent/undefined = inchangé, '' = effacer, sinon remplacé (chiffré au repos).
  apiBaseUrl?: string | null;
  apiUser?: string | null;
  apiToken?: string;
  // Métriques (Phase 9bis) : undefined = inchangé, '' = effacer (bandwidthLimit),
  // null = effacer (champs numériques).
  ramMb?: number | null;
  cpuCores?: number | null;
  diskGb?: number | null;
  bandwidthLimit?: string | null;
}
export const listServers = (t: string) => apiJson('/api/servers', t);
export const createServer = (t: string, dto: ServerPatch & { name: string; hostname: string }) =>
  apiJson('/api/servers', t, { method: 'POST', body: JSON.stringify(dto) });
export const updateServer = (t: string, id: string, patch: ServerPatch) =>
  apiJson(`/api/servers/${id}`, t, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteServer = (t: string, id: string) =>
  apiJson(`/api/servers/${id}`, t, { method: 'DELETE' });
// Phase 8 (ADR-025): sonde de connectivité réelle d'un serveur (ADMIN).
export const checkServer = (t: string, id: string) =>
  apiJson(`/api/servers/${id}/check`, t, { method: 'POST' });
// Phase 9 (ADR-010): vérification de l'API du panneau serveur (Hestia/Coolify).
export const verifyServerPanel = (t: string, id: string) =>
  apiJson(`/api/servers/${id}/panel-verify`, t, { method: 'POST' });
export const listProducts = (t: string) => apiJson('/api/products', t);
export const createProduct = (t: string, dto: { name: string; kind?: string; status?: string }) =>
  apiJson('/api/products', t, { method: 'POST', body: JSON.stringify(dto) });
export const updateProduct = (t: string, id: string, patch: { name?: string; kind?: string; status?: string }) =>
  apiJson(`/api/products/${id}`, t, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteProduct = (t: string, id: string) =>
  apiJson(`/api/products/${id}`, t, { method: 'DELETE' });

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

// ═══ Phase 10 (ADR-027) — sécurité, comptes & support ════════════════════════

// ── Impersonation token (sessionStorage ONLY — never localStorage/URL) ──────
const IMP_TOKEN_KEY = 'ihp_imp_token';
export function setImpToken(token: string): void {
  try {
    sessionStorage.setItem(IMP_TOKEN_KEY, token);
  } catch {
    /* storage indisponible */
  }
}
export function getImpToken(): string | null {
  try {
    return sessionStorage.getItem(IMP_TOKEN_KEY);
  } catch {
    return null;
  }
}
export function clearImpToken(): void {
  try {
    sessionStorage.removeItem(IMP_TOKEN_KEY);
  } catch {
    /* ok */
  }
}

/** Best-effort JWT payload decode (no dependency) — used to read `imp`. */
export interface ImpClaim {
  by: string;
  kind: 'admin' | 'support';
}
export interface DecodedToken {
  sub: string;
  email: string;
  role: string;
  imp?: ImpClaim;
  exp?: number;
}
export function decodeJwt(token: string): DecodedToken | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as DecodedToken;
  } catch {
    return null;
  }
}

/**
 * Session bootstrap token for a page. An impersonation session has NO refresh
 * cookie, so its token lives in sessionStorage and must be used directly;
 * otherwise fall back to the normal refresh-cookie mint.
 */
export async function getSessionToken(): Promise<string | null> {
  const imp = getImpToken();
  if (imp) return imp;
  return getAccessToken();
}

// ── Public auth config (what the /auth page must render) ────────────────────
export interface PublicAuthConfig {
  turnstileSiteKey: string;
  oauthGoogleEnabled: boolean;
  oauthGithubEnabled: boolean;
  selfRegistrationEnabled: boolean;
  /** Phase 10bis : drapeau NON sensible — affiche/cache le panneau Déploiements. */
  deployEnabled: boolean;
}
export async function getPublicAuthConfig(): Promise<PublicAuthConfig | null> {
  try {
    const res = await fetch('/api/public/auth-config');
    if (!res.ok) return null;
    return (await res.json()) as PublicAuthConfig;
  } catch {
    return null;
  }
}

// ── Public catalogue (visitor — order-time account creation) ────────────────
export interface PublicProduct {
  id: string;
  name: string;
  kind: string;
  status: string;
}
/** Public catalogue — unauthenticated GET (visitor browsing before ordering). */
export async function listPublicProducts(): Promise<ApiResult> {
  try {
    const res = await fetch('/api/public/products');
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
/** Start an order: sets the signed httpOnly checkout-intent cookie. */
export async function createCheckoutIntent(productId: string): Promise<ApiResult> {
  try {
    const res = await fetch('/api/checkout/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ productId }),
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

// ── Login / register with Turnstile + MFA step handling ─────────────────────
export type LoginResponse =
  | { accessToken: string }
  | { mfaRequired: true; challengeId: string; methods: ('totp' | 'email')[] }
  | { mfaRequired: false; enroll: true; enrollToken: string };
export async function login(input: {
  email: string;
  password: string;
  turnstileToken?: string;
}): Promise<ApiResult> {
  try {
    const res = await fetch('/api/auth/login', {
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
export async function register(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<ApiResult> {
  try {
    const res = await fetch('/api/auth/register', {
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

// ── MFA (self-service + two-step verification) ──────────────────────────────
export const mfaSetup = (t: string, password: string) =>
  apiJson('/api/auth/mfa/setup', t, { method: 'POST', body: JSON.stringify({ password }) });
export const mfaConfirm = (t: string, code: string) =>
  apiJson('/api/auth/mfa/confirm', t, { method: 'POST', body: JSON.stringify({ code }) });
export const mfaDisable = (t: string, password: string, code: string) =>
  apiJson('/api/auth/mfa/disable', t, {
    method: 'POST',
    body: JSON.stringify({ password, code }),
  });
export async function mfaVerify(input: {
  challengeId: string;
  code: string;
  method: 'totp' | 'email';
}): Promise<ApiResult> {
  try {
    const res = await fetch('/api/auth/mfa/verify', {
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
export async function mfaEmailSend(challengeId: string): Promise<ApiResult> {
  try {
    const res = await fetch('/api/auth/mfa/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ challengeId }),
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

// ── Support codes (client) ──────────────────────────────────────────────────
export interface SupportCodeStatus {
  active: boolean;
  expiresAt?: string | null;
}
export interface GeneratedSupportCode extends SupportCodeStatus {
  code: string; // shown ONCE
}
export const getSupportCodeStatus = (t: string) => apiJson('/api/client/support-code', t);
export const generateSupportCode = (t: string) =>
  apiJson('/api/client/support-code', t, { method: 'POST' });
export const revokeSupportCode = (t: string) =>
  apiJson('/api/client/support-code', t, { method: 'DELETE' });
/** Support L2+: redeem a client code → read-only impersonation token. */
export const supportRedeem = (t: string, code: string, turnstileToken?: string) =>
  apiJson('/api/support/access', t, {
    method: 'POST',
    body: JSON.stringify({ code, ...(turnstileToken ? { turnstileToken } : {}) }),
  });

// ── Tickets ─────────────────────────────────────────────────────────────────
export type TicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_CLIENT'
  | 'RESOLVED'
  | 'CLOSED';
export interface TicketMessage {
  id: string;
  ticketId: string;
  authorId: string;
  authorEmail: string;
  body: string;
  createdAt: string;
}
export interface Ticket {
  id: string;
  userId: string;
  subject: string;
  status: TicketStatus;
  priority: string;
  escalatedTo?: string | null;
  escalatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; email: string; name?: string | null };
  messages?: TicketMessage[];
}
export const createTicket = (t: string, dto: { subject: string; body: string; priority?: string }) =>
  apiJson('/api/tickets', t, { method: 'POST', body: JSON.stringify(dto) });
export const listMyTickets = (t: string) => apiJson('/api/tickets', t);
/** Support console queue — the whole ticket file (L1+ only). */
export const listSupportTickets = (t: string) => apiJson('/api/support/tickets', t);
export const getTicket = (t: string, id: string) => apiJson(`/api/tickets/${id}`, t);
export const addTicketMessage = (t: string, id: string, body: string) =>
  apiJson(`/api/tickets/${id}/messages`, t, { method: 'POST', body: JSON.stringify({ body }) });
export const escalateTicket = (t: string, id: string, to: string) =>
  apiJson(`/api/tickets/${id}/escalate`, t, { method: 'POST', body: JSON.stringify({ to }) });
export const updateTicketStatus = (t: string, id: string, status: string) =>
  apiJson(`/api/tickets/${id}/status`, t, { method: 'PATCH', body: JSON.stringify({ status }) });

// ── Admin security settings (Phase 11: Turnstile keys admin-managed, secret never returned) ─
export interface SecuritySettings {
  id: string | null;
  turnstileEnabled: boolean;
  /** Clé SITE publique Turnstile ; null = non configurée. */
  turnstileSiteKey: string | null;
  /** Seul l'état de la SECRET est renvoyé (write-only, AES-256-GCM). */
  turnstileHasSecretKey: boolean;
  oauthGoogleEnabled: boolean;
  oauthGithubEnabled: boolean;
  mfaRequiredForAdmins: boolean;
  selfRegistrationEnabled: boolean;
  deployEnabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}
export const getSecuritySettings = (t: string) => apiJson('/api/admin/security', t);
export const updateSecuritySettings = (
  t: string,
  dto: Partial<SecuritySettings> & { turnstileSiteKey?: string; turnstileSecretKey?: string },
) => apiJson('/api/admin/security', t, { method: 'PUT', body: JSON.stringify(dto) });

// ── Base de connaissance (Phase 11) ────────────────────────────────────────
export type KnowledgeAudience = 'ADMIN' | 'CLIENT';
export type KnowledgeType = 'INFORMATIVE' | 'TECHNICAL' | 'HOWTO';
export type KnowledgeStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface KnowledgeArticle {
  id: string;
  audience: KnowledgeAudience;
  type: KnowledgeType;
  status: KnowledgeStatus;
  title: string;
  slug: string;
  summary?: string | null;
  body: string;
  category?: string | null;
  phase?: string | null;
  tags: string[];
  authorEmail: string;
  author?: { id: string; email: string; name?: string | null } | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
}

export interface KnowledgeArticleSummary {
  id: string;
  type: KnowledgeType;
  title: string;
  slug: string;
  summary?: string | null;
  category?: string | null;
  tags: string[];
  publishedAt?: string | null;
}

export type KnowledgeArticleInput = {
  audience?: KnowledgeAudience;
  type?: KnowledgeType;
  status?: KnowledgeStatus;
  title?: string;
  slug?: string;
  summary?: string;
  body?: string;
  category?: string;
  phase?: string;
  tags?: string[];
};

// Admin (CRUD complet, les deux audiences)
export const listKnowledgeArticles = (t: string, qs = '') =>
  apiJson(`/api/knowledge${qs}`, t);
export const getKnowledgeArticle = (t: string, id: string) =>
  apiJson(`/api/knowledge/${id}`, t);
export const createKnowledgeArticle = (t: string, dto: KnowledgeArticleInput) =>
  apiJson('/api/knowledge', t, { method: 'POST', body: JSON.stringify(dto) });
export const updateKnowledgeArticle = (t: string, id: string, dto: KnowledgeArticleInput) =>
  apiJson(`/api/knowledge/${id}`, t, { method: 'PUT', body: JSON.stringify(dto) });
export const deleteKnowledgeArticle = (t: string, id: string) =>
  apiJson(`/api/knowledge/${id}`, t, { method: 'DELETE' });

// Client (public — PUBLISHED uniquement)
export async function listClientKnowledge(category?: string, q?: string): Promise<ApiResult> {
  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  if (q) qs.set('q', q);
  const url = `/api/client/knowledge${qs.size ? `?${qs}` : ''}`;
  try {
    const res = await fetch(url);
    let data: unknown = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: String(e) } };
  }
}
export async function getClientKnowledge(idOrSlug: string): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/client/knowledge/${encodeURIComponent(idOrSlug)}`);
    let data: unknown = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: String(e) } };
  }
}
export async function listClientKnowledgeCategories(): Promise<string[]> {
  try {
    const res = await fetch('/api/client/knowledge/categories');
    if (!res.ok) return [];
    return (await res.json()) as string[];
  } catch {
    return [];
  }
}

// ── Admin impersonation + recovery ──────────────────────────────────────────
export const adminImpersonate = (t: string, id: string) =>
  apiJson(`/api/users/${id}/impersonate`, t, { method: 'POST' });
export const adminMfaReset = (t: string, id: string) =>
  apiJson(`/api/users/${id}/mfa-reset`, t, { method: 'POST' });
export const returnFromImpersonation = (t: string) =>
  apiJson('/api/auth/impersonate/return', t, { method: 'POST' });

// ── Profile (password change) ───────────────────────────────────────────────
export const changePassword = (t: string, currentPassword: string, newPassword: string) =>
  apiJson('/api/auth/change-password', t, {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
export const oauthUnlink = (t: string, provider: 'google' | 'github') =>
  apiJson('/api/auth/oauth/unlink', t, { method: 'POST', body: JSON.stringify({ provider }) });

// ═══ Phase 10bis — Déploiement GitHub → Coolify ══════════════════════════════
export interface GithubRepo {
  fullName: string; // "owner/repo"
  defaultBranch: string;
  private: boolean;
  language: string | null;
}
export interface GithubLinkStatus {
  linked: boolean;
  login: string | null;
}
export type DeploymentStatus =
  | 'PENDING'
  | 'DEPLOYING'
  | 'ACTIVE'
  | 'FAILED';
/** Build packs Coolify proposés dans l'UI (mode URL collée, Phase 10bis.5). */
export const BUILD_PACKS = ['nixpacks', 'dockerfile', 'dockercompose', 'static'] as const;
export type BuildPack = (typeof BUILD_PACKS)[number];
export interface Deployment {
  id: string;
  userId: string;
  serviceId: string;
  serverId?: string | null;
  repoFullName: string;
  /** URL git collée (mode URL) — null en mode GitHub lié. */
  repoUrl?: string | null;
  /** Build pack envoyé à Coolify (affichage liste). */
  buildPack?: string | null;
  /** Nom de l'application côté Coolify (mode URL, modifiable par le client). */
  appName?: string | null;
  branch: string;
  status: DeploymentStatus;
  detail?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Références masquées — jamais l'UUID Coolify ni l'adresse du serveur. */
  service?: { id: string; name: string } | null;
  server?: { id: string; name: string } | null;
}
/** Résultat de la détection automatique d'une URL (Phase 10bis.5). */
export interface DetectResult {
  valid: boolean;
  repoUrl: string; // URL assainie
  repoFullName: string | null;
  defaultBranch: string;
  language: string | null;
  suggestedBuildPack: string;
  detail?: string;
}
/** Repos GitHub du client, autodétectés via le compte lié (Phase 10bis, M). */
export const listGithubRepos = (t: string) => apiJson('/api/client/github/repos', t);
/** État de la liaison GitHub — jamais le token. */
export const githubLinkStatus = (t: string) =>
  apiJson('/api/client/github/link-status', t, { method: 'POST' });
/** Détection auto d'une URL de dépôt collée (aucune liaison GitHub requise). */
export const detectDeployment = (t: string, url: string) =>
  apiJson('/api/client/deployments/detect', t, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
export const listMyDeployments = (t: string) => apiJson('/api/client/deployments', t);
export const getMyDeployment = (t: string, id: string) =>
  apiJson(`/api/client/deployments/${id}`, t);
/** Déploiement : mode GitHub lié (repoFullName) OU mode URL (repoUrl) — exactement un. */
export const createDeployment = (
  t: string,
  dto: {
    serviceId: string;
    repoFullName?: string;
    repoUrl?: string;
    branch?: string;
    buildPack?: BuildPack;
    appName?: string;
  },
) => apiJson('/api/client/deployments', t, { method: 'POST', body: JSON.stringify(dto) });