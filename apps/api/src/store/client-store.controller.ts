import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BillingCycle, InvoiceStatus, OrderStatus, Prisma } from '@prisma/client';
import type { Response } from 'express';
import * as fs from 'node:fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { CheckoutService } from './checkout.service';
import { addBillingCycle } from './billing-cycle';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceListQueryDto, OrderListQueryDto } from './dto/store-lists.dto';
import { RenewalToggleDto } from './dto/renewal-toggle.dto';
import {
  acquireRenewalChainBarrier,
  renewalChainRootId,
  RENEWAL_CHAIN_MAX_DEPTH,
} from './renewal-chain-barrier';

/**
 * Socle commercial (GO P4 / lot B1 - visibilité) — vues « mes commandes » et
 * « mes factures » de l'espace client.
 *
 * ISOLATION (critère d'acceptation du lot) : toutefiltre est appliqué côté
 * serveur sur le propriétaire du dossier client (`customer.userId` lié au
 * compte, avec repli sur l'email du JWT pour les clients invités créés avant
 * liaison) : un détail qui n'appartient pas au token courant répond 404 (jamais
 * 403 — pas de révélation d'existence). Aucune clé d' idempotence ni de trace
 * de paiement interne n'est exposée : select explicite.
 */
@ApiTags('client/store')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client')
export class ClientStoreController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: InvoicePdfService,
    private readonly wallet: WalletService,
    private readonly checkout: CheckoutService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Propriétaire du dossier (GO Q3) — le JWT seul décide, l'email n'est
   * qu'un rattachement de secours ET BORNÉ : soit le compte lié (`userId`),
   * soit un dossier INVITÉ non rattaché (`userId: null`) au même email.
   * Un email (même aligné sur la DB) ne donne JAMAIS accès à un dossier
   * déjà lié à un autre compte : la branche email porte `userId: null`,
   * donc les dossiers d'un tiers sont invisibles — pas de vol de dossier,
   * ni même avec un claim email périmé après changement d'email.
   */
  private ownedBy(user: JwtPayload): Prisma.CustomerWhereInput {
    return {
      OR: [{ userId: user.sub }, { AND: [{ email: user.email }, { userId: null }] }],
    };
  }

  private clamp(query: { page?: number; perPage?: number }) {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 20)), 200);
    return { page, perPage, skip: (page - 1) * perPage };
  }

  /** Commandes du client connecté, paginées, triées du plus récent au plus ancien. */
  @Get('orders')
  @ApiOperation({ summary: 'Mes commandes (client, paginé)' })
  async listMyOrders(
    @CurrentUser() user: JwtPayload,
    @Query() query: OrderListQueryDto,
  ) {
    const { page, perPage, skip } = this.clamp(query);
    const where: Prisma.OrderWhereInput = {
      customer: this.ownedBy(user),
    };
    if (query.status) where.status = query.status;
    const q = query.q?.trim();
    if (q) where.productName = { contains: q, mode: 'insensitive' };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
        select: ORDER_LIST_SELECT,
      }),
    ]);
    return { items, total, page, perPage };
  }

  /** Détail d'une commande — 404 si la commande n'appartient pas au compte. */
  @Get('orders/:id')
  @ApiOperation({ summary: 'Détail de ma commande' })
  async getMyOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: {
        ...ORDER_LIST_SELECT,
        domainType: true,
        domainValue: true,
        requestedSubdomain: true,
        optionsSnapshot: true,
        addonsSnapshot: true,
        renewsOrderId: true,
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            note: true,
            actorEmail: true,
            createdAt: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    return order;
  }

  /**
   * Q-A (item 1) — règlement d'une commande par SOLDE : débit + confirmation
   * ATOMIQUES (`CheckoutService.payOrderWithWallet`, une seule transaction).
   * Le dossier invité non lié est d'abord rattaché au compte
   * (`ensureOwnedCustomer`, conflit si le dossier appartient à un autre
   * compte) ; le propriétaire STRICT (`customer.userId === sub`) est ensuite
   * revérifié côté service — 404 sinon, jamais de fuite d'existence.
   */
  @Post('orders/:id/pay-with-wallet')
  @ApiOperation({ summary: 'Régler ma commande avec mon solde portefeuille' })
  async payMyOrderWithWallet(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.wallet.ensureOwnedCustomer(user);
    return this.checkout.payOrderWithWallet(id, user);
  }

  /** Factures du client connecté, paginées, triées de la plus récente. */
  @Get('invoices')
  @ApiOperation({ summary: 'Mes factures (client, paginé)' })
  async listMyInvoices(
    @CurrentUser() user: JwtPayload,
    @Query() query: InvoiceListQueryDto,
  ) {
    const { page, perPage, skip } = this.clamp(query);
    const where: Prisma.InvoiceWhereInput = {
      customer: this.ownedBy(user),
    };
    if (query.status) where.status = query.status;
    const q = query.q?.trim();
    if (q) where.number = { contains: q, mode: 'insensitive' };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip,
        take: perPage,
        select: INVOICE_LIST_SELECT,
      }),
    ]);
    return { items: rows.map(withHasPdf), total, page, perPage };
  }

  /** Détail d'une facture — 404 si elle n'appartient pas au compte. */
  @Get('invoices/:id')
  @ApiOperation({ summary: 'Détail de ma facture' })
  async getMyInvoice(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: {
        ...INVOICE_LIST_SELECT,
        billingAddress: true,
        customer: { select: { name: true, email: true } },
        lines: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            kind: true,
            label: true,
            qty: true,
            unitPriceHtCents: true,
            taxRatePercent: true,
            taxAmountCents: true,
            totalTtcCents: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable.');
    const { pdfPath, ...rest } = invoice;
    return { ...rest, hasPdf: pdfPath !== null };
  }

  /**
   * Q-A (item 1) — règlement d'une facture UNPAID par SOLDE : le règlement est
   * commande-centrique et atomique, on redirige vers la commande qui porte la
   * facture. Facture sans commande (ad hoc admin) → 409 honnête ; facture déjà
   * réglée → 409 ; propriétaire strict revérifié côté service (404 sinon).
   */
  @Post('invoices/:id/pay-with-wallet')
  @ApiOperation({ summary: 'Régler ma facture avec mon solde portefeuille' })
  async payMyInvoiceWithWallet(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: { orderId: true, status: true },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable.');
    if (invoice.status !== InvoiceStatus.UNPAID) {
      throw new ConflictException(`Facture ${invoice.status} : déjà réglée.`);
    }
    if (!invoice.orderId) {
      throw new ConflictException('Facture sans commande : règlement par solde impossible.');
    }
    await this.wallet.ensureOwnedCustomer(user);
    return this.checkout.payOrderWithWallet(invoice.orderId, user);
  }

  /**
   * Q-A (item 4) — armement / RÉVOCATION du renouvellement automatique par le
   * propriétaire strict de la commande. `enabled=true` enregistre le
   * consentement daté (`renewalConsentAt`, si absent) et arme `autoRenew` +
   * l'échéance ; `enabled=false` bascule `autoRenew=false` immédiatement (le
   * consentement historique reste daté) **ET CASCADE vers toute la descendance
   * de la chaîne** (GO Q12-P2) : la fille de renouvellement porte le
   * consentement copié dans SON `autoRenew`, et la mère est déjà passée à
   * false à la création — sans cascade, la révocation serait silencieuse et la
   * reprise débiterait malgré tout. CAS : les sweeps de création voient l'état
   * courant — la révocation même concurrente à un sweep est sûre (le flip de
   * création exige `autoRenew: true`, la reprise un CAS sur la fille).
   */
  @Patch('orders/:id/renewal')
  @ApiOperation({ summary: 'Activer ou révoquer le renouvellement automatique' })
  async setMyOrderRenewal(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: RenewalToggleDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: {
        id: true,
        status: true,
        billingCycle: true,
        autoRenew: true,
        renewalConsentAt: true,
        nextBillingDate: true,
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    if (order.billingCycle === BillingCycle.ONETIME) {
      throw new ConflictException('Commande sans abonnement : aucun renouvellement à gérer.');
    }

    let revokedDescendants = 0;
    if (body.enabled) {
      if (
        order.status !== OrderStatus.PAID &&
        order.status !== OrderStatus.PROVISIONING &&
        order.status !== OrderStatus.ACTIVE
      ) {
        throw new ConflictException(
          `Commande ${order.status} : renouvellement armable seulement après règlement.`,
        );
      }
      const now = new Date();
      const next =
        order.nextBillingDate ?? addBillingCycle(now, order.billingCycle) ?? now;
      await this.prisma.order.updateMany({
        where: { id: order.id, autoRenew: false },
        data: {
          autoRenew: true,
          renewalConsentAt: order.renewalConsentAt ?? now,
          nextBillingDate: next,
        },
      });
    } else {
      // GO fenêtres R1 : CAS + walk de descendance + cascade dans UNE
      // transaction, ACQUISE D'ABORD sur la barrière de chaîne commune avec
      // la création de descendants (`acquireRenewalChainBarrier`) :
      //  - la révocation qui attend la barrière découvre, une fois acquise,
      //    TOUS les descendants committés (y compris une fille G préparée par
      //    un renouvellement concurrent, invisible pendant son ouverture) ;
      //  - un renouvellement concurrent qui attend la barrière voit ensuite
      //    le CAS `autoRenew` déjà basculé (COUNT = 0 → aucune fille armée) ;
      //  - un walk seul + `updateMany` séparé ne suffisait PAS : G pouvait
      //    committer armé entre les deux, ni vu ni désarmé.
      // Cible : CAS idempotent (révocation même déjà faite = no-op sûr).
      // Cascade vers les FILLES de renouvellement (descendance `renewsOrderId`)
      // : c'est LEUR `autoRenew` (consentement de la chaîne) que la reprise
      // vérifie par CAS avant tout débit — la mère est souvent déjà à false.
      // Le paiement manuel (sans option de consentement) reste hors barrière :
      // révoquer n'empêche jamais de régler volontairement.
      revokedDescendants = await this.prisma.$transaction(
        async (tx) => {
          const rootId = await renewalChainRootId(tx, order.id);
          await acquireRenewalChainBarrier(tx, rootId);
          await tx.order.updateMany({
            where: { id: order.id, autoRenew: true },
            data: { autoRenew: false },
          });
          const closed = new Set<string>();
          let frontier: string[] = [order.id];
          // GO limite de chaîne : parcours JUSQU'AU BOUT de la descendance
          // (l'ancienne « garde 50 » tronquait silencieusement et le CAS
          // ci-dessous annonçait un succès PARTIEL — les maillons au-delà
          // de 50 restaient armés). Cycle ou profondeur hors garde →
          // ConflictException DANS la tx → rollback complet, jamais de
          // succès partiel.
          for (;;) {
            if (frontier.length === 0) break;
            const children = await tx.order.findMany({
              where: { renewsOrderId: { in: frontier } },
              select: { id: true },
            });
            frontier = [];
            for (const child of children) {
              if (child.id === order.id || closed.has(child.id)) {
                throw new ConflictException(
                  `chaine_cyclique: référence circulaire détectée en descendant la chaîne (commande ${child.id}).`,
                );
              }
              // Garde de profondeur (+1 = la commande de départ, alignée sur
              // la remontée de renewalChainRootId) : refus explicite.
              if (closed.size + 1 >= RENEWAL_CHAIN_MAX_DEPTH) {
                throw new ConflictException(
                  `chaine_profondeur_depassee: descendance de plus de ${RENEWAL_CHAIN_MAX_DEPTH} maillons (commande ${child.id}).`,
                );
              }
              closed.add(child.id);
              frontier.push(child.id);
            }
          }
          if (closed.size === 0) return 0;
          const cascade = await tx.order.updateMany({
            where: { id: { in: [...closed] }, autoRenew: true },
            data: { autoRenew: false },
          });
          return cascade.count;
        },
        { timeout: 30_000 },
      );
    }

    await this.audit
      .record({
        action: 'subscription.renewal_toggled',
        resourceType: 'order',
        resourceId: order.id,
        details: {
          enabled: body.enabled,
          ...(body.enabled ? {} : { revokedDescendants }),
        },
      })
      .catch(() => {});

    const fresh = await this.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        id: true,
        autoRenew: true,
        renewalConsentAt: true,
        nextBillingDate: true,
      },
    });
    return fresh;
  }

  /**
   * PDF de ma facture (D1) — même isolation que le détail (404 si le compte
   * n'en est pas propriétaire). Rendu figé à l'émission, jamais régénéré à
   * partir des paramètres courants.
   */
  @Get('invoices/:id/pdf')
  @ApiOperation({ summary: 'Télécharger le PDF de ma facture (client)' })
  async getMyInvoicePdf(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, customer: this.ownedBy(user) },
      select: { id: true, number: true },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable.');
    const { absPath, fileName } = await this.pdf.ensurePdf(invoice.id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    return new StreamableFile(fs.createReadStream(absPath));
  }
}

