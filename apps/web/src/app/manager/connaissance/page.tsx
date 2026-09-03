'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import {
  Alert,
  Badge,
  Button,
  PageIntro,
  PageLoading,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { ADMIN_NAV } from '@/config/nav';
import { useAdminSession } from '@/lib/session';
import {
  createKnowledgeArticle,
  deleteKnowledgeArticle,
  listKnowledgeArticles,
  updateKnowledgeArticle,
  type KnowledgeArticle,
  type KnowledgeArticleInput,
  type KnowledgeAudience,
  type KnowledgeStatus,
  type KnowledgeType,
} from '@/lib/api';
import { IconBook, IconFileText, IconLifeBuoy, IconPlus, IconSearch, IconTrash, IconPencil } from '@/components/icons';

const AUDIENCE_LABEL: Record<KnowledgeAudience, string> = {
  ADMIN: 'Base interne admin',
  CLIENT: 'Base client (/aide)',
};

const TYPE_LABEL: Record<KnowledgeType, string> = {
  INFORMATIVE: 'Informatif',
  TECHNICAL: 'Technique',
  HOWTO: 'Guide « comment faire »',
};

const TYPE_DESC: Record<KnowledgeType, string> = {
  INFORMATIVE: 'Récapitulatif des phases effectuées (champ « Phase » renseigné).',
  TECHNICAL: 'Informations techniques du projet / implémentation.',
  HOWTO: 'Explique à l’admin comment utiliser une option du système.',
};

const STATUS_TONE: Record<KnowledgeStatus, 'ok' | 'warn' | 'neutral'> = {
  PUBLISHED: 'ok',
  DRAFT: 'warn',
  ARCHIVED: 'neutral',
};

const empty: KnowledgeArticleInput = {
  audience: 'ADMIN',
  type: 'INFORMATIVE',
  status: 'DRAFT',
  title: '',
  slug: '',
  summary: '',
  body: '<p></p>',
  category: '',
  phase: '',
  tags: [],
};

