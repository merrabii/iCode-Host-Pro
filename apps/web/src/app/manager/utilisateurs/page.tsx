'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  adminImpersonate,
  adminMfaReset,
  apiError,
  listUsers,
  setImpToken,
  updateUser,
  UserAdmin,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Badge, Button, Denied, EmptyState, PageIntro, PageLoading, Select } from '@/components/ui';

type BusyId = string | null;

const ROLES: { value: string; label: string }[] = [
  { value: 'USER', label: 'Client' },
  { value: 'SUPPORT_L1', label: 'Support L1' },
  { value: 'SUPPORT_L2', label: 'Support L2' },
  { value: 'SUPPORT_L3', label: 'Support L3' },
  { value: 'ADMIN', label: 'Administrateur' },
];

const ROLE_TONE: Record<string, 'violet' | 'ok' | 'info' | 'warn' | 'neutral'> = {
  ADMIN: 'violet',
  SUPPORT_L3: 'ok',
  SUPPORT_L2: 'info',
  SUPPORT_L1: 'warn',
  USER: 'neutral',
};

export default function ManagerUsersPage() {
  const router = useRouter();
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [users, setUsers] = useState<UserAdmin[]>([]);
  const [busy, setBusy] = useState<BusyId>(null);

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function load(t: string) {
    const r = await listUsers(t);
    if (!r.ok) return toast.error('Impossible de charger les utilisateurs.');
    setUsers((r.data as UserAdmin[]) ?? []);
  }

  async function apply(id: string, patch: { role?: string; isActive?: boolean }) {
    setBusy(id);
    const r = await updateUser(token, id, patch);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour.'));
    toast.ok('Utilisateur mis à jour.');
    void load(token);
  }

  async function impersonate(u: UserAdmin) {
    setBusy(u.id);
    const r = await adminImpersonate(token, u.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Impersonation impossible.'));
    const d = r.data as { accessToken: string };
    const expiry = decodeExpiry(d.accessToken);
    if (expiry && Date.now() >= expiry * 1000) {
      toast.error('Jeton d’impersonation expiré immédiatement.');
      return;
    }
    setImpToken(d.accessToken);
    toast.ok(`Session « en tant que » ${u.email} — lecture seule.`);
    router.replace('/client');
  }

  async function mfaReset(u: UserAdmin) {
    if (!window.confirm(`Réinitialiser la double authentification de « ${u.email} » ? (secours d'urgence)`)) {
      return;
    }
    setBusy(u.id);
    const r = await adminMfaReset(token, u.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Réinitialisation MFA impossible.'));
    toast.ok(`MFA désactivée pour ${u.email} — elle pourra se reconnecter.`);
  }

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <Denied />
      </AppShell>
    );
  }

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Utilisateurs"
          sub="Gestion des comptes : rôle (client / support L1·L2·L3 / admin), activation, accès « en tant que » et réinitialisation MFA de secours. Gardes anti-verrouillage actives."
        />

        {users.length === 0 ? (
          <EmptyState>Aucun compte.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Compte</th>
                  <th>Rôle</th>
                  <th>Statut</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="cell-title">{u.email}</div>
                      <div className="muted cell-sub">
                        {u.name ?? '—'}
                        {u.id === me?.id && <span> · vous</span>}
                      </div>
                    </td>
                    <td>
                      {u.id === me?.id ? (
                        <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>{u.role}</Badge>
                      ) : (
                        <Select
                          aria-label="Rôle"
                          value={u.role}
                          disabled={busy === u.id}
                          onChange={(e) => apply(u.id, { role: e.target.value })}
                        >
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label} ({r.value})
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                    <td>
                      <Badge tone={u.isActive ? 'ok' : 'danger'}>{u.isActive ? 'Actif' : 'Désactivé'}</Badge>
                    </td>
                    <td>
                      <div className="row ta-right" style={{ justifyContent: 'flex-end' }}>
                        {u.role !== 'ADMIN' && u.isActive && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === u.id}
                            onClick={() => impersonate(u)}
                          >
                            Se connecter en tant que
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant={u.isActive ? 'danger' : 'primary'}
                          disabled={busy === u.id}
                          onClick={() => apply(u.id, { isActive: !u.isActive })}
                        >
                          {u.isActive ? 'Désactiver' : 'Activer'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === u.id || u.id === me?.id}
                          onClick={() => mfaReset(u)}
                          title="Réinitialiser la double authentification (secours)"
                        >
                          MFA
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** Best-effort JWT expiry (seconds) — auto-check après impersonation. */
function decodeExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}