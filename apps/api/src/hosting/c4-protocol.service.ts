import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Nature d'une tentative provider (classes de dispatch fermées). */
export type C4Nature = 'CREATE' | 'CONFIGURE' | 'DELETE' | 'READ';

/** Portée d'une tentative/stop/takeover (scopes fermés du protocole). */
export type C4ScopeKind = 'ORDER' | 'SERVICE' | 'ALLOCATION' | 'DEPLOYMENT';

/** Scope du protocole. */
export interface C4Scope {
  type: C4ScopeKind;
  id: string;
}

/** Identité d'une tentative émise (ticket commité AVANT le réseau). */
export interface C4DispatchTicket {
  attemptId: string;
  targetIntentHash: string | null;
}

/** Paramètres d'émission (1ᵉʳ appel du périmètre : takeover inclus). */
export interface C4BeginDispatchParams {
  nature: C4Nature;
  scope: C4Scope;
  holder: string;
  allocationId?: string | null;
  orderId?: string | null;
  /** Cible exacte figée avant appel (uuid connu pour DELETE ; non connu pour CREATE). */
  targetIntent?: Record<string, unknown> | null;
}

/** Paramètres de consignation (retour d'une tentative émise). */
export interface C4SettleParams {
  attemptId: string;
  holder: string;
  outcome: 'SUCCESS' | 'REFUSED' | 'DELETED' | 'ABSENT' | 'FAILED_RETRYABLE' | 'PERMANENT_FAILURE' | 'PRESENT' | 'UNAVAILABLE' | 'UNKNOWN';
  /** Hash de cible renvoyé au dispatch (vérifié si présent). */
  targetIntentHash?: string | null;
  returnedIdentifiers?: Record<string, unknown> | null;
  /** Écriture ATOMIQUE d'identifiants retournés (même tx que la consignation). */
  persist?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/** Natures dont le dispatch est INTERDIT après un arrêt (rule 3). */
const STOP_BLOCKED_NATURES: readonly C4Nature[] = ['CREATE', 'CONFIGURE'];

/**
 * 17B.4F-C4 — barrière AU SEIN d'un helper à frontières READ → CREATE/CONFIGURE
 * (ex. `allocateClientSubdomain` : `findRecordByName` puis `createRecord`) :
 * la lecture réseau a eu lieu, un arrêt/OFF est apparu entre-temps — le helper
 * ABANDONNE la mutation et signale « aucune ressource créée » (le caller
 * consigne `REFUSED`, terminale sûre, puis GEL sans transition métier).
 * Aucun catch de lecture ne peut contourner ce signal : il est levé AVANT la
 * création, hors de tout embranchement de lecture.
 */
export class C4BarrierAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'C4BarrierAbortError';
  }
}

/** Stabilisation JSON (clés triées récursivement) pour un hash déterministe. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Hash SHA-256 de la cible exacte d'une tentative. */
export function c4TargetHash(intent: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(intent)).digest('hex');
}

/**
 * 17B.4F-C4 — protocole de tentatives provider durables (emit / settle / stop).
 *
 * Contrat consolidé (règles GO 1–8) :
 *  - `beginDispatch` s'exécute DANS LA MÊME transaction (garde) que la 1ᵉʳᵉ
 *    tentative, AVANT tout appel réseau : refuse si un arrêt couvre la cible
 *    (CREATE/CONFIGURE), si un créateur non résolu existe pour l'allocation,
 *    pose le `C4Takeover` du périmètre (committé avant le réseau) et insère la
 *    tentative `DISPATCHED` (l'index unique partiel garantit au plus une
 *    tentative de création ouverte par allocation).
 *  - `settle` consigne le retour dans LA transaction fournie : vérifie
 *    l'identité (attemptId + holder + phase + hash de cible), écrit
 *    l'outcome terminal (immuable, idempotent sur le MÊME outcome) et exécute
 *    `persist` (identifiants retournés) DANS LA MÊME tx — si la persistance
 *    échoue, toute la consignation est annulée et l'incertitude est conservée
 *    (jamais d'identifiant « enregistré » sans preuve commitée).
 *  - La consignation est AUTORISÉE après un arrêt (retour tardif d'un appel
 *    déjà émis : identité vérifiée) mais n'exécute AUCUNE transition — seule
 *    l'écriture des identifiants/étapes de tentative a lieu.
 *  - Les marqueurs (stop/takeover/tentatives) ne sont JAMAIS effacés par un
 *    changement de flag.
 */
