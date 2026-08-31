'use client';

import { useEffect, useState } from 'react';
import { apiError, listUsers, updateUser, UserAdmin } from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Badge, Button, Denied, EmptyState, PageIntro, PageLoading } from '@/components/ui';

type BusyId = string | null;

export default function ManagerUsersPage() {
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
          sub="Gestion des comptes de la plateforme — promotion/rétrogradation et activation. Gardes anti-verrouillage actives (un admin ne peut pas être laissé seul)."
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
                      <Badge tone={u.role === 'ADMIN' ? 'violet' : 'neutral'}>{u.role}</Badge>
                    </td>
                    <td>
                      <Badge tone={u.isActive ? 'ok' : 'danger'}>{u.isActive ? 'Actif' : 'Désactivé'}</Badge>
                    </td>
                    <td>
                      <div className="row ta-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === u.id}
                          onClick={() => apply(u.id, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' })}
                        >
                          {u.role === 'ADMIN' ? 'Rétrograder' : 'Promouvoir'}
                        </Button>
                        <Button
                          size="sm"
                          variant={u.isActive ? 'danger' : 'primary'}
                          disabled={busy === u.id}
                          onClick={() => apply(u.id, { isActive: !u.isActive })}
                        >
                          {u.isActive ? 'Désactiver' : 'Activer'}
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
