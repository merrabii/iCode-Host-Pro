'use client';

import { useEffect, useMemo, useState } from 'react';
import { AuditEntry, AuditPage, listAudit } from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Button, Denied, EmptyState, Field, Input, PageIntro, PageLoading, Select } from '@/components/ui';

const PER_PAGE = 50;

// Human-readable labels for the machine action codes.
const ACTION_LABEL: Record<string, string> = {
  'auth.register': 'Inscription',
  'auth.login': 'Connexion',
  'auth.refresh': 'Rafraîchissement de session',
  'auth.logout': 'Déconnexion',
  'user.promote': 'Promotion admin',
  'user.demote': 'Rétrogradation',
  'user.activate': 'Activation',
  'user.deactivate': 'Désactivation',
  'product.create': 'Création produit',
  'product.update': 'Modification produit',
  'product.delete': 'Suppression produit',
  'server.create': 'Création serveur',
  'server.update': 'Modification serveur',
  'server.delete': 'Suppression serveur',
  'server.check': 'Test de connexion serveur',
  'server.panel.verify': 'Vérification API panneau',
  'invite.create': 'Émission invitation',
  'invite.revoke': 'Révocation invitation',
  'invite.accept': 'Acceptation invitation',
  'subscription.create': 'Souscription',
  'subscription.cancel': 'Annulation souscription',
  'subscription.approve': 'Approbation souscription',
  'subscription.reject': 'Rejet souscription',
  'subscription.suspend': 'Suspension souscription',
  'subscription.activate': 'Réactivation souscription',
  'service.request': 'Demande de service',
  'service.assign': 'Affectation serveur',
  'service.remove': 'Retrait serveur',
  'service.provision': 'Provisionnement (stub)',
  'service.activate': 'Activation service',
};

const label = (a: string) => ACTION_LABEL[a] ?? a;

// French word for each resource type (falls back to the raw code).
const RESOURCE_WORD: Record<string, string> = {
  user: 'utilisateur',
  product: 'produit',
  server: 'serveur',
  invitation: 'invitation',
  subscription: 'souscription',
  service: 'service',
};

// Human-readable "Ressource" cell: the name of the affected entity when the
// audit payload carries one (create/update/delete), the short id otherwise.
// The raw `details` JSON is preserved for forensics as a hover tooltip.
function resourceLabel(e: AuditEntry): string {
  const word = RESOURCE_WORD[e.resourceType ?? ''] ?? e.resourceType ?? '';
  const d = e.details && typeof e.details === 'object' ? (e.details as Record<string, any>) : null;
  const name = d ? d.name ?? d.to?.name ?? d.email ?? d.to?.email ?? null : null;
  const who = name ?? (e.resourceId ? `${e.resourceId.slice(0, 8)}…` : '');
  // Servers carry a hostname too — surface it (create/delete in `d.hostname`,
  // update in `d.to.hostname`).
  const host = d ? d.hostname ?? d.to?.hostname ?? null : null;
  return [word, who, host].filter(Boolean).join(' · ');
}

export default function ManagerJournalPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [data, setData] = useState<AuditPage | null>(null);
  const [resourceType, setResourceType] = useState('');
  const [action, setAction] = useState('');

  const load = (t: string, page: number) =>
    listAudit(t, {
      page,
      perPage: PER_PAGE,
      resourceType: resourceType || undefined,
      action: action || undefined,
    });

  async function refresh(page: number) {
    const r = await load(token, page);
    if (!r.ok) {
      toast.error('Impossible de charger le journal.');
      return;
    }
    setData(r.data as AuditPage);
  }

  const totalPages = useMemo(() => {
    if (!data || data.total === 0) return 0;
    return Math.max(1, Math.ceil(data.total / data.perPage));
  }, [data]);

  useEffect(() => {
    if (phase === 'ready') void refresh(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceType, action]);

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
          title="Journal d'audit"
          sub="Traçabilité des actions sur la plateforme — append-only, lecture réservée aux administrateurs."
        />

        <div className="row mb">
          <Field label="Type de ressource">
            <Select value={resourceType} onChange={(e) => setResourceType(e.target.value)} className="select-sm">
              <option value="">Tous</option>
              <option value="user">user</option>
              <option value="product">product</option>
              <option value="server">server</option>
            </Select>
          </Field>
          <Field label="Action">
            <Input value={action} placeholder="ex. user.promote" onChange={(e) => setAction(e.target.value)} className="input-sm" />
          </Field>
          {data && <span className="muted cell-sub" style={{ paddingBottom: 10 }}>{data.total} entrée(s)</span>}
        </div>

        {data?.items.length === 0 ? (
          <EmptyState>Aucune entrée.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Quand</th>
                  <th>Acteur</th>
                  <th>Action</th>
                  <th>Ressource</th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((e: AuditEntry) => (
                  <tr key={e.id}>
                    <td className="muted nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td>{e.actorEmail ?? '—'}</td>
                    <td>{label(e.action)}</td>
                    <td className="muted" title={e.details ? JSON.stringify(e.details) : undefined}>
                      {resourceLabel(e) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row mt">
          <Button
            size="sm"
            variant="secondary"
            disabled={!data || data.page <= 1}
            onClick={() => data && refresh(data.page - 1)}
          >
            ← Précédent
          </Button>
          <span className="muted cell-sub">
            Page {data?.page ?? 1} / {Math.max(1, totalPages)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!data || data.page >= totalPages}
            onClick={() => data && refresh(data.page + 1)}
          >
            Suivant →
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
