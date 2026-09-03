'use client';

import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { brand } from '@/config/brand';
import {
  IconBoxes,
  IconChevronRight,
  IconDatabase,
  IconGlobe,
  IconLayers,
  IconLifeBuoy,
  IconServer,
  IconShield,
  IconUsers,
} from '@/components/icons';

const FEATURES = [
  {
    icon: IconServer,
    tone: 'primary',
    title: 'Déploiements Git → hébergement',
    desc: 'Connectez vos repositories GitHub et déployez en un clic sur votre serveur Coolify, avec statut en direct.',
  },
  {
    icon: IconShield,
    tone: 'violet',
    title: 'Sécurité pilotée par vous',
    desc: 'Turnstile anti-bot, OAuth Google/GitHub, double authentification — chaque option s’active et se configure librement.',
  },
  {
    icon: IconDatabase,
    tone: 'info',
    title: 'Infrastructure observée',
    desc: 'Sonde de connectivité, métriques serveur et détails d’infrastructure pour suivre chaque machine en temps réel.',
  },
  {
    icon: IconUsers,
    tone: 'amber',
    title: 'Support structuré',
    desc: 'Tickets escaladables, code d’accès sécurisé pour les équipes support, et centre d’aide toujours à jour.',
  },
  {
    icon: IconBoxes,
    tone: 'cyan',
    title: 'Produits & souscriptions',
    desc: 'Catalogue commandable directement, commande liée à votre compte, suivi de vos services actifs.',
  },
  {
    icon: IconGlobe,
    tone: 'pink',
    title: 'Panel multi-serveurs',
    desc: 'Connectez Hestia, Coolify ou d’autres panneaux réels — vos serveurs, votre contrôle central.',
  },
] as const;

export default function Home() {
  return (
    <AppShell me={null} nav={[]} bare={false} footStatus="Tous les services opérationnels">
      <div className="landing">
        {/* ── Héro ─────────────────────────────────────────────────────── */}
        <section className="landing-hero">
          <div className="landing-hero-inner">
            <span className="landing-chip">
              <span className="landing-chip-dot" />
              Plateforme d’hébergement nouvelle génération
            </span>
            <h1 className="landing-title">
              Votre hébergement,{' '}
              <span className="landing-gradient">piloté depuis un seul endroit.</span>
            </h1>
            <p className="landing-sub">
              {brand.name} centralise vos serveurs, vos déploiements, votre sécurité et votre support —
              dans une console rapide, moderne et pensée pour la conversion.
            </p>
            <div className="landing-cta">
              <Link className="btn-primary btn-lg" href="/auth">
                Commencer maintenant <IconChevronRight size={16} />
              </Link>
              <Link className="btn-secondary btn-lg" href="/offres">
                Voir les offres
              </Link>
            </div>
            <div className="landing-trust">
              <span><span className="landing-trust-dot ok" /> Hébergement géré</span>
              <span><span className="landing-trust-dot ok" /> Sécurité renforcée</span>
              <span><span className="landing-trust-dot ok" /> Support réactif</span>
            </div>
          </div>

          {/* Carte produit stylisée (vitrine) */}
          <div className="landing-showcase" aria-hidden>
            <div className="landing-window">
              <div className="landing-window-bar">
                <span className="landing-win-dot r" /><span className="landing-win-dot y" /><span className="landing-win-dot g" />
                <span className="landing-win-url">app.{brand.name.split(' ')[0].toLowerCase()} · Console</span>
              </div>
              <div className="landing-window-body">
                <div className="landing-row">
                  <div className="landing-cell">
                    <span className="landing-cell-label">Serveurs</span>
                    <b>4</b>
                    <span className="badge badge-ok">En ligne</span>
                  </div>
                  <div className="landing-cell">
                    <span className="landing-cell-label">Services actifs</span>
                    <b>12</b>
                    <span className="badge badge-info">Stables</span>
                  </div>
                  <div className="landing-cell">
                    <span className="landing-cell-label">Déploiements</span>
                    <b>7</b>
                    <span className="badge badge-violet">Git</span>
                  </div>
                </div>
                <div className="landing-spark">
                  <span className="landing-spark-line" style={{ height: '38%' }} />
                  <span className="landing-spark-line" style={{ height: '62%' }} />
                  <span className="landing-spark-line" style={{ height: '48%' }} />
                  <span className="landing-spark-line" style={{ height: '80%' }} />
                  <span className="landing-spark-line" style={{ height: '58%' }} />
                  <span className="landing-spark-line" style={{ height: '92%' }} />
                  <span className="landing-spark-line" style={{ height: '70%' }} />
                  <span className="landing-spark-line" style={{ height: '100%' }} />
                  <span className="landing-spark-line" style={{ height: '78%' }} />
                  <span className="landing-spark-line" style={{ height: '86%' }} />
                </div>
                <div className="landing-window-foot">
                  <span className="landing-win-pill"><IconShield size={12} /> Turnstile actif</span>
                  <span className="landing-win-pill"><IconLayers size={12} /> MFA</span>
                  <span className="landing-win-pill"><IconLifeBuoy size={12} /> Support L1→L3</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Fonctionnalités ─────────────────────────────────────────── */}
        <section className="landing-section">
          <div className="landing-section-head">
            <span className="hero-eyebrow">Capacités</span>
            <h2>Une console complète, sans friction</h2>
            <p>Tout ce qu’il faut pour gérer votre infrastructure et vos clients — au même endroit, sans allers-retours.</p>
          </div>
          <div className="landing-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="landing-feature">
                <span className={`stat-icon ${f.tone}`}><f.icon size={18} /></span>
                <b>{f.title}</b>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Bandeau statistiques ────────────────────────────────────── */}
        <section className="landing-band">
          <div className="landing-band-item">
            <b>99,9&nbsp;%</b><span>Disponibilité cible</span>
          </div>
          <div className="landing-band-item">
            <b>2&nbsp;min</b><span>Premier déploiement</span>
          </div>
          <div className="landing-band-item">
            <b>24/7</b><span>Supervision des serveurs</span>
          </div>
          <div className="landing-band-item">
            <b>1</b><span>Console pour tout piloter</span>
          </div>
        </section>

        {/* ── CTA final ───────────────────────────────────────────────── */}
        <section className="landing-cta-card">
          <h2>Prêt à passer à la vitesse supérieure&nbsp;?</h2>
          <p>Connectez-vous ou commandez votre premier service en quelques secondes.</p>
          <div className="landing-cta">
            <Link className="btn-primary btn-lg" href="/auth">
              Se connecter <IconChevronRight size={16} />
            </Link>
            <Link className="btn-secondary btn-lg" href="/offres">
              Découvrir les offres
            </Link>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
