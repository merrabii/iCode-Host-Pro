import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerAccountType,
  InvoiceLineKind,
  InvoiceStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { RATE, rateKey, SaRateLimiter } from '../auth/rate-limiter';
import { MailSettingsService } from '../mail/mail-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService, PublicProduct } from '../products/products.service';
import { CheckoutDto } from './dto/checkout.dto';
import { ProvisioningService } from './provisioning.service';

/** Taux appliqué quand le produit n'en référence aucun (« Exonéré 0% »). */
const DEFAULT_TAXRATE_PERCENT = 0;

/** Réponse lisible du checkout (jamais de secret, jamais de hostname Coolify). */
export interface CheckoutResult {
  orderId: string;
  invoiceNumber: string;
  email: string;
  nextStep: 'provisioning-pending';
}

/** Ligne de facture construite côté serveur (d'où dérivent les totaux). */
interface InvoiceLineInput {
  kind: InvoiceLineKind;
  label: string;
  unitPriceHtCents: number;
  taxRatePercent: number;
  taxAmountCents: number;
  totalTtcCents: number;
}

/**
 * Bloc C — tunnel d'achat sans compte (§10 GATE C).
 *
 * Règles métier (prompt WHMCS + décisions owner) :
 * - Montants JAMAIS reçus du client : tout est recalculé serveur.
 * - Paiement SIMULÉ instantané : aucune étape PENDING_PAYMENT, la commande est
 *   créée PAID à la soumission (démo — la validation réelle arrive au Bloc D/E).
 * - Compte créé APRÈS paiement, atomiquement : User (mot de passe temporaire
 *   bcrypt, envoyé par email) + Customer FULL lié.
 * - Idempotence (§7) : `idempotencyKey` hash déterministe sur l'Order ; un
 *   double-clic / retry identique renvoie la commande existante (P2002).
 * - Email best-effort : si l'envoi échoue, la commande reste valide et l'échec
 *   est tracé en audit (l'admin peut récupérer le mot de passe).
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly audit: AuditService,
    private readonly limiter: SaRateLimiter,
    private readonly mail: MailSettingsService,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * POST /store/checkout — valide la configuration, recale les montants, crée
   * User + Customer + Order(PAID) + Invoice(PAID) atomiquement, envoie l'email
   * avec le mot de passe temporaire.
   */
  async checkoutGuest(dto: CheckoutDto, ip?: string): Promise<CheckoutResult> {
    const rl = this.limiter.consume(
      rateKey(ip, 'store-checkout'),
      RATE.checkoutIntent.limit,
      RATE.checkoutIntent.windowMs,
    );
    if (!rl.allowed) {
      throw new NotFoundException(
        `Trop de demandes. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
      );
    }

    // 1. Produit commandable (ACTIVE, non masqué) + configuration vendable.
    const product = await this.products.findPublicBySlug(dto.productSlug);

    // 2. Moyen de paiement actif (jamais les secrets — PaymentMethod.config est
    //    non secret, configEnc reste chiffré et n'est pas lu ici).
    const method = await this.prisma.paymentMethod.findFirst({
      where: { id: dto.paymentMethodId, isActive: true },
    });
    if (!method) {
      throw new BadRequestException('Ce moyen de paiement n’est pas disponible.');
    }

    // 3. Montants recalculés serveur (produit + options + addons + installation).
    const { lines, amountHtCents, taxAmountCents, amountTtcCents, taxRatePercent } =
      this.buildPricing(product, dto);

    // 4. Clé d'idempotence : hash déterministe de la configuration + montant.
    const email = dto.email.trim().toLowerCase();
    const key = this.idempotencyKey(dto, method.id, amountTtcCents, email);

    // 5. Replay (double-clic / retry identique) : on renvoie la commande déjà
    //    créée, SANS recréer de compte ni de commande (§7 idempotence).
    const replay = await this.prisma.order.findUnique({ where: { idempotencyKey: key } });
    if (replay) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { orderId: replay.id },
      });
      return {
        orderId: replay.id,
        invoiceNumber: invoice?.number ?? '',
        email,
        nextStep: 'provisioning-pending',
      };
    }

    // 6. Un compte avec cet email existe déjà (commandé avec une AUTRE config ou
    //    par login classique) → on ne crée pas de doublon.
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException(
        'Un compte existe déjà avec cet email — connectez-vous pour commander.',
      );
    }

    // 7. Transaction atomique post-paiement.
    const tempPassword = randomBytes(12).toString('hex');
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, name: dto.name, role: 'USER', passwordHash },
        });
        const customer = await tx.customer.create({
          data: {
            email,
            name: dto.name,
            phone: dto.phone ?? null,
            accountType: CustomerAccountType.FULL,
            userId: user.id,
          },
        });
        const billing = await this.claimInvoiceSequence(tx);
        const order = await tx.order.create({
          data: {
            customerId: customer.id,
            customerName: dto.name,
            customerEmail: email,
            customerPhone: dto.phone ?? null,
            productId: product.id,
            productName: product.name,
            packId: product.packId ?? null,
            status: OrderStatus.PAID,
            billingCycle: product.billingCycle,
            currency: billing.currency,
            taxRatePercent: new Prisma.Decimal(taxRatePercent),
            amountHtCents,
            taxAmountCents,
            amountTtcCents,
            paymentMethodId: method.id,
            paymentMethodName: method.name,
            optionsSnapshot: (dto.options ?? []).length
              ? this.optionsSnapshot(dto, product)
              : Prisma.JsonNull,
            addonsSnapshot: (dto.addonIds ?? []).length
              ? this.addonsSnapshot(dto, product)
              : Prisma.JsonNull,
            idempotencyKey: key,
          },
        });
        const invoice = await tx.invoice.create({
          data: {
            number: billing.invoiceNumber,
            orderId: order.id,
            customerId: customer.id,
            status: InvoiceStatus.PAID,
            currency: billing.currency,
            taxRatePercent: new Prisma.Decimal(taxRatePercent),
            amountHtCents,
            taxAmountCents,
            amountTtcCents,
            paidAt: new Date(),
            billingAddress: {
              name: dto.name,
              email,
              phone: dto.phone ?? null,
              ...(dto.extraFields ?? {}),
            },
            lines: {
              create: lines.map((l, i) => ({
                kind: l.kind,
                label: l.label,
                qty: 1,
                unitPriceHtCents: l.unitPriceHtCents,
                taxRatePercent: new Prisma.Decimal(l.taxRatePercent),
                taxAmountCents: l.taxAmountCents,
                totalTtcCents: l.totalTtcCents,
                sortOrder: i,
              })),
            },
          },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            status: OrderStatus.PAID,
            note: 'Paiement validé (simulation instantanée).',
            actorEmail: email,
          },
        });
        return { user, order, invoice, billing };
      });

      await this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, true);

      // 7. Email best-effort : mot de passe temporaire + annonce du sous-domaine.
      await this.sendAccountEmail(email, dto.name, tempPassword, created.billing.invoiceNumber)
        .catch((e) => this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, false, String(e)));

      // 8. Provisioning réel (Bloc D) : fire-and-forget, jamais bloquant (§10).
      //    En cas de produit sans ProvisionMethod, provisionOrder passe ACTIVE
      //    immédiatement sans appel Coolify/Cloudflare.
      this.provisioning.provisionOrder(created.order.id).catch(() => {});

      return {
        orderId: created.order.id,
        invoiceNumber: created.billing.invoiceNumber,
        email,
        nextStep: 'provisioning-pending',
      };
    } catch (e) {
      // Double-clic / retry concurrent : la commande identique existe déjà.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const existing = await this.prisma.order.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) {
          const inv = await this.prisma.invoice.findUnique({
            where: { orderId: existing.id },
          });
          return {
            orderId: existing.id,
            invoiceNumber: inv?.number ?? '',
            email,
            nextStep: 'provisioning-pending',
          };
        }
        throw new ConflictException(
          'Un compte existe déjà avec cet email — connectez-vous pour commander.',
        );
      }
      throw e;
    }
  }

  /**
   * Construit les lignes de facture + les totaux (HT / taxe / TTC). La taxe est
   * arrondie PAR LIGNE (produit, options, suppléments) ; le prix d'installation
   * n'est jamais taxé. Order et Invoice dérivent des mêmes totaux (cohérence).
   */
  private buildPricing(
    product: PublicProduct,
    dto: CheckoutDto,
  ): {
    lines: InvoiceLineInput[];
    amountHtCents: number;
    taxAmountCents: number;
    amountTtcCents: number;
    taxRatePercent: number;
  } {
    const rate = product.taxRate
      ? Number(product.taxRate.ratePercent)
      : DEFAULT_TAXRATE_PERCENT;
    const tax = (unit: number) => Math.round((unit * rate) / 100);

    const lines: InvoiceLineInput[] = [];

    const base = product.priceHtCents ?? 0;
    lines.push({
      kind: InvoiceLineKind.PRODUCT,
      label: product.name,
      unitPriceHtCents: base,
      taxRatePercent: rate,
      taxAmountCents: tax(base),
      totalTtcCents: base + tax(base),
    });

    // Options : chaque choix doit appartenir à une option du produit ; les
    // options requises doivent toutes être sélectionnées.
    const optionMap = new Map(product.options.map((o) => [o.id, o]));
    const chosen = new Set<string>();
    for (const sel of dto.options ?? []) {
      const opt = optionMap.get(sel.optionId);
      if (!opt) {
        throw new BadRequestException(`Option inconnue : ${sel.optionId}`);
      }
      if (chosen.has(sel.optionId)) {
        throw new BadRequestException(`L'option « ${opt.name} » est sélectionnée plusieurs fois.`);
      }
      const choice = opt.choices.find((c) => c.id === sel.choiceId);
      if (!choice) {
        throw new BadRequestException(`Choix invalide pour l'option « ${opt.name} ».`);
      }
      chosen.add(sel.optionId);
      const unit = choice.priceDeltaHtCents;
      lines.push({
        kind: InvoiceLineKind.OPTION,
        label: `${opt.name} — ${choice.label}`,
        unitPriceHtCents: unit,
        taxRatePercent: rate,
        taxAmountCents: tax(unit),
        totalTtcCents: unit + tax(unit),
      });
    }
    for (const opt of product.options) {
      if (opt.required && !chosen.has(opt.id)) {
        throw new BadRequestException(`L'option « ${opt.name} » est requise.`);
      }
    }

    // Suppléments.
    const addonMap = new Map(product.addons.map((a) => [a.id, a]));
    for (const addonId of dto.addonIds ?? []) {
      const addon = addonMap.get(addonId);
      if (!addon) {
        throw new BadRequestException(`Supplément inconnu : ${addonId}`);
      }
      const unit = addon.priceHtCents;
      lines.push({
        kind: InvoiceLineKind.ADDON,
        label: addon.name,
        unitPriceHtCents: unit,
        taxRatePercent: rate,
        taxAmountCents: tax(unit),
        totalTtcCents: unit + tax(unit),
      });
    }

    // Prix d'installation (par produit, admin) — jamais taxé.
    const installation = product.installationFeeCents ?? 0;
    if (installation > 0) {
      lines.push({
        kind: InvoiceLineKind.ADJUSTMENT,
        label: 'Frais d’installation',
        unitPriceHtCents: installation,
        taxRatePercent: 0,
        taxAmountCents: 0,
        totalTtcCents: installation,
      });
    }

    const amountHtCents = lines.reduce((s, l) => s + l.unitPriceHtCents, 0);
    const taxAmountCents = lines.reduce((s, l) => s + l.taxAmountCents, 0);
    const amountTtcCents = lines.reduce((s, l) => s + l.totalTtcCents, 0);

    return { lines, amountHtCents, taxAmountCents, amountTtcCents, taxRatePercent: rate };
  }

  /** Snapshots dénormalisés des options choisies (traçabilité, §7). */
  private optionsSnapshot(
    dto: CheckoutDto,
    product: PublicProduct,
  ): Prisma.InputJsonValue[] {
    const optionMap = new Map(product.options.map((o) => [o.id, o]));
    return (dto.options ?? []).map((sel) => {
      const opt = optionMap.get(sel.optionId)!;
      const choice = opt.choices.find((c) => c.id === sel.choiceId)!;
      return {
        optionId: opt.id,
        optionName: opt.name,
        choiceId: choice.id,
        choiceLabel: choice.label,
        priceDeltaHtCents: choice.priceDeltaHtCents,
      };
    });
  }

  /** Snapshots dénormalisés des suppléments retenus. */
  private addonsSnapshot(
    dto: CheckoutDto,
    product: PublicProduct,
  ): Prisma.InputJsonValue[] {
    const addonMap = new Map(product.addons.map((a) => [a.id, a]));
    return (dto.addonIds ?? []).map((addonId) => {
      const addon = addonMap.get(addonId)!;
      return { addonId: addon.id, addonName: addon.name, priceHtCents: addon.priceHtCents };
    });
  }

  /** Hash déterministe : email + slug + options + addons + moyen + montant TTC. */
  private idempotencyKey(
    dto: CheckoutDto,
    methodId: string,
    amountTtcCents: number,
    email: string,
  ): string {
    const options = [...(dto.options ?? [])]
      .map((o) => `${o.optionId}:${o.choiceId}`)
      .sort()
      .join(',');
    const addons = [...(dto.addonIds ?? [])].sort().join(',');
    const payload = [email, dto.productSlug, options, addons, methodId, amountTtcCents].join('|');
    return createHash('sha256').update(payload).digest('hex');
  }

  /** Réserve atomiquement le prochain numéro de facture « YYYY-<seq> » (row lock). */
  private async claimInvoiceSequence(
    tx: Prisma.TransactionClient,
  ): Promise<{ currency: string; invoiceNumber: string }> {
    let billing = await tx.billingSetting.findFirst();
    if (!billing) {
      billing = await tx.billingSetting.create({
        data: { currency: 'USD', companyName: 'Code Diali' },
      });
    }
    const rows = await tx.$queryRaw<{ next: number }[]>`
      UPDATE "BillingSetting"
      SET "invoiceSequence" = "invoiceSequence" + 1, "updatedAt" = NOW()
      WHERE "id" = ${billing.id}
      RETURNING "invoiceSequence" AS "next"
    `;
    const seq = Number(rows[0]?.next ?? 1) - 1;
    const invoiceNumber = `${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
    return { currency: billing.currency, invoiceNumber };
  }

  /** Audit des étapes paiement/commande (jamais le mot de passe en clair). */
  private async traceAudit(
    productId: string,
    orderId: string,
    amountTtcCents: number,
    methodId: string,
    ok: boolean,
    error?: string,
  ): Promise<void> {
    await this.audit.record({
      action: ok ? 'payment.checkout' : 'payment.checkout.email',
      resourceType: 'order',
      resourceId: orderId,
      details: { productId, amountTtcCents, methodId, ok, error: error ?? undefined },
    });
  }

  /** Email de compte (mot de passe temporaire) — best-effort, jamais bloquant. */
  private async sendAccountEmail(
    to: string,
    name: string,
    tempPassword: string,
    invoiceNumber: string,
  ): Promise<void> {
    await this.mail.sendPlain({
      to,
      subject: `Vos détails de compte Code Diali — commande ${invoiceNumber}`,
      text: [
        `Bonjour ${name},`,
        '',
        `Votre paiement a bien été validé (commande ${invoiceNumber}).`,
        '',
        'Voici vos identifiants de compte :',
        `  Email : ${to}`,
        `  Mot de passe temporaire : ${tempPassword}`,
        '',
        'Connectez-vous puis changez ce mot de passe dès que possible.',
        '',
        'Votre application est en cours de préparation. Dès qu’elle sera prête,',
        'vous recevrez par email l’adresse (sous-domaine) pour y accéder.',
        '',
        'L’équipe Code Diali',
      ].join('\n'),
    });
  }
}