/** Champs « liste commande » — select explicite, jamais de secret interne. */
const ORDER_LIST_SELECT = {
  id: true,
  status: true,
  productName: true,
  billingCycle: true,
  currency: true,
  amountHtCents: true,
  taxAmountCents: true,
  amountTtcCents: true,
  createdAt: true,
  paidAt: true,
  nextBillingDate: true,
  autoRenew: true,
  // Q-A (item 4) — consentement daté exposé au client (jamais modifiable
  // directement : armement/révocation via PATCH orders/:id/renewal).
  renewalConsentAt: true,
  customerName: true,
  customerEmail: true,
  paymentMethodName: true,
  product: { select: { slug: true } },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.OrderSelect;

/** Champs « liste facture » — le chemin PDF disque n'est jamais exposé brut. */
const INVOICE_LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  currency: true,
  amountHtCents: true,
  taxAmountCents: true,
  amountTtcCents: true,
  issuedAt: true,
  dueDate: true,
  paidAt: true,
  pdfPath: true,
  orderId: true,
  order: { select: { id: true, productName: true, status: true } },
} satisfies Prisma.InvoiceSelect;

function withHasPdf<T extends { pdfPath: string | null }>({
  pdfPath,
  ...rest
}: T): Omit<T, 'pdfPath'> & { hasPdf: boolean } {
  return { ...rest, hasPdf: pdfPath !== null };
}
