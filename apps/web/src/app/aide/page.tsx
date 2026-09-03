'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import {
  getClientKnowledge,
  listClientKnowledge,
  listClientKnowledgeCategories,
  type KnowledgeArticle,
  type KnowledgeArticleSummary,
  type KnowledgeType,
} from '@/lib/api';
import { IconBook, IconChevronRight, IconLifeBuoy, IconSearch } from '@/components/icons';
import { brand } from '@/config/brand';

const TYPE_LABEL: Record<KnowledgeType, string> = {
  INFORMATIVE: 'Info',
  TECHNICAL: 'Technique',
  HOWTO: 'Guide',
};

/** Sanitisation défensive du HTML d'article — jamais de <script>, jamais d'attributs on*. */
function sanitize(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, iframe, object, embed, style, link, meta, form, input, button').forEach((n) => n.remove());
  template.content.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'href' && /^\s*javascript:/i.test(attr.value) || name === 'srcdoc') {
        el.removeAttribute(attr.name);
      }
    }
  });
  return template.innerHTML;
}

export default function AidePage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [articles, setArticles] = useState<KnowledgeArticleSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');

  const [open, setOpen] = useState<KnowledgeArticle | null>(null);
  const [reading, setReading] = useState(false);

  const load = useCallback(async (category: string, query: string) => {
    const [r, c] = await Promise.all([
      listClientKnowledge(category || undefined, query.trim() || undefined),
      listClientKnowledgeCategories(),
    ]);
    setCategories(c);
    if (r.ok) setArticles((r.data as KnowledgeArticleSummary[]) ?? []);
    else toast.error('Impossible de charger le centre d’aide.');
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    // debounce léger sur la recherche (250 ms si q non vide, sinon immédiat)
    const t = setTimeout(() => load(cat, q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [cat, q, load]);

  async function openArticle(a: KnowledgeArticleSummary) {
    setReading(true);
    const r = await getClientKnowledge(a.id);
    setReading(false);
    if (r.ok) {
      setOpen(r.data as KnowledgeArticle);
    } else {
      toast.error('Impossible de lire l’article.');
    }
  }

  const grouped = useMemo(() => {
    if (cat) return { [cat]: articles };
    const map = new Map<string, KnowledgeArticleSummary[]>();
    articles.forEach((a) => {
      const key = a.category ?? 'Autres';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    });
    return Object.fromEntries(map);
  }, [articles, cat]);

  if (loading) return <PageLoading label="Chargement du centre d’aide…" />;

  return (
    <AppShell me={null} nav={[]} footStatus={`${articles.length} articles`}>
      <div className="wrap-lg">
        {/* ── Héro ──────────────────────────────────────────────────────── */}
        <div className="aide-hero">
          <div className="aide-hero-badge">
            <IconLifeBuoy size={14} /> Centre d&apos;aide {brand.name}
          </div>
          <h1 className="aide-hero-title">
            Comment pouvons-nous vous <span className="aide-accent">aider</span> ?
          </h1>
          <p className="aide-hero-sub">
            Guides, explications des options et articles de support — pour tirer le meilleur de votre espace.
          </p>
          <div className="aide-search">
            <IconSearch size={17} />
            <input
              autoFocus
              placeholder="Rechercher : connexion, facturation, déploiement, sécurité…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Rechercher dans le centre d'aide"
            />
          </div>
          {categories.length > 0 && (
            <div className="aide-chips">
              <button type="button" className={`chip${cat === '' ? ' active' : ''}`} onClick={() => setCat('')}>
                Tout voir
              </button>
              {categories.map((c) => (
                <button key={c} type="button" className={`chip${cat === c ? ' active' : ''}`} onClick={() => setCat(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Contenu ───────────────────────────────────────────────────── */}
        {articles.length === 0 ? (
          <div className="empty" style={{ padding: '56px 0' }}>
            <IconBook />
            <div className="muted" style={{ marginTop: 6 }}>
              Aucun article trouvé pour « {q} ». Essayez un autre terme, ou ouvrez un ticket de support depuis
              votre espace client.
            </div>
            <Link className="btn-secondary" href="/client" style={{ display: 'inline-flex', marginTop: 14 }}>
              Ouvrir un ticket <IconChevronRight size={14} />
            </Link>
          </div>
        ) : (
          Object.entries(grouped).map(([group, rows]) => (
            <section key={group} className="aide-section">
              <div className="aide-group-head">
                <h2>{group}</h2>
                <span>{rows.length} article{rows.length > 1 ? 's' : ''}</span>
              </div>
              <div className="aide-grid">
                {rows.map((a) => (
                  <button key={a.id} type="button" className="aide-card" onClick={() => openArticle(a)}>
                    <div className="aide-card-top">
                      <Badge type={a.type} />
                      <span className="muted" style={{ fontSize: 12 }}>{a.category}</span>
                    </div>
                    <b className="aide-card-title">{a.title}</b>
                    {a.summary && <p className="aide-card-sum">{a.summary}</p>}
                    <div className="aide-card-foot">
                      <span className="aide-read">Lire l’article <IconChevronRight size={13} /></span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}

        <footer className="aide-foot">
          <p>Vous ne trouvez pas votre réponse ?</p>
          <Link className="btn-primary" href="/client" style={{ display: 'inline-flex' }}>
            Contacter le support
          </Link>
        </footer>
      </div>

      {/* ── Lecteur d'article ───────────────────────────────────────────── */}
      {open && (
        <div className="drawer-overlay" onClick={() => setOpen(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px, 100vw)' }}>
            <div className="drawer-head">
              <div className="flex-1">
                <div className="drawer-title">{open.title}</div>
                <div className="drawer-sub">
                  {open.category && <>{open.category} · </>}
                  mis à jour le {new Date(open.updatedAt).toLocaleDateString('fr-FR')}
                </div>
              </div>
              <button type="button" className="icon-btn drawer-close" onClick={() => setOpen(null)} aria-label="Fermer">✕</button>
            </div>
            <div className="drawer-body">
              {reading ? (
                <div className="page-loading" style={{ padding: '30px 0' }}><span className="spinner" /> Lecture…</div>
              ) : (
                <article
                  className="article-body"
                  dangerouslySetInnerHTML={{ __html: sanitize(open.body) }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Badge({ type }: { type: KnowledgeType }) {
  return <span className={`badge badge-${type === 'HOWTO' ? 'violet' : type === 'TECHNICAL' ? 'info' : 'ok'}`}>{TYPE_LABEL[type]}</span>;
}
