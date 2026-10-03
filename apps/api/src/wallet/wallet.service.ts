import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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

const PROOF_DIR = path.resolve(process.cwd(), 'public', 'wallet-proofs');
const RECHARGE_MIN_CENTS = 100; // 1 USD
const RECHARGE_MAX_CENTS = 10_000_000; // 100 000 USD
const PROOF_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

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
   * Dossier du membre connecté : lié au compte (userId) ; sinon dossier au
   * même email (dossier invité → lié au compte au premier accès) ; sinon
   * création. Un dossier déjà lié à un AUTRE compte = conflit (jamais de vol).
   */
  async ensureOwnedCustomer(
    user: JwtPayload,
  ): Promise<{ id: string; email: string; walletBalanceCents: number }> {
    const byUser = await this.prisma.customer.findUnique({
      where: { userId: user.sub },
      select: { id: true, email: true, walletBalanceCents: true },
    });
    if (byUser) return byUser;

    const byEmail = await this.prisma.customer.findUnique({
      where: { email: user.email },
      select: { id: true, email: true, userId: true, walletBalanceCents: true },
    });
    if (byEmail) {
      if (byEmail.userId && byEmail.userId !== user.sub) {
        throw new ConflictException(
          'Dossier client rattaché à un autre compte.',
        );
      }
      const linked = await this.prisma.customer.update({
        where: { id: byEmail.id },
        data: { userId: user.sub },
        select: { id: true, email: true, walletBalanceCents: true },
      });
      return linked;
    }

    const me = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { name: true },
    });
    return this.prisma.customer.create({
      data: {
        email: user.email,
        name: me?.name?.trim() || user.email,
        userId: user.sub,
      },
      select: { id: true, email: true, walletBalanceCents: true },
    });
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

  private async apply(
    customerId: string,
    input: ApplyWalletInput,
    direction: 'credit' | 'debit',
  ): Promise<ApplyResult> {
    try {
      const balanceCents = await this.prisma.$transaction(async (tx) => {
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
        return updated.walletBalanceCents;
      });
      return { balanceCents, replayed: false };
    } catch (err) {
      // Rejeu de la MÊME clé : la ligne existe → aucun second effet de solde.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.walletTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { customerId: true },
        });
        if (existing && existing.customerId === customerId) {
          const customer = await this.prisma.customer.findUnique({
            where: { id: customerId },
            select: { walletBalanceCents: true },
          });
          return {
            balanceCents: customer?.walletBalanceCents ?? 0,
            replayed: true,
          };
        }
        throw new ConflictException('Clé d’idempotence déjà utilisée.');
      }
      throw err;
    }
  }

  /** Justificatif (image/PDF ≤ 5 Mo) : disque `public/wallet-proofs/`. */
  persistProof(file: {
    originalname: string;
    mimetype: string;
    buffer?: Buffer;
  }): { fileName: string; path: string; mime: string } {
    if (!file.buffer) {
      throw new BadRequestException('Justificatif illisible.');
    }
    const ext = PROOF_EXT[file.mimetype];
    if (!ext) {
      throw new BadRequestException(
        'Type de justificatif refusé (PNG, JPEG, WebP ou PDF).',
      );
    }
    const fileName = `proof-${randomBytes(8).toString('hex')}${ext}`;
    fs.mkdirSync(PROOF_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROOF_DIR, fileName), file.buffer);
    return { fileName, path: fileName, mime: file.mimetype };
  }

  removeProof(proofPath: string | null | undefined): void {
    if (!proofPath) return;
    try {
      fs.unlinkSync(path.join(PROOF_DIR, path.basename(proofPath)));
    } catch {
      // Fichier déjà absent : rien à nettoyer.
    }
  }

  proofAbsolutePath(proofPath: string): string {
    return path.join(PROOF_DIR, path.basename(proofPath));
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
   * Validation admin d'une recharge : CAS `PENDING → SUCCEEDED` sous verrou +
   * incrément du solde dans LE MÊME tour de `$transaction` — crédité exactement
   * une fois (revalidation = 409, solde inchangé).
   */
  async validateRecharge(
    rechargeId: string,
    admin: { sub: string; email: string },
  ): Promise<{ balanceCents: number }> {
    const balanceCents = await this.prisma.$transaction(async (tx) => {
      const row = await tx.walletTransaction.findUnique({
        where: { id: rechargeId },
        select: { id: true, customerId: true, type: true, amountCents: true },
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
        },
      });
      if (cas.count !== 1) {
        throw new ConflictException('Recharge déjà traitée.');
      }
      const updated = await tx.customer.update({
        where: { id: row.customerId },
        data: { walletBalanceCents: { increment: row.amountCents } },
      });
      return updated.walletBalanceCents;
    });
    return { balanceCents };
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
