'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { StoreShell } from '@/components/store-shell';
import { useBrand } from '@/components/brand-provider';
import {
  IconBoxes,
  IconChevronRight,
  IconDatabase,
  IconGrid,
  IconLifeBuoy,
  IconServer,
  IconShield,
} from '@/components/icons';
import {
  apiError,
  billingCycleLabel,
  formatCents,
  listPublicProducts,
  type PublicProduct,
} from '@/lib/api';

const PERKS = [
  'Déploiement depuis Git',
  'Espace client et quota',
  'Sécurité paramétrable',
  'Support par tickets',
] as const;

const STEPS = [
  {
    n: '1',
    title: 'Créez votre compte',
    desc: 'Inscription en quelques champs, puis confirmation : vous obtenez votre espace client personnel.',
    href: '/auth',
    link: 'Ouvrir la page Connexion',
  },
  {
    n: '2',
    title: 'Choisissez une offre',
    desc: 'La Boutique présente les offres disponibles, leurs prix et leurs capacités ; la commande est liée à votre compte.',
    href: '/shop',
    link: 'Parcourir la Boutique',
  },
  {
    n: '3',
    title: 'Déployez et suivez',
    desc: 'Depuis votre espace, déployez votre dépôt Git et consultez l’état de chaque application ainsi que votre quota.',
    href: '/client',
    link: 'Accéder à l’espace client',
  },
] as const;

const FEATURES = [
  {
    icon: IconServer,
    title: 'Déploiements Git → hébergement',
    desc: 'Connectez votre compte GitHub ou collez l’URL d’un dépôt : l’application est créée et son état s’affiche au même endroit.',
  },
  {
    icon: IconShield,
    title: 'Sécurité du compte',
    desc: 'Gérez la double authentification depuis votre profil. Les autres moyens de connexion dépendent des options activées sur la plateforme.',
  },
  {
    icon: IconGrid,
    title: 'Espace client complet',
    desc: 'Applications, quota d’hébergement, commandes et souscriptions réunis dans une seule rubrique.',
  },
  {
    icon: IconLifeBuoy,
    title: 'Support structuré',
    desc: 'Des tickets avec suivi, un code d’accès pour les équipes support et un centre d’aide consultable sans compte.',
  },
  {
    icon: IconDatabase,
    title: 'Suivi des ressources',
    desc: 'Chaque pack indique ses ressources (RAM, processeur, emplacements) avant comme après la commande.',
  },
  {
    icon: IconBoxes,
    title: 'Commandes liées au compte',
    desc: 'Chaque commande est rattachée à votre identité, avec un suivi de statut jusqu’à l’activation du service.',
  },
] as const;

const FAQ = [
  {
    q: 'Comment se déroule une commande ?',
    a: 'Vous choisissez une offre dans la Boutique, créez votre compte puis validez votre commande : coordonnées, sous-domaine et suivi du service se font depuis votre espace client.',
  },
  {
    q: 'Faut-il un compte GitHub pour déployer ?',
    a: 'Non. Vous pouvez lier votre compte GitHub, ou coller l’URL d’un dépôt Git public et laisser la plateforme détecter le dépôt et la branche.',
  },
  {
    q: 'Où trouver de l’aide ?',
    a: 'Le centre d’aide regroupe les questions fréquentes, et le support passe par des tickets ouverts depuis votre espace client.',
  },
] as const;

type PriceState =
  | { kind: 'amount'; cents: number }
  | { kind: 'zero' }
  | { kind: 'absent' };

/**
 * Prix affiché sur l'accueil : UNIQUEMENT `priceHtCents`, le prix actuellement
 * facturé (fiche `/shop/[slug]` et checkout API : `base = priceHtCents ?? 0`).
 * `promoPriceHtCents` n'est pas affiché ici, même barré : l'incohérence promo
 * entre administration, boutique et facturation est documentée séparément et
 * non reproduite sur cette page (rapport recette §10).
 * Trois états explicites — jamais un test de vérité/faux des nombres :
 * positif → montant + cycle ; zéro → montant zéro + cycle ; absent → « Tarif
 * à consulter » (la carte est elle-même le lien vers la fiche produit).
 */
