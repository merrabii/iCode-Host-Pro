import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, WalletTransactionType, WalletTxStatus } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types';

/** Entrée d'un mouvement de solde appliqué (crédit/débit immédiat). */
export interface ApplyWalletInput {
  amountCents: number;
  idempotencyKey: string;
  /** Devise de l'opération (défaut USD) — partie de l'identité opérationnelle. */
  currency?: string;
  note?: string | null;
  reference?: string | null;
  orderId?: string | null;
  invoiceId?: string | null;
  paymentMethodId?: string | null;
  methodName?: string | null;
}

export interface CreateRechargeInput {
  amountCents: number;
  note?: string | null;
  proof?: { fileName: string; path: string; mime: string } | null;
  paymentMethodId?: string | null;
}

export interface ApplyResult {
  balanceCents: number;
  replayed: boolean;
}

// GO Q8 — justificatifs stockés HORS de tout répertoire public (jamais servis
// par le web). `storage/` est ignoré par git ; l'ancien emplacement
// `public/wallet-proofs/` ne sert qu'en LECTURE de repli pour les lignes
// créées avant cette migration (aucune nouvelle écriture n'y est faite).
const PROOF_DIR = path.resolve(process.cwd(), 'storage', 'wallet-proofs');
const LEGACY_PROOF_DIR = path.resolve(process.cwd(), 'public', 'wallet-proofs');
const RECHARGE_MIN_CENTS = 100; // 1 USD
const RECHARGE_MAX_CENTS = 10_000_000; // 100 000 USD

/** Sous-ensemble de WalletTransaction servant à comparer l'identité opérationnelle. */
type WalletTxIdentityRow = {
  customerId: string;
  type: WalletTransactionType;
  amountCents: number;
  currency: string;
  status: WalletTxStatus;
  orderId: string | null;
  invoiceId: string | null;
  reference: string | null;
};
const PROOF_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

