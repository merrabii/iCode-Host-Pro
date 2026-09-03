'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Badge, Button, EmptyState, PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { brand } from '@/config/brand';
import { IconCheck, IconChevronRight, IconGlobe, IconLayers, IconServer, IconShield } from '@/components/icons';
import {
  apiError,
  createCheckoutIntent,
  listPublicProducts,
  type PublicProduct,
} from '@/lib/api';

const KIND_META: Record<string, { icon: typeof IconServer; label: string; desc: string }> = {
  deployment: { icon: IconServer, label: 'Déploiement', desc: 'Hébergement et déploiement d’applications sur votre serveur.' },
  domain: { icon: IconGlobe, label: 'Domaine & DNS', desc: 'Gestion des domaines et de la configuration DNS.' },
  infrastructure: { icon: IconLayers, label: 'Infrastructure', desc: 'Ressources et services d’infrastructure dédiés.' },
};

const PERKS = ['Souscription mensuelle sans engagement', 'Création de compte à la commande', 'Supervision 24/7', 'Support prioritaire'];

export default function OffresPage() {
  const router = useRouter();
  const toast = useToast();
  const [products, setProducts] = useState<PublicProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await listPublicProducts();
      if (!res.ok) {
        setError(apiError(res, 'Impossible de charger le catalogue.'));
        return;
      }
      setProducts((res.data as PublicProduct[]) ?? []);
    })();
  }, []);

  async function commander(p: PublicProduct) {
    if (ordering) return;
    setOrdering(p.id);
    setError(null);
    const res = await createCheckoutIntent(p.id);
    setOrdering(null);
    if (!res.ok) {
      toast.error(apiError(res, 'Commande indisponible pour ce produit.'));
      return;
    }
    toast.ok('Catalogue validé — choisissez comment créer votre compte.');
    const q = new URLSearchParams({ register: '1', product: p.name });
    router.push(`/auth?${q.toString()}`);
  }

  const grouped = (products ?? []).reduce<Record<string, PublicProduct[]>>((acc, p) => {
    (acc[p.kind] ??= []).push(p);
    return acc;
  }, {});

  return (
    <AppShell me={null} nav={[]} bare={false} footStatus="Catalogue public">
      <div className="offres">
        {/* ── En-tête ─────────────────────────────────────────────────── */}
        <section className="offres-hero">
          <span className="landing-chip"><span className="landing-chip-dot" /> Catalogue public</span>
          <h1>
            Des offres simples, <span className="landing-gradient">commandées en un clic.</span>
          </h1>
          <p>
            Consultez les services {brand.name}. Votre compte est créé au moment de la commande —
            via Google, GitHub ou email et mot de passe.
          </p>
        </section>

        {/* ── Grille de cartes ────────────────────────────────────────── */}
        {!products && !error && <PageLoading label="Chargement du catalogue…" />}
        {error && (
          <div className="alert error offres-error" style={{ fontSize: 13.5 }}>
            {error}
          </div>
        )}
        {products && products.length === 0 && (
          <div className="panel">
            <EmptyState title="Aucune offre disponible pour le moment." />
          </div>
        )}

        {Object.entries(grouped).map(([kind, rows]) => {
          const meta = KIND_META[kind] ?? { icon: IconServer, label: kind, desc: '' };
          const Icon = meta.icon;
          return (
            <section key={kind} className="offres-group">
              <div className="offres-group-head">
                <span className={`stat-icon violet`}><Icon size={17} /></span>
                <div>
                  <h2>{meta.label}</h2>
                  {meta.desc && <p className="muted">{meta.desc}</p>}
                </div>
              </div>
              <div className="offres-grid">
                {rows.map((p) => (
                  <div key={p.id} className={`offres-card${p.status !== 'ACTIVE' ? ' disabled' : ''}`}>
                    <div className="offres-card-top">
                      <b>{p.name}</b>
                      {p.status === 'ACTIVE' ? (
                        <Badge tone="ok">Disponible</Badge>
                      ) : (
                        <Badge tone="warn">{p.status}</Badge>
                      )}
                    </div>
                    <p className="offres-card-desc">{meta.desc || 'Service disponible dans le catalogue.'}</p>
                    <div className="offres-price">
                      <span className="offres-price-num">Abonnement</span>
                      <span className="offres-price-sub">mensuel</span>
                    </div>
                    <Button
                      className="offres-cta"
                      onClick={() => commander(p)}
                      disabled={p.status !== 'ACTIVE' || ordering === p.id}
                      busy={ordering === p.id}
                    >
                      {p.status === 'ACTIVE' ? (
                        <>Commander <IconChevronRight size={14} /></>
                      ) : (
                        'Indisponible'
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {/* ── Rassurance ──────────────────────────────────────────────── */}
        <section className="offres-perks">
          {PERKS.map((t) => (
            <div key={t} className="offres-perk">
              <span className="offres-perk-check"><IconCheck size={13} /></span>
              {t}
            </div>
          ))}
        </section>

        <div className="offres-foot">
          <Button variant="secondary" onClick={() => router.push('/auth')}>
            J’ai déjà un compte — se connecter
          </Button>
          <span className="muted" style={{ fontSize: 12.5 }}>
            <IconShield size={13} /> Vos données et votre compte sont protégés par les réglages de sécurité de la plateforme.
          </span>
        </div>
      </div>
    </AppShell>
  );
}
