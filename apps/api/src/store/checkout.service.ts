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
  SubscriptionStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/types';
import { RATE, rateKey, SaRateLimiter } from '../auth/rate-limiter';
import { MailSettingsService } from '../mail/mail-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { regexFromRejectPattern } from './subdomain.util';
import { clientAreaUrl, loginUrl } from './web-links';
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
    private readonly cloudflare: CloudflareService,
  ) {}

  /**
   * POST /store/checkout — tunnel de commande UNIQUE pour l'espace client et le
   * visiteur invité (Bloc 2). Valide la configuration, recale les montants, crée
   * User + Customer + Order(PAID) + Invoice(PAID) atomiquement (invité) ou
   * réutilise le compte + abonnement existants (membre connecté → upgrade order
   * -driven), envoie l'email. Après paiement : upgrade → `syncAppLimits` sur les
   * apps déjà déployées ; création → provisioning réel (Bloc D).
   */
  async checkoutGuest(
    dto: CheckoutDto,
    ip?: string,
    user?: JwtPayload | null,
  ): Promise<CheckoutResult> {
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
    // Sous-domaine choisi (produits porteurs d'une FreeSubdomainRule) : normalisé
    // + dispo vérifiée (fail-fast). Null sinon → le provisioning auto-génère.
    const requestedSubdomain = await this.resolveRequestedSubdomain(product, dto.subdomain);

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

    // 4. Résolution du compte. Invité → User+Customer créés dans la transaction.
    //    Client connecté (OptionalJwtAuthGuard) → on RÉUTILISE le User + Customer
    //    existants (Customer.userId @unique) : email/nom autoritaires depuis le
    //    jeton, jamais depuis le corps. C'est le chemin « upgrade depuis l'espace
    //    client » — il passe bien par la procédure de commande store.
    let member: {
      userId: string;
      email: string;
      name: string;
      phone: string | null;
      customerId: string | null;
    } | null = null;
    if (user?.sub) {
      const authed = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { id: true, email: true, name: true },
      });
      if (authed) {
        // `Customer.userId` est un scalaire @unique (pas de relation Prisma
        // User↔Customer dans le schéma) → on lit le Customer par userId.
        const customer = await this.prisma.customer.findUnique({
          where: { userId: authed.id },
        });
        member = {
          userId: authed.id,
          email: authed.email,
          name: authed.name ?? '',
          phone: customer?.phone ?? null,
          customerId: customer?.id ?? null,
        };
      }
    }

    // Email/nom de RÉCEPTION (où l'on notifie + à qui on livre l'accès) : pour un
    // membre, toujours le compte (login). Pour un invité, les coordonnées saisies.
    const receiptEmail = member ? member.email : dto.email.trim().toLowerCase();
    const receiptName = member ? member.name : dto.name;

    // Requête (point 6) — membre connecté : choix du détail de facturation.
    //   true (défaut)  = facturer sous les coordonnées du compte (nom/email/tél. du compte).
    //   false          = facturer sous d'autres coordonnées (nom/email/téléphone du corps),
    //                    comme les gros hébergeurs (coordonnées de société sur la facture).
    // Dans les DEUX cas, l'abonnement et l'espace restent liés au User authentifié
    // (user.sub, on ne change jamais l'email de connexion) ; seuls la commande et
    // la facture portent les coordonnées de facturation choisies.
    const useAccount = !!member && dto.useAccountDetails !== false;
    const billingName = useAccount ? member!.name : dto.name;
    const billingEmail = useAccount
      ? member!.email
      : dto.email.trim().toLowerCase();
    const billingPhone = useAccount
      ? member!.phone ?? null
      : (dto.phone ?? null);

    // 5. Clé d'idempotence : hash déterministe de la configuration + montant.
    //    Basée sur les coordonnées de FACTURATION (billingEmail) : un changement
    //    de mode (compte/autres coordonnées) produit bien une commande distincte.
    const key = this.idempotencyKey(dto, method.id, amountTtcCents, billingEmail);

    // 6. Replay (double-clic / retry identique) : on renvoie la commande déjà
    //    créée, SANS recréer de compte ni de commande (§7 idempotence).
    const replay = await this.prisma.order.findUnique({ where: { idempotencyKey: key } });
    if (replay) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { orderId: replay.id },
      });
      return {
        orderId: replay.id,
        invoiceNumber: invoice?.number ?? '',
        email: receiptEmail,
        nextStep: 'provisioning-pending',
      };
    }

    // 7. Invité uniquement : pas de doublon de compte. Un membre déjà connecté ne
    //    déclenche jamais ce contrôle (c'est son propre compte). Le mot de passe
    //    temporaire n'existe que pour l'invité.
    const tempPassword = member ? null : randomBytes(12).toString('hex');
    const passwordHash = tempPassword ? await bcrypt.hash(tempPassword, 10) : null;
    if (!member) {
      const existingUser = await this.prisma.user.findUnique({ where: { email: billingEmail } });
      if (existingUser) {
        throw new ConflictException(
          'Un compte existe déjà avec cet email — connectez-vous pour commander.',
        );
      }
    }

    // 8. Transaction atomique post-paiement.
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        let user: { id: string };
        let customer: { id: string };
        if (member) {
          user = { id: member.userId };
          customer = member.customerId
            ? { id: member.customerId }
            : await tx.customer.create({
                data: {
                  email: member.email,
                  name: member.name,
                  accountType: CustomerAccountType.FULL,
                  userId: member.userId,
                },
              });
        } else {
          user = await tx.user.create({
            data: { email: billingEmail, name: dto.name, role: 'USER', passwordHash: passwordHash! },
          });
          customer = await tx.customer.create({
            data: {
              email: billingEmail,
              name: dto.name,
              phone: dto.phone ?? null,
              accountType: CustomerAccountType.FULL,
              userId: user.id,
            },
          });
        }
        const billing = await this.claimInvoiceSequence(tx);
        const order = await tx.order.create({
          data: {
            customerId: customer.id,
            customerName: billingName,
            customerEmail: billingEmail,
            customerPhone: billingPhone,
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
            requestedSubdomain,
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
              name: billingName,
              email: billingEmail,
              phone: billingPhone,
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
            actorEmail: billingEmail,
          },
        });

        // Bloc 1 — modèle d'abonnement order-driven. Tout produit à pack crée ou
        // UPGRADE l'abonnement du client dès le paiement (le paiement vaut
        // approbation ; l'admin garde suspendre/réactiver/ré-synchroniser).
        // Un produit sans pack (ex. Installation Fees) ne crée pas d'abonnement.
        let subscription: { id: string } | null = null;
        let subscriptionAction: 'upgraded' | 'created' | null = null;
        if (product.packId) {
          const active = await tx.subscription.findFirst({
            where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
            orderBy: { createdAt: 'desc' },
          });
          if (active) {
            // Upgrade : repointe la MÊME ligne (données/apps/sous-domaines
            // préservés), relie la commande à l'origine de l'upgrade.
            subscription = await tx.subscription.update({
              where: { id: active.id },
              data: { productId: product.id, orderId: order.id },
            });
            subscriptionAction = 'upgraded';
          } else {
            subscription = await tx.subscription.create({
              data: {
                userId: user.id,
                productId: product.id,
                status: SubscriptionStatus.ACTIVE,
                orderId: order.id,
              },
            });
            subscriptionAction = 'created';
          }
        }

        return { user, order, invoice, billing, subscription, subscriptionAction };
      });

      await this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, true);

      // 7. Email best-effort : compte créé (mot de passe temporaire) OU
      //    confirmation d'abonnement mis à jour (membre) — jamais bloquant.
      await this.sendPostCheckoutEmail(
        receiptEmail,
        receiptName,
        tempPassword,
        created.billing.invoiceNumber,
        created.subscriptionAction,
      ).catch((e) => this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, false, String(e)));

      // 8. Provisioning réel, fire-and-forget, jamais bloquant (§10).
      //    - upgrade : on NE crée PAS de nouvelle app — on ré-applique les
      //      limites du nouveau pack aux apps déjà déployées (data préservée).
      //    - création ou produit sans pack (ex. Installation Fees) : provisionOrder,
      //      qui passe ACTIVE immédiatement s'il n'y a aucune action à exécuter.
      if (created.subscriptionAction === 'upgraded') {
        this.provisioning.syncAppLimits(created.subscription!.id).catch(() => {});
      } else {
        this.provisioning.provisionOrder(created.order.id).catch(() => {});
      }

      return {
        orderId: created.order.id,
        invoiceNumber: created.billing.invoiceNumber,
        email: receiptEmail,
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
            email: receiptEmail,
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

  /** Hash déterministe : adresse de facturation + slug + options + addons + moyen + montant TTC. */
  private idempotencyKey(
    dto: CheckoutDto,
    methodId: string,
    amountTtcCents: number,
    billingEmail: string,
  ): string {
    const options = [...(dto.options ?? [])]
      .map((o) => `${o.optionId}:${o.choiceId}`)
      .sort()
      .join(',');
    const addons = [...(dto.addonIds ?? [])].sort().join(',');
    const payload = [billingEmail, dto.productSlug, options, addons, methodId, amountTtcCents].join('|');
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

  /**
   * Email de confirmation post-commande — best-effort, jamais bloquant.
   * - Invité (nouveau compte) : identifiants + mot de passe temporaire.
   * - Membre (upgrade) : confirmation que l'abonnement est mis à jour, données
   *   et applications conservées.
   */
  private async sendPostCheckoutEmail(
    to: string,
    name: string,
    tempPassword: string | null,
    invoiceNumber: string,
    subscriptionAction: 'upgraded' | 'created' | null,
  ): Promise<void> {
    const isUpgrade = subscriptionAction === 'upgraded';
    const isNewAccount = !!tempPassword;
    const lines: string[] = [
      `Bonjour ${name},`,
      '',
    ];
    if (isUpgrade) {
      lines.push(
        `Votre abonnement a été mis à jour (commande ${invoiceNumber}).`,
        'Vos données et votre/vos application(s) sont conservées, et les ressources',
        'de votre nouveau plan ont été appliquées.',
        '',
      );
    } else {
      lines.push(
        `Votre paiement a bien été validé (commande ${invoiceNumber}). Votre`,
        'abonnement est actif et votre application est en cours de préparation :',
        'vous recevrez son adresse (sous-domaine) par email dès qu’elle sera en ligne.',
        '',
      );
    }
    // Espace client — où le client suit ses apps, son abonnement et ses factures.
    lines.push(
      'Votre espace client :',
      `  ${clientAreaUrl()}`,
      '',
    );
    if (isNewAccount) {
      lines.push(
        'Voici vos identifiants de connexion :',
        `  Email : ${to}`,
        `  Mot de passe temporaire : ${tempPassword}`,
        '',
        'Connectez-vous sur cette page :',
        `  ${loginUrl()}`,
        '',
        'Changez ce mot de passe dès votre première connexion, puis rendez-vous',
        'dans l’espace client pour suivre votre abonnement et votre application.',
        '',
      );
    } else {
      lines.push(
        'Retrouvez votre abonnement, vos applications et vos factures dans l’espace client.',
        '',
      );
    }
    lines.push('L’équipe Code Diali');
    await this.mail.sendPlain({
      to,
      subject: isUpgrade
        ? `Votre abonnement a été mis à jour — commande ${invoiceNumber}`
        : `Vos accès Code Diali — commande ${invoiceNumber}`,
      text: lines.join('\n'),
    });
  }

  /**
   * Sous-domaine choisi au checkout (produits porteurs d'une FreeSubdomainRule) :
   * normalisé, dispo vérifiée en fail-fast. Retourne null si absent/non applicable
   * → le provisioning auto-génère un sous-domaine (comportement Bloc E). La
   * désallocation atomique reste garantie par allocateClientSubdomain au déploiement.
   */
  private async resolveRequestedSubdomain(
    product: PublicProduct,
    subdomain?: string,
  ): Promise<string | null> {
    const raw = subdomain?.trim();
    if (!raw) return null;
    const rule = product.freeSubdomainRule;
    if (!rule) return null; // produit sans sous-domaine → ignoré
    const sub = raw.toLowerCase();
    if (sub.length < (rule.minLength ?? 3) || sub.length > (rule.maxLength ?? 40)) {
      throw new BadRequestException(
        `Sous-domaine invalide (longueur ${rule.minLength ?? 3}-${rule.maxLength ?? 40} caractères).`,
      );
    }
    if (rule.rejectPattern && regexFromRejectPattern(rule.rejectPattern)?.test(sub)) {
      throw new BadRequestException(`Sous-domaine « ${sub} » non autorisé.`);
    }
    const domainId =
      rule.allowedDomainIds?.[0] ??
      (await this.prisma.domain.findFirst({ where: { status: 'ACTIVE' } }))?.id;
    if (!domainId) throw new BadRequestException('Aucun domaine racine disponible.');
    const res = await this.cloudflare.checkSubdomainAvailability(sub, domainId);
    if (!res.available) {
      throw new BadRequestException(`Sous-domaine déjà pris : ${res.fqdn}`);
    }
    return sub;
  }
}
