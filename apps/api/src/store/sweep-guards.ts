import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * Q6 (GO item 6) — gardes communes des sweeps périodiques (`OrderLifecycle`
 * et `RenewalService`).
 *
 *  1. **Prérequis de schéma avant TOUTE mutation** : les passes lisent/écrivent
 *     des colonnes ajoutées par le socle ; sur une base pré-socle (colonne
 *     absente) AUCUNE mutation n'est tentée — le passage est ignoré avec un
 *     warn statique (jamais d'erreur, jamais de demi-état).
 *
 *  2. **Exclusion multi-processus (lease en base)** : le booléen `running`
 *     local n'est qu'une passe rapide dans un même processus ; l'exclusion
 *     RÉELLE entre processus (plusieurs instances API/worker) est une row CAS
 *     `SweepLease` à expiration — un porteur libère la passe dans son `finally`
 *     et, s'il plante, la passe revient libre au plus tard après le TTL.
 *     Les invariants métier (aucun double débit / double expiration / double
 *     suspension / double renouvellement) restent, eux, garantis par les CAS
 *     par ligne de chaque passe — jamais par ce verrou ni par `running`.
 */

/** Durée de vie du lease de passe (ms) — un porteur planté libère au plus tard ici. */
export const SWEEP_LEASE_TTL_MS = 180_000;

export interface SweepSchemaRequirement {
  /** Nom de table = nom du modèle Prisma (aucun `@@map` dans ce dépôt). */
  table: string;
  /** Colonnes exigées (absentes → échec). Omit = présence de la table seule. */
  columns?: string[];
}

/** Prérequis de la passe d'expiration/relance (`OrderLifecycleService`). */
export const ORDER_LIFECYCLE_SCHEMA: SweepSchemaRequirement[] = [
  { table: 'Order', columns: ['status', 'createdAt', 'renewsOrderId'] },
  { table: 'Invoice', columns: ['status', 'orderId'] },
  { table: 'OrderStatusHistory' },
];

/** Prérequis de la passe renouvellement/dunning/suspension (`RenewalService`). */
export const RENEWAL_SCHEMA: SweepSchemaRequirement[] = [
  {
    table: 'Order',
    columns: ['status', 'autoRenew', 'renewalConsentAt', 'renewsOrderId', 'nextBillingDate'],
  },
  {
    table: 'Invoice',
    columns: ['status', 'dueDate', 'dunningRemindedAt', 'subscriptionId', 'orderId'],
  },
  { table: 'InvoiceLine' },
  { table: 'Subscription', columns: ['status', 'orderId', 'productId'] },
  { table: 'OrderStatusHistory' },
  { table: 'BillingSetting', columns: ['dunningReminderDays', 'dunningGraceDays'] },
];

/**
 * Probe `information_schema` : toutes les tables/colonnes exigées sont-elles
 * présentes ? Retourne `false` sur toute erreur de lecture (échec = on ne
 * mutate JAMAIS dans le doute). Lecture seule — aucun effet de bord.
 */
export async function sweepSchemaPrereqsOk(
  db: Prisma.TransactionClient,
  requirements: SweepSchemaRequirement[],
): Promise<boolean> {
  try {
    for (const req of requirements) {
      const rows = await db.$queryRaw<Array<{ column_name: string }>>`
        SELECT "column_name" FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ${req.table}`;
      if (rows.length === 0) return false; // table absente
      for (const col of req.columns ?? []) {
        if (!rows.some((r) => r.column_name === col)) return false; // colonne absente
      }
    }
    return true;
  } catch {
    return false; // lecture impossible → aucun passage (safe)
  }
}

/**
 * Tente d'acquérir le lease de passe pour `name` : CAS sur une row existante
 * périmée, création si la row n'existe pas (course de création → P2002 →
 * l'autre porteur tient la passe). Retourne le jeton du porteur, ou `null`
 * si un AUTRE processus tient la passe ou si la base est indisponible
 * (jamais de mutation sans exclusion garantie).
 */
export async function acquireSweepLease(
  db: Prisma.TransactionClient,
  name: string,
): Promise<string | null> {
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SWEEP_LEASE_TTL_MS);
  try {
    const stolen = await db.sweepLease.updateMany({
      where: { name, expiresAt: { lt: now } },
      data: { holder: token, expiresAt },
    });
    if (stolen.count === 1) return token;
    const held = await db.sweepLease.findUnique({ where: { name } });
    if (held) return null; // lease vivant : un autre processus passe
    try {
      await db.sweepLease.create({ data: { name, holder: token, expiresAt } });
      return token;
    } catch {
      return null; // course de création : l'autre porteur vient de la créer
    }
  } catch {
    return null; // base indisponible → aucun passage (safe)
  }
}

/** Libère le lease SI on en est encore le porteur (best-effort : le TTL couvre). */
export async function releaseSweepLease(
  db: Prisma.TransactionClient,
  name: string,
  holder: string,
): Promise<void> {
  try {
    await db.sweepLease.updateMany({
      where: { name, holder },
      data: { expiresAt: new Date(0) },
    });
  } catch {
    // Best-effort : en cas d'échec, le TTL rendra la passe au plus tard.
  }
}