@Injectable()
export class C4ProtocolService {
  constructor(private readonly prisma: PrismaService) {}

  // ── scopes / arrêts ───────────────────────────────────────────────────────

  /** Liste déterministe des scopes couvrant une opération (ordre stable). */
  static scopesFor(p: {
    order?: string | null;
    service?: string | null;
    allocation?: string | null;
    deployment?: string | null;
  }): C4Scope[] {
    const out: C4Scope[] = [];
    if (p.order) out.push({ type: 'ORDER', id: p.order });
    if (p.service) out.push({ type: 'SERVICE', id: p.service });
    if (p.allocation) out.push({ type: 'ALLOCATION', id: p.allocation });
    if (p.deployment) out.push({ type: 'DEPLOYMENT', id: p.deployment });
    return out;
  }

  /** Un arrêt couvre-t-il l'un des scopes ? (lecture live, jamais de cache). */
  async hasStop(scopes: C4Scope[]): Promise<boolean> {
    if (scopes.length === 0) return false;
    const row = await this.prisma.c4StopRequest.findFirst({
      where: { OR: scopes.map((s) => ({ scopeType: s.type, scopeId: s.id })) },
      select: { id: true },
    });
    return !!row;
  }

  /** Variante dans la transaction du caller (même contrat, lecture live). */
  async hasStopInTx(tx: Prisma.TransactionClient, scopes: C4Scope[]): Promise<boolean> {
    if (scopes.length === 0) return false;
    const row = await tx.c4StopRequest.findFirst({
      where: { OR: scopes.map((s) => ({ scopeType: s.type, scopeId: s.id })) },
      select: { id: true },
    });
    return !!row;
  }