// GO Q8 — contenu RÉEL du justificatif : c'est la signature binaire (magic
// bytes) qui fait foi, jamais le MIME déclaré par le client.
const PROOF_MAGIC: { mime: string; sniff: (b: Buffer) => boolean }[] = [
  {
    mime: 'image/png',
    sniff: (b) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', sniff: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    sniff: (b) =>
      b.length >= 12 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP',
  },
  { mime: 'application/pdf', sniff: (b) => b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-' },
];

/**
 * GO P6 (lot C2 - portefeuille) — SERVICE UNIQUE du solde.
 *
 * Invariants (critères d'acceptation audit §5 / R-WAL-01) :
 *  - TOUTE écriture de `Customer.walletBalanceCents` passe par ce service,
 *    dans un `$transaction` avec verrou ligne `SELECT ... FOR UPDATE` ;
 *  - `idempotencyKey @unique` : un rejeu ne débite/crédite JAMAIS deux fois
 *    (P2002 → retour neutre, solde inchangé) ;
 *  - un débit ne fait jamais passer le solde sous zéro (garde sous verrou) ;
 *  - recharge virement (C3a) : ligne `PENDING` sans effet solde, crédit
 *    UNIQUEMENT à la validation admin (CAS `PENDING → SUCCEEDED`, une fois) ;
 *  - contrôle propriétaire : les lectures/filtres côté client passent par
 *    `ensureOwnedCustomer` (dossier lié au JWT ou lié au passage).
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  private assertAmount(amountCents: number): void {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException(
        'Montant invalide (entier strictement positif en centimes).',
      );
    }
  }

  /**
   * Dossier du membre connecté (GO Q3) :
   *  - rattaché au compte (`userId`) → retour immédiat ;
   *  - dossier INVITÉ (`userId: null`) au même email **de la DB** → rattachement
   *    **CAS atomique** (`userId: null` requis) : deux requêtes concurrentes du
   *    même compte ne peuvent pas écraser l'une l'autre, et un dossier repris
   *    entre-temps par un tiers n'est jamais détourné ;
   *  - absent → création (P2002 sur `email` → nouvelle tentative : course perdue
   *    sur la création, pas d'erreur 500) ;
   *  - dossier lié à un AUTRE compte → conflit (jamais de vol).
   *
   * Identité actuelle : l'identité est relue **en base** (email du compte +
   * `isActive`) — le claim email d'un JWT peut être périmé (changement d'email
   * confirmé entre-temps) et un compte désactivé ne rattache/crée plus rien.
   */
  async ensureOwnedCustomer(
    user: JwtPayload,
  ): Promise<{ id: string; email: string; walletBalanceCents: number }> {
    // Identité actuelle vérifiée TOUJOURS en DB AVANT tout accès (jamais le
    // seul JWT) : email courant + isActive, même si le dossier est déjà lié —
    // un compte désactivé ne lit ni ne rattache plus rien.
    const me = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { email: true, isActive: true, name: true },
    });
    if (!me || !me.isActive) {
      throw new UnauthorizedException('Compte désactivé ou introuvable.');
    }
    const dbEmail = me.email;

    for (let attempt = 0; attempt < 2; attempt++) {
      const byUser = await this.prisma.customer.findUnique({
        where: { userId: user.sub },
        select: { id: true, email: true, walletBalanceCents: true },
      });
      if (byUser) return byUser;

      const byEmail = await this.prisma.customer.findUnique({
        where: { email: dbEmail },
        select: { id: true, email: true, userId: true, walletBalanceCents: true },
      });
      if (byEmail) {
        if (byEmail.userId === user.sub) return byEmail;
        if (byEmail.userId) {
          throw new ConflictException('Dossier client rattaché à un autre compte.');
        }
        // CAS de rattachement : seul un dossier TOUJOURS non rattaché est pris.
        const cas = await this.prisma.customer.updateMany({
          where: { id: byEmail.id, userId: null },
          data: { userId: user.sub },
        });
        if (cas.count === 1) {
          return {
            id: byEmail.id,
            email: byEmail.email,
            walletBalanceCents: byEmail.walletBalanceCents,
          };
        }
        continue; // course perdue → 2ᵉ tour (relecture complète)
      }

      try {
        return await this.prisma.customer.create({
          data: {
            email: dbEmail,
            name: me.name?.trim() || dbEmail,
            userId: user.sub,
          },
          select: { id: true, email: true, walletBalanceCents: true },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') continue; // création parallèle
        throw e;
      }
    }
    throw new ConflictException('Dossier client rattaché à un autre compte.');
  }

  /** Crédit immédiat (idempotent) : verrou + insertion + incrément, un seul tour. */
  async credit(customerId: string, input: ApplyWalletInput): Promise<ApplyResult> {
    this.assertAmount(input.amountCents);
    return this.apply(customerId, input, 'credit');
  }

  /** Débit immédiat (idempotent) : solde insuffisant = 409, jamais de négatif. */
  async debit(customerId: string, input: ApplyWalletInput): Promise<ApplyResult> {
    this.assertAmount(input.amountCents);
    return this.apply(customerId, input, 'debit');
  }

  /**
   * Q-A (item 2) — identité COMPLÈTE d'une opération de solde. Un rejeu n'est
   * accepté que si TOUT correspond (client, sens, montant, devise, commande,
   * facture, référence, statut abouti) ; sinon 409, JAMAIS d'effet silencieux
   * sur une autre opération portant la même clé.
   */
  private operationIdentityMatches(
    row: WalletTxIdentityRow,
    customerId: string,
    input: ApplyWalletInput,
    direction: 'credit' | 'debit',
  ): boolean {
    return (
      row.customerId === customerId &&
      row.type ===
        (direction === 'credit'
          ? WalletTransactionType.CREDIT
          : WalletTransactionType.DEBIT) &&
      row.amountCents === input.amountCents &&
      row.currency === (input.currency ?? 'USD') &&
      row.status === WalletTxStatus.SUCCEEDED &&
      (row.orderId ?? null) === (input.orderId ?? null) &&
      (row.invoiceId ?? null) === (input.invoiceId ?? null) &&
      (row.reference ?? null) === (input.reference ?? null)
    );
  }

  /** Rejeu : retour neutre + solde actuel, aucun second effet de solde. */
  private async replayResult(
    client: Prisma.TransactionClient | PrismaService,
    row: WalletTxIdentityRow,
    customerId: string,
    input: ApplyWalletInput,
    direction: 'credit' | 'debit',
  ): Promise<ApplyResult> {
    if (!this.operationIdentityMatches(row, customerId, input, direction)) {
      throw new ConflictException(
        'Clé d’idempotence déjà utilisée pour une autre opération.',
      );
    }
    const customer = await client.customer.findUnique({
      where: { id: customerId },
      select: { walletBalanceCents: true },
    });
    if (!customer) throw new NotFoundException('Dossier client introuvable.');
    return { balanceCents: customer.walletBalanceCents, replayed: true };
  }

  /**
   * Q-A (item 1+2) — moteur d'application du solde, exécuté DANS une
   * transaction (appelante ou propre) :
   *  1. LECTURE D'ABORD : opération déjà aboutie avec la même identité =
   *     rejeu (retour neutre, y compris si le solde a baissé entre-temps) ;
   *  2. sous verrou `FOR UPDATE` : garde solde (débit), insertion, incrément ;
   *  3. un P2002 résiduel (deux tx insèrent la même clé) abort la tx → le
   *     chemin appelant relit et décide : identité OK = rejeu, sinon 409.
   */
  private async applyInTx(
    tx: Prisma.TransactionClient,
    customerId: string,
    input: ApplyWalletInput,
    direction: 'credit' | 'debit',
  ): Promise<ApplyResult> {
    const dup = await tx.walletTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (dup) {
      return this.replayResult(tx, dup, customerId, input, direction);
    }
    const rows = await tx.$queryRaw<{ walletBalanceCents: number }[]>`
      SELECT "walletBalanceCents" FROM "Customer" WHERE id = ${customerId} FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException('Dossier client introuvable.');
    }
    const current = Number(rows[0].walletBalanceCents);
    if (direction === 'debit' && current < input.amountCents) {
      throw new ConflictException('Solde insuffisant.');
    }
    await tx.walletTransaction.create({
      data: {
        customerId,
        type:
          direction === 'credit'
            ? WalletTransactionType.CREDIT
            : WalletTransactionType.DEBIT,
        amountCents: input.amountCents,
        currency: input.currency ?? 'USD',
        status: WalletTxStatus.SUCCEEDED,
        idempotencyKey: input.idempotencyKey,
        reference: input.reference ?? null,
        note: input.note ?? null,
        orderId: input.orderId ?? null,
        invoiceId: input.invoiceId ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        methodName: input.methodName ?? null,
        processedAt: new Date(),
      },
    });
    const updated = await tx.customer.update({
      where: { id: customerId },
      data:
        direction === 'credit'
          ? { walletBalanceCents: { increment: input.amountCents } }
          : { walletBalanceCents: { decrement: input.amountCents } },
    });
    return { balanceCents: updated.walletBalanceCents, replayed: false };
  }

  /** Application standalone : tour de `$transaction` dédié. */
  private async apply(
    customerId: string,
    input: ApplyWalletInput,
    direction: 'credit' | 'debit',
  ): Promise<ApplyResult> {
    // Lecture d'abord HORS tx : chemin chaud des rejeus (aucune tx ouverte).
    const pre = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (pre) {
      return this.replayResult(this.prisma, pre, customerId, input, direction);
    }
    try {
      return await this.prisma.$transaction((tx) =>
        this.applyInTx(tx, customerId, input, direction),
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.walletTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          return this.replayResult(
            this.prisma,
            existing,
            customerId,
            input,
            direction,
          );
        }
        throw new ConflictException('Clé d’idempotence déjà utilisée.');
      }
      throw err;
    }
  }

  /**
   * Q-A (item 1) — même opération DANS la transaction d'un appelant
   * (paiement portefeuille = débit + confirmation de commande atomiques).
   * Lecture d'abord INSIDE la tx : un P2002 abort toute la tx appelante, on ne
   * peut donc jamais y « rebondir » — le rejeu est détecté avant insertion
   * (et l'appelant verrouille d'ordre la commande concernée, ce qui sérialise
   * les courses sur la même commande).
   */
  async applyWithClient(
    tx: Prisma.TransactionClient,
    customerId: string,
    input: ApplyWalletInput,
    direction: 'credit' | 'debit',
  ): Promise<ApplyResult> {
    this.assertAmount(input.amountCents);
    return this.applyInTx(tx, customerId, input, direction);
  }

  /**
   * Justificatif (image/PDF ≤ 5 Mo) : disque `storage/wallet-proofs/` —
   * GO Q8 : HORS répertoire public. Le TYPE retenu est celui DÉTECTÉ dans le
   * contenu (magic bytes) ; un MIME déclaré incohérent est refusé (400).
   */
  persistProof(file: {
    originalname: string;
    mimetype: string;
    buffer?: Buffer;
  }): { fileName: string; path: string; mime: string } {
    if (!file.buffer) {
      throw new BadRequestException('Justificatif illisible.');
    }
    const detected = PROOF_MAGIC.find((m) => m.sniff(file.buffer!));
    if (!detected) {
      throw new BadRequestException(
        'Contenu du justificatif non reconnu (signature PNG, JPEG, WebP ou PDF attendue).',
      );
    }
    if (detected.mime !== file.mimetype) {
      throw new BadRequestException(
        `Contenu du justificatif incohérent avec le type déclaré (${file.mimetype} déclaré, ${detected.mime} détecté).`,
      );
    }
    const ext = PROOF_EXT[detected.mime];
    const fileName = `proof-${randomBytes(8).toString('hex')}${ext}`;
    fs.mkdirSync(PROOF_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROOF_DIR, fileName), file.buffer);
    return { fileName, path: fileName, mime: detected.mime };
  }

  removeProof(proofPath: string | null | undefined): void {
    if (!proofPath) return;
    for (const dir of [PROOF_DIR, LEGACY_PROOF_DIR]) {
      const abs = path.join(dir, path.basename(proofPath));
      if (fs.existsSync(abs)) {
        try {
          fs.unlinkSync(abs);
        } catch {
          // Fichier déjà absent : rien à nettoyer.
        }
        return;
      }
    }
  }

  proofAbsolutePath(proofPath: string): string {
    const abs = path.join(PROOF_DIR, path.basename(proofPath));
    if (fs.existsSync(abs)) return abs;
    // Repli LECTURE seule pour les justificatifs déposés avant Q8.
    return path.join(LEGACY_PROOF_DIR, path.basename(proofPath));
  }

  /**
   * Dépôt de recharge par virement (C3a) : ligne `PENDING`, AUCUN effet solde.
   * `reference` = référence unique à porter sur le virement (affichée au client).
   */
  async createRecharge(
    customerId: string,
    input: CreateRechargeInput,
  ): Promise<{
    id: string;
    reference: string;
    amountCents: number;
    status: WalletTxStatus;
    createdAt: Date;
    proofFileName: string | null;
  }> {
    this.assertAmount(input.amountCents);
    if (input.amountCents < RECHARGE_MIN_CENTS) {
      throw new BadRequestException('Montant minimum : 1,00 USD.');
    }
    if (input.amountCents > RECHARGE_MAX_CENTS) {
      throw new BadRequestException('Montant maximum : 100 000,00 USD.');
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const reference = `RCH-${randomBytes(5).toString('hex').toUpperCase()}`;
      try {
        const row = await this.prisma.walletTransaction.create({
          data: {
            customerId,
            type: WalletTransactionType.CREDIT,
            status: WalletTxStatus.PENDING,
            amountCents: input.amountCents,
            idempotencyKey: `recharge:${randomBytes(12).toString('hex')}`,
            reference,
            note: input.note?.trim() || null,
            proofFileName: input.proof?.fileName ?? null,
            proofPath: input.proof?.path ?? null,
            proofMime: input.proof?.mime ?? null,
            paymentMethodId: input.paymentMethodId ?? null,
            methodName: 'Virement bancaire',
          },
        });
        return {
          id: row.id,
          reference: row.reference!,
          amountCents: row.amountCents,
          status: row.status,
          createdAt: row.createdAt,
          proofFileName: row.proofFileName,
        };
      } catch (err) {
        lastError = err;
        // Collision sur `reference @unique` : on retente avec une nouvelle référence.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ConflictException('Référence de recharge déjà utilisée.');
  }

  /**
   * Validation admin d'une recharge (GO Q8) : CAS `PENDING → SUCCEEDED` sous
   * verrou + incrément du solde dans LE MÊME tour de `$transaction` — crédité
   * exactement une fois (revalidation = 409, solde inchangé).
   *
   * `bankRef` = référence de rapprochement bancaire de l'ENCAISSEMENT réellement
   * constaté (obligatoire, 3..64 car.) : elle est conservée sur la ligne avec le
   * montant, la devise et l'acteur. Son unicité PostgreSQL garantit qu'un même
   * encaissement ne finance JAMAIS deux crédits (P2002 → 409, la transaction
   * est avortée : ni crédit partiel, ni ligne modifiée).
   *
   * Distinction explicite : `PENDING` = justificatif DÉPOSÉ (aucun fonds) ;
   * `SUCCEEDED` + `bankRef` + `processedAt` + acteur = fonds CONSTATÉS.
   */
  async validateRecharge(
    rechargeId: string,
    admin: { sub: string; email: string },
    bankRef: string,
  ): Promise<{ balanceCents: number; bankRef: string; amountCents: number; currency: string }> {
    const ref = bankRef?.trim() ?? '';
    if (ref.length < 3 || ref.length > 64) {
      throw new BadRequestException(
        'Référence de rapprochement bancaire requise (3 à 64 caractères).',
      );
    }
    let credited: { balanceCents: number; amountCents: number; currency: string } | null = null;
    try {
      credited = await this.prisma.$transaction(async (tx) => {
        const row = await tx.walletTransaction.findUnique({
          where: { id: rechargeId },
          select: { id: true, customerId: true, type: true, amountCents: true, currency: true },
        });
        if (!row) throw new NotFoundException('Recharge introuvable.');
        if (row.type !== WalletTransactionType.CREDIT) {
          throw new ConflictException('Type de mouvement inattendu.');
        }
        const rows = await tx.$queryRaw<{ walletBalanceCents: number }[]>`
          SELECT "walletBalanceCents" FROM "Customer" WHERE id = ${row.customerId} FOR UPDATE`;
        if (rows.length === 0) {
          throw new NotFoundException('Dossier client introuvable.');
        }
        const cas = await tx.walletTransaction.updateMany({
          where: { id: rechargeId, status: WalletTxStatus.PENDING },
          data: {
            status: WalletTxStatus.SUCCEEDED,
            processedAt: new Date(),
            adminActorId: admin.sub,
            adminActorEmail: admin.email,
            bankRef: ref,
          },
        });
        if (cas.count !== 1) {
          throw new ConflictException('Recharge déjà traitée.');
        }
        const updated = await tx.customer.update({
          where: { id: row.customerId },
          data: { walletBalanceCents: { increment: row.amountCents } },
        });
        return {
          balanceCents: updated.walletBalanceCents,
          amountCents: row.amountCents,
          currency: row.currency,
        };
      });
      return {
        balanceCents: credited.balanceCents,
        bankRef: ref,
        amountCents: credited.amountCents,
        currency: credited.currency,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        String((err.meta as { target?: unknown } | undefined)?.target ?? '').includes('bankRef')
      ) {
        // Même encaissement déjà constaté sur une autre recharge : 409 clair,
        // AUCUN crédit (la transaction a été annulée par l'unicité PG).
        throw new ConflictException(
          `Encaissement bancaire déjà utilisé (référence « ${ref} ») : un virement ne peut créditer qu’une recharge.`,
        );
      }
      throw err;
    }
  }

  /** Rejet admin : CAS `PENDING → CANCELED`, 0 crédit (preuve conservée). */
  async rejectRecharge(
    rechargeId: string,
    admin: { sub: string; email: string },
    reason: string | null,
  ): Promise<void> {
    const row = await this.prisma.walletTransaction.findUnique({
      where: { id: rechargeId },
      select: { id: true, status: true, note: true },
    });
    if (!row) throw new NotFoundException('Recharge introuvable.');
    const suffix = reason ? `REJET : ${reason}` : 'REJET';
    const note = row.note ? `${row.note} · ${suffix}` : suffix;
    const res = await this.prisma.walletTransaction.updateMany({
      where: { id: rechargeId, status: WalletTxStatus.PENDING },
      data: {
        status: WalletTxStatus.CANCELED,
        processedAt: new Date(),
        adminActorId: admin.sub,
        adminActorEmail: admin.email,
        note,
      },
    });
    if (res.count !== 1) {
      throw new ConflictException('Recharge déjà traitée.');
    }
  }
}