function priceState(p: PublicProduct): PriceState {
  const price = p.priceHtCents;
  if (price === null || price === undefined) return { kind: 'absent' };
  if (price === 0) return { kind: 'zero' };
  return { kind: 'amount', cents: price };
}

/** Carte offre — prix et cycle lus sur le catalogue public (mêmes helpers que /shop). */
function OfferCard({ p }: { p: PublicProduct }) {
  const href = p.slug ? `/shop/${p.slug}` : '/shop';
  const price = priceState(p);
  return (
    <Link href={href} className="store-card">
      <div className="store-card-head">
        <span
          className="store-card-swatch"
          style={{ background: p.color ?? 'var(--brand-primary)' }}
          aria-hidden
        />
        <span className="store-card-cat">{p.category?.name ?? p.kind}</span>
      </div>
      <h3>{p.name}</h3>
      <p className="store-card-desc">
        {p.slogan || p.shortDescription || 'Service disponible dans la boutique.'}
      </p>
      {p.pack && (
        <div className="store-resources">
          {p.pack.ramMb ? <span>{p.pack.ramMb} Mo RAM</span> : null}
          {p.pack.cpuCores ? <span>{p.pack.cpuCores} CPU</span> : null}
          {p.pack.storageLimit ? <span>{p.pack.storageLimit} Go</span> : null}
          {p.pack.bandwidth ? <span>{p.pack.bandwidth}</span> : null}
        </div>
      )}
      <div className="store-card-foot">
        {price.kind === 'absent' ? (
          // Prix absent : libellé explicite — la carte entière est déjà le lien
          // vers la fiche produit (aucun lien imbriqué).
          <span className="muted" style={{ fontSize: 13 }}>Tarif à consulter</span>
        ) : (
          <div className="store-price">
            <span className="store-price-num">{formatCents(price.kind === 'zero' ? 0 : price.cents)}</span>
            <span className="store-price-meta">{billingCycleLabel(p.billingCycle)}</span>
          </div>
        )}
        <span className="store-card-view">
          Voir l’offre <IconChevronRight size={14} />
        </span>
      </div>
    </Link>
  );
}