  /** Pose un arrêt idempotent (unique par scope) — jamais effacé par la suite. */
  async requestStop(params: {
    scope: C4Scope;
    reason?: string | null;
    actorId?: string | null;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.c4StopRequest.upsert({
        where: { scopeType_scopeId: { scopeType: params.scope.type, scopeId: params.scope.id } },
        create: {
          scopeType: params.scope.type,
          scopeId: params.scope.id,
          reason: params.reason ?? null,
          actorId: params.actorId ?? null,
        },
        update: {},
      });
    });
  }

  /** Variante dans la transaction du caller (stop sous verrous du caller). */
  async requestStopInTx(
    tx: Prisma.TransactionClient,
    params: { scope: C4Scope; reason?: string | null; actorId?: string | null },
  ): Promise<void> {
    await tx.c4StopRequest.upsert({
      where: { scopeType_scopeId: { scopeType: params.scope.type, scopeId: params.scope.id } },
      create: {
        scopeType: params.scope.type,
        scopeId: params.scope.id,
        reason: params.reason ?? null,
        actorId: params.actorId ?? null,
      },
      update: {},
    });
  }

  // ── créateur non résolu / pré-protocole ───────────────────────────────────

  /**
   * Tentatives de CRÉATION non résolues pour une allocation :
   * `DISPATCHED` (appel en vol, crash avant retour) OU outcome `UNKNOWN`
   * (timeout/5xx ambigu). Une tentative REFUSED/PERMANENT_FAILURE est
   * terminale sûre (aucune ressource créée) et ne bloque PAS.
   */
  async unresolvedCreative(allocationId: string): Promise<number> {
    return this.prisma.c4ProviderAttempt.count({
      where: {
        allocationId,
        nature: { in: ['CREATE', 'CONFIGURE'] },
        OR: [{ phase: 'DISPATCHED' }, { outcome: 'UNKNOWN' }],
      },
    });
  }

  /** Variante dans la transaction du caller. */
  async unresolvedCreativeInTx(
    tx: Prisma.TransactionClient,
    allocationId: string,
  ): Promise<number> {
    return tx.c4ProviderAttempt.count({
      where: {
        allocationId,
        nature: { in: ['CREATE', 'CONFIGURE'] },
        OR: [{ phase: 'DISPATCHED' }, { outcome: 'UNKNOWN' }],
      },
    });
  }

  /**
   * Détection « pré-protocole » : une allocation porte une intention provider
   * mais AUCUNE tentative CREATE n'a jamais été émise (création antérieure au
   * protocole). Dans ce cas : aucun nettoyage/release automatique après
   * intention (slot conservé, support documenté) — règle GO 2, sans exception
   * au-delà de la libération pré-provider structurelle (`providerIntentAt`
   * NULL, gérée en amont par le caller).
   */
  async isPreProtocol(allocation: {
    id: string;
    providerIntentAt: Date | null;
  }): Promise<boolean> {
    if (!allocation.providerIntentAt) return false;
    const created = await this.prisma.c4ProviderAttempt.count({
      where: { allocationId: allocation.id, nature: 'CREATE' },
    });
    return created === 0;
  }

  // ── émission / consignation ───────────────────────────────────────────────

  /**
   * Émission DANS LA TRANSACTION du caller (garde) : stop + créateur non
   * résolu + takeover + tentative `DISPATCHED`, committés AVANT le réseau.
   * Toute refusal lève `ConflictException` (le caller n'émet JAMAIS l'appel).
   */
  async beginDispatch(
    tx: Prisma.TransactionClient,
    params: C4BeginDispatchParams,
  ): Promise<C4DispatchTicket> {
    const coversCreation = STOP_BLOCKED_NATURES.includes(params.nature);
    const scopes = C4ProtocolService.scopesFor({
      order: params.orderId ?? (params.scope.type === 'ORDER' ? params.scope.id : null),
      allocation: params.allocationId,
      service: params.scope.type === 'SERVICE' ? params.scope.id : null,
      deployment: params.scope.type === 'DEPLOYMENT' ? params.scope.id : null,
    });
    if (!scopes.some((s) => s.type === params.scope.type && s.id === params.scope.id)) {
      scopes.push(params.scope);
    }

    // ① Arrêt opposable — CREATE/CONFIGURE refusés ; DELETE/READ autorisés.
    if (coversCreation && (await this.hasStopInTx(tx, scopes))) {
      throw new ConflictException('Arrêt demandé sur cette ressource — dispatch refusé.');
    }

    // ② Créateur non résolu — CREATE/CONFIGURE/DELETE refusés (jamais de
    //    création concurrente ni de suppression d'une cible créée en vol).
    if (params.allocationId) {
      const unresolved = await this.unresolvedCreativeInTx(tx, params.allocationId);
      if (unresolved > 0) {
        throw new ConflictException(
          'Créateur non résolu sur cette allocation — dispatch refusé (incertitude conservée).',
        );
      }
    }

    const hash = params.targetIntent ? c4TargetHash(params.targetIntent) : null;

    // ③ Takeover du périmètre (CREATE/CONFIGURE uniquement) — idempotent,
    //    committé dans LA MÊME transaction que la 1ʳᵉ tentative.
    if (coversCreation) {
      await tx.c4Takeover.upsert({
        where: { scopeType_scopeId: { scopeType: params.scope.type, scopeId: params.scope.id } },
        create: {
          scopeType: params.scope.type,
          scopeId: params.scope.id,
          targetIntent: (params.targetIntent ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        update: {},
      });
    }

    // ④ Tentative DISPATCHED (l'index unique partiel impose l'unicité du
    //    dispatch de création ouvert par allocation).
    try {
      const attempt = await tx.c4ProviderAttempt.create({
        data: {
          nature: params.nature,
          scopeType: params.scope.type,
          scopeId: params.scope.id,
          allocationId: params.allocationId ?? null,
          orderId: params.orderId ?? null,
          holder: params.holder,
          targetIntent: (params.targetIntent ?? undefined) as Prisma.InputJsonValue | undefined,
          targetIntentHash: hash,
        },
      });
      return { attemptId: attempt.id, targetIntentHash: attempt.targetIntentHash };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        throw new ConflictException(
          'Tentative de création déjà en cours sur cette allocation — dispatch refusé.',
        );
      }
      throw error;
    }
  }

  /**
   * Consignation DANS LA TRANSACTION du caller : identité vérifiée (attemptId
   * + holder + phase + hash de cible), outcome terminal immuable (idempotent
   * sur le MÊME outcome), `persist` exécuté DANS LA MÊME tx — rollback total
   * si `persist` échoue (incertitude conservée, aucun identifiant prétendu
   * enregistré). Autorisée APRÈS un arrêt (retour d'un appel déjà émis) —
   * elle n'exécute AUCUNE transition d'allocation/service/order.
   */
  async settle(tx: Prisma.TransactionClient, params: C4SettleParams): Promise<void> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        phase: string;
        holder: string;
        targetIntentHash: string | null;
        outcome: string | null;
      }>
    >`
      SELECT "id", "phase", "holder", "targetIntentHash", "outcome"
      FROM "C4ProviderAttempt"
      WHERE "id" = ${params.attemptId}
      FOR UPDATE`;
    const attempt = rows[0];
    if (!attempt) {
      throw new ConflictException('Tentative inconnue — consignation refusée.');
    }
    if (attempt.holder !== params.holder) {
      throw new ConflictException('Détenteur de tentative non autorisé — consignation refusée.');
    }
    if (
      params.targetIntentHash != null &&
      attempt.targetIntentHash != null &&
      attempt.targetIntentHash !== params.targetIntentHash
    ) {
      throw new ConflictException('Cible de tentative divergente — consignation refusée.');
    }
    if (attempt.phase === 'RETURNED') {
      // Idempotence stricte : MÊME outcome ⇒ no-op ; outcome divergent ⇒ refus
      // (outcome terminal immuable).
      if (attempt.outcome === params.outcome) return;
      throw new ConflictException('Outcome de tentative déjà consigné — divergence refusée.');
    }

    await tx.c4ProviderAttempt.update({
      where: { id: attempt.id },
      data: {
        phase: 'RETURNED',
        outcome: params.outcome,
        returnedIdentifiers: (params.returnedIdentifiers ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        returnedAt: new Date(),
      },
    });
    if (params.persist) {
      await params.persist(tx);
    }
  }

  /** Wrapper `settle` en transaction DÉDIÉE (chemins sans garde existante). */
  async settleStandalone(params: C4SettleParams): Promise<void> {
    await this.prisma.$transaction((tx) => this.settle(tx, params));
  }

  /** Wrapper `beginDispatch` en transaction DÉDIÉE (chemins sans garde). */
  async beginDispatchStandalone(params: C4BeginDispatchParams): Promise<C4DispatchTicket> {
    return this.prisma.$transaction((tx) => this.beginDispatch(tx, params));
  }

  // ── lectures utilitaires (finalize / diagnostic) ──────────────────────────

  /** Tentatives visibles pour une commande (diagnostic + tests). */
  async attemptsForOrder(orderId: string): Promise<
    Array<{
      id: string;
      nature: C4Nature;
      phase: string;
      outcome: string | null;
      holder: string;
      returnedIdentifiers: unknown;
    }>
  > {
    const rows = await this.prisma.c4ProviderAttempt.findMany({
      where: { orderId },
      orderBy: { dispatchedAt: 'asc' },
      select: {
        id: true,
        nature: true,
        phase: true,
        outcome: true,
        holder: true,
        returnedIdentifiers: true,
      },
    });
    return rows;
  }
}