export default function ConnaissancePage() {
  const toast = useToast();
  const { phase, token } = useAdminSession();
  const [articles, setArticles] = useState<KnowledgeArticle[] | null>(null);

  const [tab, setTab] = useState<KnowledgeAudience>('ADMIN');
  const [statusFilter, setStatusFilter] = useState<'' | KnowledgeStatus>('');
  const [q, setQ] = useState('');

  // Éditeur (dessin) — null = fermé.
  const [editing, setEditing] = useState<KnowledgeArticle | 'new' | null>(null);
  const [draft, setDraft] = useState<KnowledgeArticleInput>(empty);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const qs = new URLSearchParams();
    qs.set('audience', tab);
    if (statusFilter) qs.set('status', statusFilter);
    if (q.trim()) qs.set('q', q.trim());
    const res = await listKnowledgeArticles(token, `?${qs.toString()}`);
    if (res.ok) setArticles(res.data as KnowledgeArticle[]);
    else toast.error('Lecture de la base de connaissance impossible.');
  }, [token, tab, statusFilter, q, toast]);

  useEffect(() => {
    if (phase === 'ready') load();
  }, [phase, load]);

  const counts = useMemo(() => {
    const c = { total: 0, PUBLISHED: 0, DRAFT: 0, ARCHIVED: 0 };
    (articles ?? []).forEach((a) => {
      c.total += 1;
      c[a.status] += 1;
    });
    return c;
  }, [articles]);

  if (phase === 'loading' || (phase === 'ready' && !articles)) {
    return <PageLoading label="Chargement de la base de connaissance…" />;
  }
  if (phase === 'denied' || !token) {
    return (
      <AppShell me={null} nav={ADMIN_NAV} bare={false}>
        <div className="wrap-md">
          <Alert tone="error" title="Accès refusé">Réservé aux administrateurs.</Alert>
        </div>
      </AppShell>
    );
  }

  function openNew() {
    setDraft({ ...empty, audience: tab });
    setEditing('new');
  }

  function openEdit(a: KnowledgeArticle) {
    setDraft({
      audience: a.audience,
      type: a.type,
      status: a.status,
      title: a.title,
      slug: a.slug,
      summary: a.summary ?? '',
      body: a.body,
      category: a.category ?? '',
      phase: a.phase ?? '',
      tags: a.tags,
    });
    setEditing(a);
  }

  async function save() {
    if (!token || !editing) return;
    if (!draft.title?.trim() || !draft.body?.trim()) {
      toast.error('Titre et contenu sont obligatoires.');
      return;
    }
    setSaving(true);
    const payload: KnowledgeArticleInput = {
      ...draft,
      title: draft.title.trim(),
      slug: draft.slug?.trim() || undefined,
      summary: draft.summary?.trim() || undefined,
      category: draft.category?.trim() || undefined,
      phase: draft.phase?.trim() || undefined,
      tags: draft.tags?.filter(Boolean) ?? [],
    };
    const res =
      editing === 'new'
        ? await createKnowledgeArticle(token, payload)
        : await updateKnowledgeArticle(token, editing.id, payload);
    setSaving(false);
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Enregistrement impossible.');
      return;
    }
    toast.ok(editing === 'new' ? 'Article créé.' : 'Article mis à jour.');
    setEditing(null);
    load();
  }

  async function remove(a: KnowledgeArticle) {
    if (!token) return;
    if (!window.confirm(`Supprimer définitivement « ${a.title} » ?`)) return;
    setDeleting(a.id);
    const res = await deleteKnowledgeArticle(token, a.id);
    setDeleting(null);
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Suppression impossible.');
      return;
    }
    toast.ok('Article supprimé.');
    load();
  }

  async function publish(a: KnowledgeArticle) {
    if (!token) return;
    const res = await updateKnowledgeArticle(token, a.id, {
      status: a.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED',
    });
    if (!res.ok) {
      toast.error((res.data as { message?: string })?.message ?? 'Publication impossible.');
      return;
    }
    toast.ok(a.status === 'PUBLISHED' ? 'Dépublié (brouillon).' : 'Article publié.');
    load();
  }

  const style = {
    tabs: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
    tabBtn: { padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600 } as React.CSSProperties,
    tabActive: { background: 'var(--active-bg)', color: 'var(--active-text)', borderColor: 'var(--active-text)' } as React.CSSProperties,
    list: { display: 'grid', gap: 12 },
    row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const },
    grow: { flex: 1, minWidth: 220 },
  };

  return (
    <AppShell me={{ email: 'admin', role: 'ADMIN' }} nav={ADMIN_NAV}>
      <div className="wrap-lg">
        <PageIntro
          eyebrow="Administration · Connaissance"
          title="Base de connaissance"
          sub="Deux bases : la documentation interne admin (phases, technique, guides) et le centre d’aide client — gérées et publiées ici."
        />

        <div className="row mt" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={style.tabs}>
            <button type="button" style={{ ...style.tabBtn, ...(tab === 'ADMIN' ? style.tabActive : {}) }} onClick={() => setTab('ADMIN')}>
              <span className="row" style={{ gap: 6 }}><IconBook size={15} /> Admin (interne)</span>
            </button>
            <button type="button" style={{ ...style.tabBtn, ...(tab === 'CLIENT' ? style.tabActive : {}) }} onClick={() => setTab('CLIENT')}>
              <span className="row" style={{ gap: 6 }}><IconLifeBuoy size={15} /> Client (/aide)</span>
            </button>
          </div>
          <Button onClick={openNew}><IconPlus size={15} /> Nouvel article</Button>
        </div>

        {/* Filtres */}
        <div className="panel mt">
          <div className="panel-body row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div className="row" style={{ gap: 6, flex: 1, minWidth: 220 }}>
              <IconSearch size={15} className="muted" />
              <input
                className="input flex-1"
                placeholder="Rechercher un article…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ minWidth: 0 }}
              />
            </div>
            <select
              className="select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | KnowledgeStatus)}
            >
              <option value="">Tous les statuts</option>
              <option value="PUBLISHED">Publiés ({counts.PUBLISHED})</option>
              <option value="DRAFT">Brouillons ({counts.DRAFT})</option>
              <option value="ARCHIVED">Archivés ({counts.ARCHIVED})</option>
            </select>
          </div>
        </div>

        {/* Liste */}
        <div className="stack mt" style={style.list}>
          {articles!.length === 0 && (
            <div className="empty" style={{ padding: '44px 0' }}>
              <IconBook />
              <div className="muted" style={{ marginTop: 4 }}>
                Aucun article {tab === 'ADMIN' ? 'interne' : 'client'} pour ces filtres.
              </div>
              <Button size="sm" variant="secondary" onClick={openNew} style={{ marginTop: 12 }}>
                <IconPlus size={14} /> Créer le premier
              </Button>
            </div>
          )}
          {articles!.map((a) => (
            <div key={a.id} className="panel">
              <div className="panel-body" style={{ padding: '14px 16px' }}>
                <div style={style.row}>
                  <div style={style.grow}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <b style={{ fontSize: 15 }}>{a.title}</b>
                      <Badge tone={STATUS_TONE[a.status]}>
                        {a.status === 'PUBLISHED' ? 'Publié' : a.status === 'DRAFT' ? 'Brouillon' : 'Archivé'}
                      </Badge>
                      <Badge tone="neutral">{TYPE_LABEL[a.type]}</Badge>
                      {a.audience === 'ADMIN' && a.phase && <Badge tone="violet">{a.phase}</Badge>}
                      {a.audience === 'CLIENT' && a.category && <Badge tone="info">{a.category}</Badge>}
                    </div>
                    {a.summary && (
                      <p className="muted mt-sm" style={{ fontSize: 13, maxWidth: 720 }}>{a.summary}</p>
                    )}
                    <div className="muted mt-sm" style={{ fontSize: 12 }}>
                      /{a.slug} · {a.audience === 'ADMIN' ? 'interne admin' : 'client'} · mis à jour le{' '}
                      {new Date(a.updatedAt).toLocaleDateString('fr-FR')} · par {a.author?.email ?? a.authorEmail}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="secondary" onClick={() => publish(a)}>
                      {a.status === 'PUBLISHED' ? 'Dépublier' : 'Publier'}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => openEdit(a)}>
                      <IconPencil size={14} /> Éditer
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => remove(a)} disabled={deleting === a.id} busy={deleting === a.id}>
                      <IconTrash size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Éditeur (dessin) ─────────────────────────────────────────────── */}
      {editing && (
        <div className="drawer-overlay" onClick={() => setEditing(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 100vw)' }}>
            <div className="drawer-head">
              <div className="flex-1">
                <div className="drawer-title">{editing === 'new' ? 'Nouvel article' : 'Éditer l’article'}</div>
                {editing !== 'new' && <div className="drawer-sub">{(editing as KnowledgeArticle).title}</div>}
              </div>
              <button type="button" className="icon-btn drawer-close" onClick={() => setEditing(null)} aria-label="Fermer">✕</button>
            </div>
            <div className="drawer-body stack" style={{ gap: 12 }}>
              <Alert tone="info" title={AUDIENCE_LABEL[draft.audience ?? 'ADMIN']}>
                {draft.audience === 'ADMIN'
                  ? 'Visible uniquement par les administrateurs.'
                  : 'Publié, visible par tous sur le centre d’aide public (/aide).'}
              </Alert>

              <label className="field">
                <span className="field-label">Titre *</span>
                <input className="input" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Ex. Phase 10 — Sécurité & comptes" />
              </label>

              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <label className="field flex-1">
                  <span className="field-label">Audience</span>
                  <select className="select" value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value as KnowledgeAudience })}>
                    <option value="ADMIN">Admin (interne)</option>
                    <option value="CLIENT">Client (/aide)</option>
                  </select>
                </label>
                <label className="field flex-1">
                  <span className="field-label">Type</span>
                  <select className="select" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as KnowledgeType })}>
                    <option value="INFORMATIVE">Informatif</option>
                    <option value="TECHNICAL">Technique</option>
                    <option value="HOWTO">Guide « comment faire »</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Statut</span>
                  <select className="select" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as KnowledgeStatus })}>
                    <option value="DRAFT">Brouillon</option>
                    <option value="PUBLISHED">Publié</option>
                    <option value="ARCHIVED">Archivé</option>
                  </select>
                </label>
              </div>
              {draft.type === 'INFORMATIVE' && draft.audience === 'ADMIN' && (
                <Alert tone="ok" title="Conseil">
                  {TYPE_DESC.INFORMATIVE} Renseignez le champ « Phase » (ex. « Phase 10 ») pour relier l’article au
                  récapitulatif d’une phase.
                </Alert>
              )}

              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <label className="field flex-1">
                  <span className="field-label">Slug (URL) — laisser vide pour auto</span>
                  <input className="input" value={draft.slug ?? ''} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="phase-10-securite-comptes" />
                </label>
                <label className="field">
                  <span className="field-label">{draft.audience === 'CLIENT' ? 'Catégorie' : 'Phase'}</span>
                  <input className="input" value={draft.audience === 'CLIENT' ? draft.category ?? '' : draft.phase ?? ''} onChange={(e) => setDraft(draft.audience === 'CLIENT' ? { ...draft, category: e.target.value } : { ...draft, phase: e.target.value })} placeholder={draft.audience === 'CLIENT' ? 'Support' : 'Phase 10'} />
                </label>
              </div>

              <label className="field">
                <span className="field-label">Résumé (affiché en carte)</span>
                <input className="input" value={draft.summary ?? ''} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder="Une phrase qui résume l’article…" />
              </label>

              <label className="field">
                <span className="field-label">Contenu (HTML)</span>
                <textarea
                  className="input"
                  rows={14}
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, resize: 'vertical' }}
                  value={draft.body ?? ''}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  placeholder={'<p>Bonjour !</p>\n<ul>\n  <li>Point 1</li>\n</ul>\n<h2>Sous-titre</h2>\n<pre><code>…</code></pre>'}
                />
              </label>

              <label className="field">
                <span className="field-label">Étiquettes (séparées par des virgules)</span>
                <input
                  className="input"
                  value={(draft.tags ?? []).join(', ')}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                  placeholder="sécurité, mfa, oauth"
                />
              </label>

              <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="secondary" onClick={() => setEditing(null)}>Annuler</Button>
                <Button onClick={save} busy={saving}>{saving ? 'Enregistrement…' : 'Enregistrer'}</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
