'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AuditEntry,
  AuditPage,
  fetchMe,
  getAccessToken,
  listAudit,
  Me,
} from '../../../lib/api';

type Phase = 'loading' | 'denied' | 'ready';

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
  const d = e.details && typeof e.details === 'object' ? e.details as Record<string, any> : null;
  const name = d
    ? d.name ?? d.to?.name ?? d.email ?? d.to?.email ?? null
    : null;
  const who = name ?? (e.resourceId ? `${e.resourceId.slice(0, 8)}…` : '');
  // Servers carry a hostname too — surface it (create/delete in `d.hostname`,
  // update in `d.to.hostname`).
  const host = d ? d.hostname ?? d.to?.hostname ?? null : null;
  return [word, who, host].filter(Boolean).join(' · ');
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border, #e2e2e2)',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
};
const tdStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border, #e9e9e9)',
  verticalAlign: 'top',
};

export default function ManagerJournalPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [data, setData] = useState<AuditPage | null>(null);
  const [resourceType, setResourceType] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = (t: string, page: number) =>
    listAudit(t, {
      page,
      perPage: PER_PAGE,
      resourceType: resourceType || undefined,
      action: action || undefined,
    });

  async function refresh(page: number) {
    setError(null);
    const r = await load(token, page);
    if (!r.ok) {
      setError('Impossible de charger le journal.');
      return;
    }
    setData(r.data as AuditPage);
  }

  const totalPages = useMemo(() => {
    if (!data || data.total === 0) return 0;
    return Math.max(1, Math.ceil(data.total / data.perPage));
  }, [data]);

  useEffect(() => {
    (async () => {
      const t = await getAccessToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m || m.role !== 'ADMIN') {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
      void refresh(1);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (phase === 'ready') void refresh(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceType, action]);

  if (phase === 'loading') {
    return (
      <main style={{ maxWidth: 860, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Journal d&apos;audit</h1>
        <p className="muted">Connexion…</p>
      </main>
    );
  }

  if (phase === 'denied') {
    return (
      <main style={{ maxWidth: 860, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Journal d&apos;audit</h1>
        <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs.</p>
        <p><a href="/auth">→ Retour à l&apos;authentification</a></p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 860, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — Journal d&apos;audit</h1>
      <p className="muted">
        Traçabilité des actions (Phase 4) — connecté en tant que {me?.email} ·{' '}
        <Link href="/manager">← Tableau de bord</Link>
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <label className="muted" style={{ fontSize: 13 }}>
          Type de ressource
          <select
            style={{ marginLeft: 8 }}
            value={resourceType}
            onChange={(e) => setResourceType(e.target.value)}
          >
            <option value="">Tous</option>
            <option value="user">user</option>
            <option value="product">product</option>
            <option value="server">server</option>
          </select>
        </label>
        <label className="muted" style={{ fontSize: 13 }}>
          Action
          <input
            style={{ marginLeft: 8 }}
            value={action}
            placeholder="ex. user.promote"
            onChange={(e) => setAction(e.target.value)}
          />
        </label>
        <span className="muted" style={{ fontSize: 13 }}>
          {data ? `${data.total} entrée(s)` : ''}
        </span>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Quand</th>
              <th style={thStyle}>Acteur</th>
              <th style={thStyle}>Action</th>
              <th style={thStyle}>Ressource</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((e: AuditEntry) => (
              <tr key={e.id}>
                <td style={tdStyle} className="muted">
                  {new Date(e.createdAt).toLocaleString()}
                </td>
                <td style={tdStyle}>{e.actorEmail ?? '—'}</td>
                <td style={tdStyle}>{label(e.action)}</td>
                <td style={tdStyle} className="muted" title={e.details ? JSON.stringify(e.details) : undefined}>
                  {resourceLabel(e) || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.items.length === 0 && <p className="muted">Aucune entrée.</p>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14 }}>
        <button
          disabled={!data || data.page <= 1}
          onClick={() => data && refresh(data.page - 1)}
        >
          ← Précédent
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Page {data?.page ?? 1} / {Math.max(1, totalPages)}
        </span>
        <button
          disabled={!data || data.page >= totalPages}
          onClick={() => data && refresh(data.page + 1)}
        >
          Suivant →
        </button>
      </div>
    </main>
  );
}