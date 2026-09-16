#!/usr/bin/env node
/**
 * TESTS de la Roadmap produit (readiness) — feuille de route Phase 2.
 *
 * Aucune infrastructure de test n'existe côté web (web/package.json ne porte que
 * `build` ; pas de vitest/jest). Pour tester la VRAIE logique de readiness sans
 * introduire un nouveau framework, on transpile en mémoire le module pur
 * `product-roadmap-logic.ts` (qui n'importe que des types — éliminés à la
 * transpilation) avec le compilateur TypeScript déjà installé, puis on exécute
 * les assertions via `node:assert`.
 *
 * Usage :  node scripts/readiness-tests.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');

const logicPath = join(__dirname, '..', 'src', 'components', 'admin', 'product-roadmap-logic.ts');
const source = readFileSync(logicPath, 'utf8');

const out = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
});

const tmpFile = join(tmpdir(), `product-roadmap-logic-${Date.now()}.cjs`);
writeFileSync(tmpFile, out.outputText + '\n');
let mod;
try {
  mod = require(tmpFile);
} finally {
  unlinkSync(tmpFile);
}

const { buildRoadmap } = mod;

// ── Helpers ──────────────────────────────────────────────────────────────
const DEPLOY_SECTION = 'Déploiement de l’app client';

function deploySection(product) {
  const sec = buildRoadmap(product).find((s) => s.section === DEPLOY_SECTION);
  assert.ok(sec, `section « ${DEPLOY_SECTION} » présente`);
  return sec;
}

function labels(items) {
  return items.map((i) => i.label);
}

function findServeur(items) {
  return items.find((i) => i.label.startsWith('Serveur Coolify'));
}

/** Payload admin produit tel que renvoyé par l'API (PRODUCT_INCLUDE) :
 *  la relation pack.deploymentModule porte kind + server ; AUCUN scalaire
 *  `deploymentModuleId` n'est présent dans la payload. */
function productWithServer(hostname) {
  return {
    id: 'p1',
    name: 'Produit Test',
    kind: 'APP',
    status: 'ACTIVE',
    pack: {
      id: 'pk1',
      name: 'Pack Pro',
      ramMb: 512,
      cpuCores: 1,
      freeSubdomainsIncluded: 2,
      // ⚠ aucune propriété `deploymentModuleId` — fidèle à la payload réelle.
      deploymentModule: {
        id: 'modB',
        code: 'mod-b',
        name: 'Module B',
        kind: 'PER_CLIENT_PROJECT',
        server: { id: 'srv1', hostname },
      },
    },
    moduleParams: {
      repoUrl: 'https://github.com/acme/demo.git',
      branch: 'main',
      buildPack: 'nixpacks',
      publishDirectory: '',
      isStatic: false,
      appName: 'demo',
    },
  };
}

let passed = 0;
function run(title, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${title}`);
  } catch (e) {
    console.error(`  ✗ ${title}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

// ── TEST 1 : module + serveur valides → serveur configuré (ok) ───────────
run('TEST 1 — deploymentModule.server valide → « Serveur Coolify configuré »', () => {
  const sec = deploySection(productWithServer('119.12.34.56'));
  const srv = findServeur(sec.items);
  assert.equal(srv.status, 'ok');
  assert.equal(srv.label, 'Serveur Coolify configuré');
  assert.equal(srv.hint, '119.12.34.56');
  assert.ok(!sec.items.some((i) => i.label === 'Serveur Coolify non configuré'));
});

// ── TEST 2 : réel besoin serveur mais AUCUN serveur → BLOCKING ───────────
run('TEST 2 — pack avec module mais sans server → BLOCKING « Serveur non configuré »', () => {
  const p = productWithServer(null); // server explicitement null dans la relation
  const sec = deploySection(p);
  const srv = findServeur(sec.items);
  assert.equal(srv.status, 'error', 'doit rester bloquant (module sans serveur)');
  assert.equal(srv.label, 'Serveur Coolify non configuré');
});

// ── TEST 3 : `deploymentModuleId` absent mais relation server présente → aucun faux BLOCKING
run('TEST 3 — scalaire deploymentModuleId absent + relation server présente → aucun faux BLOCKING', () => {
  const p = productWithServer('portal.example.test');
  assert.equal(p.pack.deploymentModuleId, undefined, 'la payload ne porte aucun deploymentModuleId');
  const sec = deploySection(p);
  const srv = findServeur(sec.items);
  assert.equal(srv.status, 'ok');
  assert.ok(!sec.items.some((i) => i.label === 'Serveur Coolify non configuré'));
});

// ── TEST 4 : reload / payload admin (forme réelle complète) → readiness correcte
run('TEST 4 — payload admin (reload) → serveur ok, module de déploiement résolu, type B', () => {
  const p = productWithServer('portal.example.test');
  // On re-lit exactement la payload telle que PRODUCT_INCLUDE la renvoie.
  const sec = deploySection(p);
  const mod = sec.items.find((i) => i.label.startsWith('Module de déploiement :'));
  assert.equal(mod.status, 'ok');
  assert.ok(mod.label.includes('Module B'));
  assert.ok(sec.items.some((i) => i.label === 'Module type B'));
  assert.equal(findServeur(sec.items).status, 'ok');
});

// ── TEST 5 : produit/module où la vérif serveur est NOT_APPLICABLE (aucun pack) → info, pas d'erreur
run('TEST 5 — aucun pack → validation serveur NOT_APPLICABLE (info), aucune fausse erreur bloquante', () => {
  const p = productWithServer(null);
  delete p.pack; // produit non déployable (aucun pack lié)
  const sec = deploySection(p);
  assert.ok(sec.items.length > 0, 'une ligne info demeure');
  assert.ok(sec.items.every((i) => i.status === 'info'), 'déploiement non applicable = info uniquement');
  assert.ok(!sec.items.some((i) => i.status === 'error'), 'aucun faux BLOCKING serveur');
  assert.ok(sec.items.some((i) => i.label.includes('déploiement non applicable')));
  // La nudge « choisir un pack » reste portée par la section Pack & classification (BLOCKING réel).
  const packSec = buildRoadmap(p).find((s) => s.section === 'Pack & classification');
  assert.ok(packSec.items.some((i) => i.status === 'error' && i.label === 'Aucun pack sélectionné'));
});

console.log(`\n${passed}/5 readiness tests passés.`);
if (process.exitCode) process.exit(process.exitCode);