export default function Home() {
  const { brand } = useBrand();
  const [products, setProducts] = useState<PublicProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await listPublicProducts();
      if (!alive) return;
      if (!res.ok) {
        setError(apiError(res, 'Catalogue indisponible.'));
        return;
      }
      setProducts((res.data as PublicProduct[]) ?? []);
    })();
    return () => { alive = false; };
  }, []);

  const highlights = useMemo(
    () => (products ?? []).filter((p) => p.status === 'ACTIVE' && p.slug).slice(0, 3),
    [products],
  );

  return (
    <StoreShell>
      <div className="landing">
        {/* ── Héro (question du service + vitrine sans chiffres) ───────── */}
        <section className="landing-hero">
          <div className="landing-hero-inner">
            <span className="landing-chip">
              <span className="landing-chip-dot" />
              Console unique pour vos applications
            </span>
            <h1 className="landing-title">
              Qu’est-ce que {brand.name}&nbsp;?{' '}
              <span className="landing-gradient">Votre hébergement, piloté d’un seul endroit.</span>
            </h1>
            <p className="landing-sub">
              Une plateforme où vous créez votre compte, commandez une offre d’hébergement,
              déployez une application depuis votre dépôt Git et suivez vos services — sans
              changer d’outil à chaque étape.
            </p>
            <div className="landing-cta">
              <Link className="btn-primary btn-lg" href="/shop">
                Voir les offres <IconChevronRight size={16} />
              </Link>
              <Link className="btn-secondary btn-lg" href="/auth">
                Créer un compte
              </Link>
            </div>
            <div className="landing-trust">
              {PERKS.map((t) => (
                <span key={t}><span className="landing-trust-dot ok" /> {t}</span>
              ))}
            </div>
          </div>

          {/* Illustration décorative : libellés seuls, aucun chiffre ni indicateur réel */}
          <div className="landing-showcase" aria-hidden>
            <div className="landing-window">
              <div className="landing-window-bar">
                <span className="landing-win-dot r" /><span className="landing-win-dot y" /><span className="landing-win-dot g" />
                <span className="landing-win-url">espace client · mes applications</span>
              </div>
              <div className="landing-window-body">
                <div className="landing-win-list">
                  <div className="landing-win-item">
                    <b>Mon application</b>
                    <span>dépôt Git · branche principale</span>
                  </div>
                  <div className="landing-win-item">
                    <b>Quota d’hébergement</b>
                    <span>emplacements utilisés · disponibles</span>
                  </div>
                  <div className="landing-win-item">
                    <b>Commande en cours</b>
                    <span>statut suivi depuis le compte</span>
                  </div>
                </div>
                <div className="landing-window-foot">
                  <span className="landing-win-pill">Déploiement Git</span>
                  <span className="landing-win-pill">Double authentification</span>
                  <span className="landing-win-pill">Sous-domaine gratuit</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Trois étapes ─────────────────────────────────────────────── */}
        <section className="landing-section">
          <div className="landing-section-head">
            <span className="hero-eyebrow">Démarrer</span>
            <h2>Trois étapes, dans l’ordre</h2>
            <p>Chaque étape mène à une page réelle de la plateforme : vous savez toujours où cliquer.</p>
          </div>
          <div className="landing-features">
            {STEPS.map((s) => (
              <div key={s.n} className="landing-feature">
                <span className="landing-step-num">{s.n}</span>
                <b>{s.title}</b>
                <p>{s.desc}</p>
                <Link className="landing-step-link" href={s.href}>
                  {s.link} <IconChevronRight size={14} />
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* ── Fonctionnalités disponibles ──────────────────────────────── */}
        <section className="landing-section">
          <div className="landing-section-head">
            <span className="hero-eyebrow">La plateforme</span>
            <h2>Ce que la console regroupe</h2>
            <p>Six fonctions déjà disponibles aujourd’hui, sans promesse de ce qui n’existe pas encore.</p>
          </div>
          <div className="landing-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="landing-feature">
                <span className="stat-icon primary"><f.icon size={18} /></span>
                <b>{f.title}</b>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Aperçu des offres (catalogue public en direct) ───────────── */}
        <section className="landing-section">
          <div className="landing-section-head">
            <span className="hero-eyebrow">Ensuite : les offres</span>
            <h2>Un aperçu, puis le catalogue réel</h2>
            <p>
              Les cartes ci-dessous sont lues en direct depuis la Boutique : prix, capacités et
              disponibilités font foi sur la page Boutique.
            </p>
          </div>

          {!products && !error && (
            <div className="store-loading" role="status">
              <span className="spinner" aria-hidden /> Chargement des offres…
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              {error} <Link href="/shop">Ouvrir la Boutique</Link>
            </div>
          )}
          {products && highlights.length === 0 && (
            <p className="store-empty">
              Aucune offre disponible pour le moment. <Link href="/shop">Voir la Boutique</Link>
            </p>
          )}
          {highlights.length > 0 && (
            <div className="store-grid">
              {highlights.map((p) => <OfferCard key={p.id} p={p} />)}
            </div>
          )}
          <div className="landing-cta" style={{ justifyContent: 'center' }}>
            <Link className="btn-secondary btn-lg" href="/shop">
              Comparer toutes les offres <IconChevronRight size={16} />
            </Link>
          </div>
        </section>

        {/* ── Questions fréquentes ─────────────────────────────────────── */}
        <section className="landing-section">
          <div className="landing-section-head">
            <span className="hero-eyebrow">Avant de commencer</span>
            <h2>Questions fréquentes</h2>
          </div>
          <div className="landing-faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
          <div className="landing-cta" style={{ justifyContent: 'center' }}>
            <Link className="btn-secondary btn-lg" href="/aide">
              Consulter le centre d’aide
            </Link>
          </div>
        </section>

        {/* ── CTA final ────────────────────────────────────────────────── */}
        <section className="landing-cta-card">
          <h2>À vous de jouer</h2>
          <p>
            Créez votre compte, ou consultez d’abord les offres : les deux chemins mènent au même
            espace client.
          </p>
          <div className="landing-cta">
            <Link className="btn-primary btn-lg" href="/auth">
              Créer un compte <IconChevronRight size={16} />
            </Link>
            <Link className="btn-secondary btn-lg" href="/shop">
              Voir les offres
            </Link>
          </div>
        </section>
      </div>
    </StoreShell>
  );
}
