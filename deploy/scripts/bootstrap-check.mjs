#!/usr/bin/env node
/**
 * Code Diali — contrôle des gates de premier démarrage (GO §5 + revue V2).
 *
 * MODE --first-boot : TOUTE activation sensible (env OU base) = ÉCHEC (exit 1).
 * MODE contrôle courant : activations = avertissements (activation possible
 * après autorisation documentée) ; toute lecture impossible = exit 2 (jamais
 * conforme, même partiellement).
 *
 * Contrôles :
 *   1. Env « EFFECTIF » du processus (voir honnêteté ci-dessous) :
 *      PAYMENT_SIMULATOR_ENABLED, HOSTING_C2/C3/C4_ENABLED,
 *      ORDER_SWEEP_ENABLED, RENEWAL_SWEEP_ENABLED, RECONCILE_ENABLED.
 *   2. PaymentSettings (base) : cardTopupEnabled ET cardOrderPaymentEnabled
 *      (les DEUX gates carte) — défaut schéma cardTopupEnabled=true.
 *   3. ReconcileSetting (base, singleton id='reconcile') : overrides DB
 *      PRIORITAIRES sur env, selon la priorité réelle du code
 *      (ReconcileSettingsService : DB → env → défauts). Un override DB
 *      enabled=true active le réconciliateur même si RECONCILE_ENABLED=false.
 *   4. Toute lecture impossible (connexion, table absente, requête en échec)
 *      = exit 2 — jamais conforme.
 *
 * HONNÊTETÉ (limite du contrôle) : ce script lit SON propre environnement de
 * processus. Dans la stack compose, le job `check-gates` partage l'ancre
 * d'environnement `x-api-env` du service `api` : l'env du checker EST
 * constructuellement celui de l'API (même fichier YAML). Une divergence d'env
 * INTRODUITE hors de ce partagement (ex : autre orchestration) n'est pas
 * détectable par ce script — c'est une limite documentée, pas une garantie.
 * La config EFFECTIVE de l'API au boot = cet env + défauts du code ; les
 * overrides DB réconciliateur sont lus ici avec la même priorité que le code.
 *
 * Usage : node bootstrap-check.mjs [--first-boot]
 * Exit : 0 = conforme ; 1 = écart ; 2 = impossible de vérifier.
 */
import { createRequire } from 'module';
import path from 'path';
// Résoudre @prisma/client depuis le CWD du conteneur (/repo/apps/api).
const req = createRequire(path.join(process.cwd(), 'noop.js'));
const { PrismaClient } = req('@prisma/client');

const firstBoot = process.argv.includes('--first-boot');
const fails = [];
const warns = [];

const envTrue = (v) => v === 'true';

