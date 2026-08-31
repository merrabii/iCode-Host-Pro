// Thin client-side API helpers for the web app (Phase 2, ADR-017).
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