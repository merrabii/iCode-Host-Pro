'use client';

import {
  buildRoadmap,
  type RoadmapItem,
  type RoadmapTabKey,
} from '@/components/admin/product-roadmap-logic';
import type { ProductAdmin } from '@/lib/api';
import { Badge } from '@/components/ui';

export type { RoadmapTabKey } from '@/components/admin/product-roadmap-logic';

/**
 * Onglet « Roadmap » — tableau de bord de mise en configuration du produit.
 * Analyse l'état courant du produit (identité, vitrine, pack, déploiement) et
 * affiche une checklist pas-à-pas : ce qui est fait, ce qui manque, ce qui est
 * incorrect ou bloquant. Chaque ligne renvoie vers l'onglet à corriger.
 *
 * La logique de construction de la checklist vit dans `product-roadmap-logic.ts`
 * (module pur, sans React, testable). Le serveur/module de déploiement y est lu
 * depuis la relation réelle `pack.deploymentModule.server` (la même que le
 * provisioning) — plus aucun cross-lookup sur un scalaire `deploymentModuleId`
 * absent de la payload.
 */
export type { RoadmapItem } from '@/components/admin/product-roadmap-logic';

type Level = RoadmapItem['status'];

const LEVEL_META: Record<Level, { icon: string; tone: string; title: string }> = {
  ok: { icon: '✔', tone: 'green', title: 'Fait' },
  warn: { icon: '⚠', tone: 'amber', title: 'À corriger / manquant' },
  error: { icon: '✖', tone: 'red', title: 'Bloquant' },
  info: { icon: 'ℹ', tone: 'blue', title: 'Info' },
};

function summarize(scored: RoadmapItem[]): { ok: number; warn: number; error: number } {
  const s = { ok: 0, warn: 0, error: 0 };
  for (const it of scored) if (it.status === 'ok') s.ok++; else if (it.status === 'warn') s.warn++; else if (it.status === 'error') s.error++;
  return s;
}

function RoadmapRow({ item }: { item: RoadmapItem }) {
  const m = LEVEL_META[item.status];
  return (
    <div className="row" style={{ gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-soft)', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
        <span
          style={{
            width: 20, height: 20, flex: '0 0 20px', borderRadius: 20,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, marginTop: 1,
            color: '#fff', background: m.tone === 'green' ? 'var(--success)' : m.tone === 'amber' ? 'var(--warning)' : m.tone === 'red' ? 'var(--danger)' : 'var(--info)',
          }}
          title={m.title}
        >
          {m.icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{item.label}</div>
          {item.hint && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{item.hint}</div>}
        </div>
      </div>
      <Badge tone={m.tone === 'green' ? 'green' : m.tone === 'red' ? 'red' : 'amber'}>{m.title}</Badge>
    </div>
  );
}

/**
 * La barre de progression globale (fait / à corriger / bloquant) + sections,
 * affichée en tête de l'éditeur (onglet Roadmap).
 */
export function ProductRoadmapTab({
  product,
  onNavigate,
}: {
  product: ProductAdmin;
  onNavigate?: (tab: RoadmapTabKey) => void;
}) {
  const sections = buildRoadmap(product);
  const all = sections.flatMap((s) => s.items);
  const { ok, warn, error } = summarize(all);
  const total = all.length;
  const pct = total ? Math.round((ok / total) * 100) : 0;

  return (
    <div>
      <div className="alert info" style={{ marginBottom: 14 }}>
        <b>Roadmap de mise en configuration.</b> Suivez la checklist ci-dessous : chaque passage
        indique ce qui est fait, ce qui manque ou ce qui est incorrect/bloquant, et renvoie vers
        l&apos;onglet à corriger. Le produit n&apos;est vraiment prêt que quand il ne reste plus
        de ligne <b style={{ color: 'var(--danger)' }}>bloquante</b> ni <b style={{ color: 'var(--warning)' }}>à corriger</b>.
      </div>

      <div className="card cell" style={{ padding: '12px 14px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              Préparation du produit : {ok} / {total} étapes validées
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {error > 0 && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{error} bloquant(s) · </span>}
              {warn > 0 && <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{warn} à corriger · </span>}
              {warn === 0 && error === 0 && <span style={{ color: 'var(--success)' }}>Configuration complète ✓</span>}
            </div>
          </div>
          <div style={{ width: 200, maxWidth: '100%', height: 10, borderRadius: 6, background: 'var(--bg-2)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 6, background: pct === 100 ? 'var(--success)' : pct >= 60 ? 'var(--info)' : 'var(--warning)' }} />
          </div>
        </div>
      </div>

      {sections.map((s) => (
        <div key={s.section} style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ marginBottom: 4 }}>
            <h3 style={{ fontSize: 13.5, margin: 0 }}>{s.section}</h3>
          </div>
          <div className="card cell" style={{ padding: '8px 14px' }}>
            {s.items.map((it) =>
              it.tab && onNavigate ? (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => onNavigate(it.tab!)}
                  style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  title={`Aller à l’onglet ${it.tab}`}
                >
                  <RoadmapRow item={it} />
                </button>
              ) : (
                <RoadmapRow key={it.label} item={it} />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default ProductRoadmapTab;