async function main() {
  const env = process.env;
  const mode = firstBoot ? 'premier démarrage' : 'contrôle courant';
  console.log(`[check-gates] mode=${mode} (env du processus = env du service api via ancre compose x-api-env)`);
  if (env.NODE_ENV === 'production') console.log('[check-gates] NODE_ENV=production');

  // ── 1. Env « effectif » (celui partagé avec le service api) ───────────────
  if (envTrue(env.PAYMENT_SIMULATOR_ENABLED)) {
    const msg =
      'PAYMENT_SIMULATOR_ENABLED=true : le code refuse le simulateur en production ' +
      '(payment-provider.service.ts) ; la variable ne doit jamais être posée à true.';
    if (firstBoot || env.NODE_ENV === 'production') fails.push(msg);
    else warns.push(msg);
  }
  for (const flag of [
    'HOSTING_C2_ENABLED',
    'HOSTING_C3_ENABLED',
    'HOSTING_C4_ENABLED',
    'ORDER_SWEEP_ENABLED',
    'RENEWAL_SWEEP_ENABLED',
    'RECONCILE_ENABLED',
  ]) {
    if (envTrue(env[flag])) {
      const msg = `${flag}=true (env) : activation détectée.`;
      if (firstBoot) fails.push(msg + ' Premier démarrage : doit être OFF.');
      else warns.push(msg + ' Activation autorisée ?');
    }
  }

  // ── Base : toute lecture impossible = exit 2 (jamais conforme) ────────────
  const prisma = new PrismaClient();
  try {
    // 2. PaymentSettings — les DEUX gates carte.
    let settings = null;
    try {
      settings = await prisma.paymentSettings.findFirst();
    } catch (e) {
      console.error(
        `[check-gates][ERREUR] lecture PaymentSettings impossible: ${e.message || '(pas de message)'} code=${e.code || '?'}`,
      );
      console.error('[check-gates] lecture impossible = NON CONFORME (exit 2).');
      process.exit(2);
    }

    if (!settings) {
      console.log('[check-gates] PaymentSettings absent : défauts du schéma en vigueur :');
      console.log('  cardOrderPaymentEnabled = false (OFF) — conforme.');
      console.log('  cardTopupEnabled        = true (défaut schéma) — recharge carte ACTIVE par défaut.');
      const msg =
        "recharge carte (cardTopupEnabled) non explicitement OFF au premier démarrage " +
        "(défaut schéma true) — désactiver via l'admin (/manager/moyens-paiement) " +
        'ou PATCH /api/store/admin/payment-settings, puis relancer.';
      if (firstBoot) fails.push(msg);
      else warns.push(msg);
    } else {
      console.log(`[check-gates] PaymentSettings (id=${settings.id}) :`);
      console.log(`  walletPaymentEnabled       = ${settings.walletPaymentEnabled}`);
      console.log(`  cardOrderPaymentEnabled    = ${settings.cardOrderPaymentEnabled}`);
      console.log(`  cardTopupEnabled           = ${settings.cardTopupEnabled}`);
      if (settings.cardOrderPaymentEnabled) {
        const msg = 'cardOrderPaymentEnabled=true (base) : carte directe des commandes ACTIVE.';
        if (firstBoot) fails.push(msg + ' Premier démarrage : doit être OFF.');
        else warns.push(msg);
      }
      if (settings.cardTopupEnabled) {
        const msg = 'cardTopupEnabled=true (base) : recharge carte ACTIVE.';
        if (firstBoot) fails.push(msg + ' Premier démarrage : doit être OFF explicitement.');
        else warns.push(msg);
      }
    }

    // 3. ReconcileSetting — overrides DB PRIORITAIRES (priorité réelle du code :
    //    ReconcileSettingsService = resolveReconcileSettingsFull(env, overrides)
    //    = applyReconcileOverrides(env→défauts, db) ; DB non-null gagne sur env).
    let rec = null;
    try {
      rec = await prisma.reconcileSetting.findUnique({ where: { id: 'reconcile' } });
    } catch (e) {
      console.error(`[check-gates][ERREUR] lecture ReconcileSetting impossible: ${e.message}`);
      console.error('[check-gates] lecture impossible = NON CONFORME (exit 2).');
      process.exit(2);
    }

    // Résolution enabled avec la priorité réelle DB → env → défaut(false).
    const envRaw = (env.RECONCILE_ENABLED ?? '').trim().toLowerCase();
    let envParsed = false; // défaut du code : false
    if (envRaw === 'true' || envRaw === '1') envParsed = true;
    else if (envRaw === 'false' || envRaw === '0') envParsed = false;
    // valeur env invalide -> défaut false (warn silencieux côté code)

    let effectiveEnabled = false;
    let effectiveSource = 'DEFAULT';
    if (rec && rec.enabled !== null && rec.enabled !== undefined) {
      effectiveEnabled = rec.enabled;
      effectiveSource = 'DATABASE';
    } else if (envRaw !== '') {
      effectiveEnabled = envParsed;
      effectiveSource = 'ENV';
    }
    console.log(`[check-gates] réconciliateur : enabled=${effectiveEnabled} (source=${effectiveSource})` +
      (rec ? ` [override DB: enabled=${rec.enabled === null ? 'null' : rec.enabled}]` : ' [aucune ligne singleton]'));
    if (effectiveEnabled) {
      const msg =
        `réconciliateur EFFECTIF enabled=true (source=${effectiveSource})` +
        (effectiveSource === 'DATABASE' ? ' — override DB actif, prioritaire sur env.' : '');
      if (firstBoot) fails.push(msg + ' Premier démarrage : doit être OFF.');
      else warns.push(msg);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  // ── Rapport ───────────────────────────────────────────────────────────────
  for (const w of warns) console.warn(`[check-gates][AVERTISSEMENT] ${w}`);
  for (const f of fails) console.error(`[check-gates][ECART] ${f}`);
  if (fails.length) {
    console.error(`[check-gates] NON CONFORME — ${fails.length} écart(s).`);
    process.exit(1);
  }
  console.log(
    `[check-gates] CONFORME${warns.length ? ` (${warns.length} avertissement(s))` : ''}.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(`[check-gates][ERREUR] ${e.message}`);
  console.error('[check-gates] erreur inattendue = NON CONFORME (exit 2).');
  process.exit(2);
});
