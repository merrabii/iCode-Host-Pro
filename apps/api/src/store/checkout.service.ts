import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BillingCycle,
  BillingSetting,
  CustomerAccountType,
  HostingServiceStatus,
  InvoiceLineKind,
  InvoiceStatus,
  OrderStatus,
  PaymentMethodType,
  Prisma,
  ProvisionAction,
  SubscriptionStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/types';
import { RATE, rateKey, SaRateLimiter } from '../auth/rate-limiter';
import { MailSettingsService } from '../mail/mail-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { isPaymentSimulatorEnabled } from '../config/payment-simulator';
import { regexFromRejectPattern } from './subdomain.util';
import { clientAreaUrl, loginUrl } from './web-links';
import { addBillingCycle } from './billing-cycle';
import { claimInvoiceSequence } from './invoice-sequence';
import { ProductsService, PublicProduct } from '../products/products.service';
import { CheckoutDto, QuoteDto } from './dto/checkout.dto';
import { ProvisioningService } from './provisioning.service';
import { isHostingC3Enabled } from '../hosting/c3-flag';
import { C3CapabilityService } from '../hosting/c3-capability.service';
import { snapshotsFromPack } from '../hosting/hosting-services.service';
import { ReservationPayload } from '../hosting/hosting-fingerprint';

/** Taux appliqué quand le produit n'en référence aucun (« Exonéré 0% »). */
const DEFAULT_TAXRATE_PERCENT = 0;

/**
 * 17B.4F-C3 — rejeu détecté DANS la transaction (double-clic concurrent sous
 * garde ON) : renvoie la commande existante SANS refus (« rejeu avant refus »),
 * sans double écriture. Attrapé dans le catch du checkout avant le P2002.
 */
export class CheckoutReplaySignal extends Error {
  constructor(public readonly orderId: string) {
    super('checkout_replay');
  }
}

/** Catalogue C3 du produit (lecture dédiée sous ON — PublicProduct ne l'expose pas). */
type C3CatalogProduct = {
  packId: string | null;
  provisionModuleId: string | null;
  moduleParams: unknown;
  provisionModule: { actions: unknown } | null;
  pack: {
    id: string;
    name: string;
    ramMb: number;
    cpuCores: number;
    storageLimit: number | null;
    maxApps: number | null;
    status: string;
    deploymentModuleId: string | null;
  } | null;
};

/** Réponse lisible du checkout (jamais de secret, jamais de hostname Coolify). */
export interface CheckoutResult {
  orderId: string;
  invoiceNumber: string;
  email: string;
  /** `payment-pending` = règlement à confirmer (aucun droit ouvert) ;
   *  `provisioning-pending` = règlement CONFIRMÉ, exécution lancée. */
  nextStep: 'payment-pending' | 'provisioning-pending';
}

/** Source d'une confirmation de règlement (traçabilité, audit). */
export type ConfirmSource = 'free' | 'admin-transfer' | 'card-simulator' | 'wallet';

/** Contexte de confirmation serveur d'une commande. */
export interface ConfirmPaidContext {
  source: ConfirmSource;
  actorEmail?: string | null;
  /** P9 (E1) : identifiant de l'acteur déclencheur (admin) pour l'audit —
   *  absent pour un déclencheur système/invité (l'acteur devient alors le
   *  propriétaire du compte). */
  actorId?: string | null;
  reference?: string | null;
  /** Payload email complet (invité) — uniquement pour la source `free`. */
  email?: { to: string; name: string; tempPassword: string | null };
}

/** Résultat d'une confirmation (idempotence : la 2e appelée ne réécrit rien). */
export interface ConfirmPaidResult {
  orderId: string;
  status: OrderStatus;
  alreadyConfirmed: boolean;
  subscriptionAction?: 'created' | 'upgraded' | null;
}

/** Ligne de facture construite côté serveur (d'où dérivent les totaux). */
export interface InvoiceLineInput {
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
 * Règles métier (prompt WHMCS + décisions owner + GO socle commercial) :
 * - Montants JAMAIS reçus du client : tout est recalculé serveur.
 * - AUCUN paiement simulé implicite : une commande payante est créée
 *   `PENDING_PAYMENT` et n'ouvre AUCUN droit (abonnement, service, app) avant
 *   une CONFIRMATION serveur valide (commande gratuite explicite, règlement
 *   virement validé par l'admin, simulateur de recette explicitement activé).
 * - Une méthode CARD/BANK_TRANSFER active n'est JAMAIS une preuve de paiement.
 * - Compte créé APRÈS soumission, atomiquement : User (mot de passe temporaire
 *   bcrypt, envoyé par email) + Customer FULL lié — le compte ne vaut pas
 *   confirmation de règlement.
 * - Idempotence (§7) : hash déterministe d'intention (`idempotencyBase`) ;
 *   replay tant que la commande est vivante ; un rachat APRÈS annulation crée
 *   une NOUVELLE clé sans jamais supprimer les anciennes ; la clé client
 *   (header `Idempotency-Key`) liée à un contenu différent = conflit 409.
 * - Email best-effort : si l'envoi échoue, la commande reste valide et l'échec
 *   est tracé en audit (l'admin peut récupérer le mot de passe).
 */
@Injectable()
export class CheckoutService {
  private readonly log = new Logger(CheckoutService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly audit: AuditService,
    private readonly limiter: SaRateLimiter,
    private readonly mail: MailSettingsService,
    private readonly provisioning: ProvisioningService,
    private readonly cloudflare: CloudflareService,
    private readonly c3: C3CapabilityService,
  ) {}

  /**
   * POST /store/checkout — tunnel de commande UNIQUE pour l'espace client et le
   * visiteur invité (Bloc 2). Valide la configuration, recale les montants,
   * crée User + Customer + Order(PENDING_PAYMENT) + Invoice(UNPAID)
   * atomiquement (invité) ou réutilise le compte existant (membre connecté →
   * upgrade order-driven). Les DROITS (abonnement, tracking C3, service) et le
   * provisioning ne partent qu'après confirmation serveur (`confirmOrderPaid`).
   * Commande GRATUITE (total 0) : confirmation immédiate via la règle explicite
   * — aucun encaissement n'est fabriqué (aucun mouvement de portefeuille).
   */
  async checkoutGuest(
    dto: CheckoutDto,
    ip?: string,
    user?: JwtPayload | null,
    opts?: { idempotencyKey?: string | null },
  ): Promise<CheckoutResult> {
    const clientKey = opts?.idempotencyKey?.trim() || null;
    if (clientKey && clientKey.length > 200) {
      throw new BadRequestException('Idempotency-Key invalide (200 caractères max).');
    }
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
    // Phase 4 — sous-domaine ET domaine racine choisis par le client (produits
    // porteurs d'une FreeSubdomainRule) : normalisés + validés (fail-fast), AUCUN
    // fallback arbitraire (jamais allowedDomainIds[0]). `requestedDomainId` = choix
    // explicite ; la racine effective sera FIGÉE par le provisioning. Plusieurs
    // racines éligibles sans choix → erreur d'ambiguïté (#10).
    const { requestedSubdomain, requestedDomainId } = await this.resolveSubdomainAndRoot(product, dto);

    // 2. Moyen de paiement actif (jamais les secrets — PaymentMethod.config est
    //    non secret, configEnc reste chiffré et n'est pas lu ici).
    const method = await this.prisma.paymentMethod.findFirst({
      where: { id: dto.paymentMethodId, isActive: true },
    });
    if (!method) {
      throw new BadRequestException('Ce moyen de paiement n’est pas disponible.');
    }
    // 2b. Carte : refus HONNÊTE tant qu'aucun adaptateur réel n'est configuré
    //     (aucun prestataire choisi). Le simulateur (recette/tests) doit être
    //     explicitement activé — jamais en production (payment-simulator.ts).
    if (method.type === PaymentMethodType.CARD && !isPaymentSimulatorEnabled()) {
      throw new BadRequestException(
        'Le paiement par carte n’est pas encore disponible : aucun prestataire configuré. Choisissez un autre moyen de paiement.',
      );
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

    // 5. Hash d'INTENTION : configuration + montant + coordonnées de
    //    facturation. Base de l'idempotence (§7) et du chaînage des rachats.
    const baseKey = this.idempotencyKey(
      dto,
      method.id,
      amountTtcCents,
      billingEmail,
      requestedSubdomain,
      requestedDomainId,
    );

    // 6. Idempotence — résolution PRÉ-TX :
    //    (a) clé client (`Idempotency-Key`) : même clé ⇒ contenu identique
    //        obligatoire (sinon conflit 409), le résultat renvoyé est celui de
    //        la commande existante quel que soit son état ;
    //    (b) sans clé client : dernière commande de MÊME intention ; si elle est
    //        CANCELLED/REFUNDED → NOUVEL achat (nouvelle clé chaînée, anciennes
    //        clés conservées). Une commande vivante (PENDING_PAYMENT…ACTIVE) →
    //        replay honnête.
    const { replay, chainFrom } = await this.resolveIntention(baseKey, clientKey);
    if (replay) {
      return this.replayResult(replay, receiptEmail);
    }
    // Clé du NOUVEAU départ : base, ou chaînée à la commande annulée/remboursée.
    const key = chainFrom
      ? createHash('sha256').update(`${baseKey}|${chainFrom.id}`).digest('hex')
      : baseKey;

    // 7. Invité uniquement : pas de doublon de compte. Un membre déjà connecté ne
    //    déclenche jamais ce contrôle (c'est son propre compte). Le mot de passe
    //    temporaire n'existe que pour l'invité.
    //
    // ── 17B.4F-C3 (garde ON) — capability LIVE + fast-fails AVANT toute écriture.
    // Placé APRÈS le rejeu pré-tx (point 6) : un double-clic identique renvoie sa
    // commande existante AVANT tout refus (« rejeu avant refus »). OFF : ce bloc
    // n'exécute AUCUN appel (zéro différence de comportement legacy).
    let c3On = false;
    if (isHostingC3Enabled()) {
      if (!(await this.c3.operational())) {
        throw new ServiceUnavailableException(
          'Provisioning C3 activé mais schéma indisponible (migration C1/C3 requise).',
        );
      }
      const catalog = await this.loadC3Catalog(product.id);
      const actions = (catalog?.provisionModule?.actions ?? []) as ProvisionAction[] | null;
      if (actions && actions.length > 0 && !actions.includes(ProvisionAction.CREATE_APP)) {
        throw new ConflictException(
          'Ce produit n’est pas provisionnable en C3 (CREATE_APP requis) — commande refusée.',
        );
      }
      if (product.packId) {
        if (!catalog?.pack) {
          throw new ConflictException('Pack produit introuvable — commande refusée (C3).');
        }
        // Upgrade refusé sous C3 (limite C4 documentée) : aucun pack acheté par un
        // compte qui détient déjà un abonnement actif.
        if (member) {
          const activeSub = await this.prisma.subscription.findFirst({
            where: { userId: member.userId, status: SubscriptionStatus.ACTIVE },
            orderBy: { createdAt: 'desc' },
          });
          if (activeSub) {
            throw new ConflictException(
              'Abonnement actif existant : upgrade non pris en charge en C3 (contactez le support).',
            );
          }
        }
      }
      c3On = true;
    }

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
        // 17B.4F-C3 (ON) — sous garde, AVANT toute écriture :
        // ① verrou `User` (membre) : sérialise les checkouts concurrents du même
        //    compte (deux commandes pack simultanées → une seule gagne le recheck) ;
        // ② rejeu par clé d'idempotence PRÉ-TX relu SOUS verrou (double-clic
        //    concurrent ayant passé le findUnique pré-tx) → renvoie la commande
        //    existante SANS refus ;
        // ③ recheck autoritaire d'abonnement actif (upgrade refusé sous C3) —
        //    le recheck pré-tx peut avoir été obsolète entre-temps.
        if (c3On) {
          if (member) {
            const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${member.userId} FOR UPDATE`;
            if (!locked[0]) {
              throw new ConflictException('Compte introuvable.');
            }
            const dup = await tx.order.findUnique({ where: { idempotencyKey: key } });
            if (dup) {
              throw new CheckoutReplaySignal(dup.id);
            }
            if (product.packId) {
              const activeSub = await tx.subscription.findFirst({
                where: { userId: member.userId, status: SubscriptionStatus.ACTIVE },
                orderBy: { createdAt: 'desc' },
              });
              if (activeSub) {
                throw new ConflictException(
                  'Abonnement actif existant : upgrade non pris en charge en C3 (contactez le support).',
                );
              }
            }
          }
        }
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
        const claim = await this.claimInvoiceSequence(tx);
        const billing = claim.billing; // ligne BillingSetting figée (D1)
        // Commande payante créée EN ATTENTE de règlement : aucun droit ouvert
        // ici (aucune souscription, aucun tracking C3, aucun service). Les
        // droits partent de `confirmOrderPaid` (confirmation serveur valide).
        const order = await tx.order.create({
          data: {
            customerId: customer.id,
            customerName: billingName,
            customerEmail: billingEmail,
            customerPhone: billingPhone,
            productId: product.id,
            productName: product.name,
            packId: product.packId ?? null,
            status: OrderStatus.PENDING_PAYMENT,
            billingCycle: product.billingCycle,
            currency: claim.currency,
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
            idempotencyBase: baseKey,
            clientKey,
            clientKeyHash: clientKey ? baseKey : null,
            requestedSubdomain,
            requestedDomainId,
          },
        });

        const issuedAt = new Date();
        const dueDays = Math.min(Math.max(0, billing.invoiceDueDays ?? 14), 3650);
        const invoice = await tx.invoice.create({
          data: {
            number: claim.invoiceNumber,
            orderId: order.id,
            customerId: customer.id,
            status: InvoiceStatus.UNPAID,
            currency: claim.currency,
            taxRatePercent: new Prisma.Decimal(taxRatePercent),
            amountHtCents,
            taxAmountCents,
            amountTtcCents,
            // D1 : échéance + mentions figées à l'émission (jamais relues).
            issuedAt,
            dueDate: new Date(issuedAt.getTime() + dueDays * 86_400_000),
            legalMentionsSnapshot: {
              companyName: billing.companyName || null,
              companyAddress: billing.companyAddress,
              companyTaxId: billing.companyTaxId,
              companyEmail: billing.companyEmail,
              mentions: Array.isArray(billing.legalMentions)
                ? (billing.legalMentions as string[])
                : null,
              invoiceDueDays: billing.invoiceDueDays,
            },
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
            status: OrderStatus.PENDING_PAYMENT,
            note: 'Commande créée — règlement en attente de confirmation.',
            actorEmail: billingEmail,
          },
        });

        return { user, order, invoice, billing: claim };
      });

      await this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, true, undefined, {
        stage: 'order-created',
        status: OrderStatus.PENDING_PAYMENT,
        methodType: method.type,
      }, { id: created.user?.id ?? null, email: billingEmail });

      const invoiceNumber = created.billing.invoiceNumber;

      // 7. Règle EXPLICITE commande gratuite (total 0) : confirmation immédiate,
      //    SANS fabriquer d'encaissement (aucun mouvement de portefeuille, aucun
      //    paiement simulé — le montant est réellement nul). Échec de la
      //    confirmation → la commande reste PENDING_PAYMENT (honnête) + audit.
      if (amountTtcCents === 0) {
        try {
          const confirmed = await this.confirmOrderPaid(created.order.id, {
            source: 'free',
            actorEmail: receiptEmail,
            email: { to: receiptEmail, name: receiptName, tempPassword },
          });
          if (confirmed.alreadyConfirmed) {
            // Ne devrait pas arriver (commande fraîche) — comportement honnête.
            this.log.warn(`checkout order=${created.order.id}: free order already confirmed`);
          }
          // Email de confirmation complet (identifiants invité + mot de passe
          // temporaire inclus) — best-effort : un échec est tracé en audit et
          // n'invalide jamais la commande (l'admin peut récupérer l'accès).
          await this.sendPostCheckoutEmail(
            receiptEmail,
            receiptName,
            tempPassword,
            invoiceNumber,
            confirmed.subscriptionAction ?? null,
            { phase: 'confirmed' },
          ).catch((e) =>
            this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, false, String(e), {
              stage: 'free-confirm-email',
            }, { id: created.user?.id ?? null, email: receiptEmail }),
          );
          return {
            orderId: created.order.id,
            invoiceNumber,
            email: receiptEmail,
            nextStep: 'provisioning-pending',
          };
        } catch (e) {
          await this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, false, String(e), {
            stage: 'free-confirm-failed',
          }, { id: created.user?.id ?? null, email: receiptEmail });
          // Chute honnête : règlement à confirmer plus tard, aucun droit ouvert.
        }
      }

      // 8. Email best-effort : règlement EN ATTENTE (aucune promesse d'activation).
      //    Invité : identifiants + mot de passe temporaire (le compte existe).
      await this.sendPostCheckoutEmail(receiptEmail, receiptName, tempPassword, invoiceNumber, null, {
        phase: 'pending',
        methodLabel: method.name,
      }).catch((e) =>
        this.traceAudit(product.id, created.order.id, amountTtcCents, method.id, false, String(e), {
          stage: 'pending-email',
        }, { id: created.user?.id ?? null, email: receiptEmail }),
      );

      return {
        orderId: created.order.id,
        invoiceNumber,
        email: receiptEmail,
        nextStep: 'payment-pending',
      };
    } catch (e) {
      // Double-clic concurrent détecté SOUS verrou (17B.4F-C3) : renvoie la
      // commande existante, SANS refus (« rejeu avant refus »).
      if (e instanceof CheckoutReplaySignal) {
        const existing = await this.prisma.order.findUnique({
          where: { id: e.orderId },
        });
        if (existing) {
          return this.replayResult(existing, receiptEmail);
        }
        throw e;
      }
      // Double-clic / retry concurrent : la commande identique existe déjà
      // (contrainte unique `idempotencyKey`/`clientKey`) — résolution honnête
      // par la même intention (un conflit de clé client ressort en 409).
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const again = await this.resolveIntention(baseKey, clientKey);
        if (again.replay) {
          return this.replayResult(again.replay, receiptEmail);
        }
        throw new ConflictException(
          'Un compte existe déjà avec cet email — connectez-vous pour commander.',
        );
      }
      throw e;
    }
  }

  /**
   * Idempotence (§7) — résolution de l'intention AVANT toute écriture :
   * - clé client fournie : commande portant CETTE clé ; contenu identique
   *   obligatoire (`clientKeyHash`) sinon 409 « même clé, contenu différent » ;
   *   le résultat est le retour honnête de la commande existante (statut
   *   compris) — jamais de création silencieuse.
   * - sans clé client : dernière commande de l'intention (hash de base) ;
   *   vivante → replay ; CANCELLED/REFUNDED → `chainFrom` (nouveau départ avec
   *   clé chaînée, les anciennes clés sont JAMAIS supprimées).
   */
  private async resolveIntention(
    baseKey: string,
    clientKey: string | null,
  ): Promise<{
    replay: { id: string; status: OrderStatus } | null;
    chainFrom: { id: string } | null;
  }> {
    if (clientKey) {
      const o = await this.prisma.order.findUnique({
        where: { clientKey },
        select: { id: true, status: true, clientKeyHash: true },
      });
      if (o) {
        if (o.clientKeyHash !== baseKey) {
          throw new ConflictException(
            'Idempotency-Key déjà utilisée avec un contenu différent.',
          );
        }
        return { replay: o, chainFrom: null };
      }
      return { replay: null, chainFrom: null };
    }
    const rows = await this.prisma.order.findMany({
      where: { OR: [{ idempotencyKey: baseKey }, { idempotencyBase: baseKey }] },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { id: true, status: true },
    });
    const last = rows[0] ?? null;
    if (!last) return { replay: null, chainFrom: null };
    if (last.status === OrderStatus.CANCELLED || last.status === OrderStatus.REFUNDED) {
      return { replay: null, chainFrom: { id: last.id } };
    }
    return { replay: last, chainFrom: null };
  }

  /** Réponse de rejeu : honnête sur l'état RÉEL (payé → exécution, sinon attente). */
  private async replayResult(
    order: { id: string; status: OrderStatus },
    receiptEmail: string,
  ): Promise<CheckoutResult> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { orderId: order.id },
    });
    const confirmed =
      order.status === OrderStatus.PAID ||
      order.status === OrderStatus.PROVISIONING ||
      order.status === OrderStatus.ACTIVE ||
      order.status === OrderStatus.SUSPENDED;
    return {
      orderId: order.id,
      invoiceNumber: invoice?.number ?? '',
      email: receiptEmail,
      nextStep: confirmed ? 'provisioning-pending' : 'payment-pending',
    };
  }

  /**
   * CONFIRMATION SERVEUR d'une commande (seul point qui ouvre des droits) :
   * `PENDING_PAYMENT → PAID` + facture `UNPAID → PAID` + abonnement (créé ou
   * upgrade) + écritures C3 (intention + service) dans UNE transaction, puis
   * lancement du provisioning APRÈS commit (fire-and-forget, jamais avalé —
   * un lancement échoué laisse la commande PAID et est relancé par le sweep
   * de reprise, `OrderLifecycleService`).
   *
   * Idempotence : un 2e appel sur une commande déjà confirmée ne réécrit RIEN
   * (ni abonnement, ni écritures) et renvoie `alreadyConfirmed: true`.
   * Une commande annulée/remboursée ne peut PAS être confirmée (409).
   * Les conflits métier (ex. upgrade C3 refusé) font ROLLBACK complet : la
   * commande reste PENDING_PAYMENT, l'échec est audible (jamais un succès
   * annoncé à tort) et l'admin peut résoudre puis relancer.
   */
  async confirmOrderPaid(orderId: string, ctx: ConfirmPaidContext): Promise<ConfirmPaidResult> {
    type TxOutcome = {
      alreadyConfirmed: boolean;
      order: {
        id: string;
        status: OrderStatus;
        customerEmail: string;
        customerName: string;
        requestedSubdomain: string | null;
        amountTtcCents: number;
      };
      subscriptionAction: 'created' | 'upgraded' | null;
      userId: string | null;
      /** P8 (D2) : commande de renouvellement (renewsOrderId) → pas de droits
       *  ni de provisioning : la période est prolongée, le service est inchangé. */
      renewal: boolean;
    };

    let outcome: TxOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx): Promise<TxOutcome> => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { customer: { select: { userId: true } } },
        });
        if (!order) {
          throw new NotFoundException('Commande introuvable.');
        }
        // P8 (D2) : renouvellement = JEUX SPÉCIFIQUES (voir plus bas) : ni
        // création/upgrade d'abonnement, ni tracking/service C3, ni lancement
        // de provisioning — le service existant continue, seule la facture
        // (nouvelle commande) est réglée.
        const isRenewal = !!order.renewsOrderId;
        if (order.status !== OrderStatus.PENDING_PAYMENT) {
          if (
            order.status === OrderStatus.PAID ||
            order.status === OrderStatus.PROVISIONING ||
            order.status === OrderStatus.ACTIVE ||
            order.status === OrderStatus.SUSPENDED
          ) {
            return {
              alreadyConfirmed: true,
              order,
              subscriptionAction: null,
              userId: order.customer.userId,
              renewal: isRenewal,
            };
          }
          throw new ConflictException(
            `Commande ${order.status} : confirmation de règlement impossible.`,
          );
        }

        const now = new Date();
        // CAS : seul PENDING_PAYMENT → PAID (deux confirmations concurrentes →
        // une seule gagne, l'autre lit l'état committé ci-dessous).
        // P8 (D2) : toute confirmation d'un cycle récurrent pose l'ÉCHÉANCE
        // (`nextBillingDate`) et ouvre le renouvellement automatique — décision
        // technique du lot : actif par défaut sur MONTHLY/YEARLY (aucun champ
        // client n'influence le serveur).
        const recurring = order.billingCycle !== BillingCycle.ONETIME;
        const cas = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
          data: {
            status: OrderStatus.PAID,
            paidAt: now,
            ...(recurring
              ? {
                  autoRenew: true,
                  nextBillingDate: addBillingCycle(now, order.billingCycle),
                }
              : {}),
          },
        });
        if (cas.count === 0) {
          const cur = await tx.order.findUnique({
            where: { id: orderId },
            select: { id: true, status: true },
          });
          if (
            cur &&
            (cur.status === OrderStatus.PAID ||
              cur.status === OrderStatus.PROVISIONING ||
              cur.status === OrderStatus.ACTIVE ||
              cur.status === OrderStatus.SUSPENDED)
          ) {
            return {
              alreadyConfirmed: true,
              order,
              subscriptionAction: null,
              userId: order.customer.userId,
              renewal: isRenewal,
            };
          }
          throw new ConflictException('Confirmation concurrente impossible (état instable).');
        }

        await tx.invoice.updateMany({
          where: { orderId, status: InvoiceStatus.UNPAID },
          data: { status: InvoiceStatus.PAID, paidAt: now },
        });

        await tx.orderStatusHistory.create({
          data: {
            orderId,
            status: OrderStatus.PAID,
            note: this.confirmNote(ctx),
            actorEmail: ctx.actorEmail ?? order.customerEmail,
          },
        });

        const userId = order.customer.userId;
        let subscriptionAction: 'created' | 'upgraded' | null = null;
        // P8 (D2) : un renouvellement ne crée NI n'upgrade d'abonnement (la
        // souscription court déjà) — le paiement prolonge la période et la
        // commande passe directement PAID → ACTIVE (service inchangé), dans la
        // MÊME transaction : aucun état PAID « orphelin » que le sweep de
        // reprise tenterait de re-provisionner.
        if (isRenewal) {
          await tx.order.updateMany({
            where: { id: orderId, status: OrderStatus.PAID },
            data: { status: OrderStatus.ACTIVE },
          });
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              status: OrderStatus.ACTIVE,
              note: 'Renouvellement réglé : période suivante ouverte, service inchangé (aucun nouveau provisioning).',
              actorEmail: ctx.actorEmail ?? order.customerEmail,
            },
          });
        } else if (order.packId) {
          if (!userId) {
            throw new ConflictException('Aucun compte lié à cette commande — abonnement impossible.');
          }
          // Bloc 1 — modèle d'abonnement order-driven : créé/upgradé ICI, au
          // moment UNIQUE de la confirmation (aucun droit avant).
          const active = await tx.subscription.findFirst({
            where: { userId, status: SubscriptionStatus.ACTIVE },
            orderBy: { createdAt: 'desc' },
          });
          if (active) {
            if (isHostingC3Enabled()) {
              throw new ConflictException(
                'Abonnement actif existant : upgrade non pris en charge en C3 (contactez le support).',
              );
            }
            await tx.subscription.update({
              where: { id: active.id },
              data: { productId: order.productId, orderId: order.id },
            });
            subscriptionAction = 'upgraded';
          } else {
            await tx.subscription.create({
              data: {
                userId,
                productId: order.productId,
                status: SubscriptionStatus.ACTIVE,
                orderId: order.id,
              },
            });
            subscriptionAction = 'created';
          }
        }

        // C3 (ON) — intention figée + service acheté : écrits ICI, dans la MÊME
        // transaction que la confirmation (un échec annule tout : jamais d'Order
        // confirmée sans tracking, jamais de service sans commande confirmée).
        if (isHostingC3Enabled() && order.packId && userId && !isRenewal) {
          const catalog = await this.loadC3Catalog(order.productId);
          if (!catalog?.pack) {
            throw new ConflictException('Pack produit introuvable (C3).');
          }
          const intent = this.buildC3Intent(
            {
              id: order.productId,
              packId: order.packId,
              billingCycle: order.billingCycle,
            },
            order,
            catalog,
          );
          await tx.orderProvisioningTracking.create({
            data: { orderId: order.id, intent: intent as unknown as Prisma.InputJsonValue },
          });
          const snapshots = snapshotsFromPack(catalog.pack, { name: order.productName });
          await tx.hostingService.create({
            data: {
              userId,
              orderId: order.id,
              productId: order.productId,
              packId: order.packId,
              deploymentModuleId: catalog.pack.deploymentModuleId ?? null,
              status: HostingServiceStatus.PROVISIONING,
              maxAppsSnapshot: snapshots.maxAppsSnapshot,
              ramMbSnapshot: snapshots.ramMbSnapshot,
              cpuCoresSnapshot: snapshots.cpuCoresSnapshot,
              storageLimitGbSnapshot: snapshots.storageLimitGbSnapshot,
              packNameSnapshot: snapshots.packNameSnapshot,
              productNameSnapshot: snapshots.productNameSnapshot,
            },
          });
        }

        return { alreadyConfirmed: false, order, subscriptionAction, userId, renewal: isRenewal };
      });
    } catch (e) {
      await this.audit
        .record({
          action: 'payment.confirm_failed',
          resourceType: 'order',
          resourceId: orderId,
          details: { source: ctx.source, error: String(e) },
        })
        .catch(() => {});
      throw e;
    }

    if (outcome.alreadyConfirmed) {
      return {
        orderId,
        status: outcome.order.status,
        alreadyConfirmed: true,
        subscriptionAction: null,
      };
    }

    // P9 (E1/M-05) : l'acteur remonte au niveau de l'enregistrement (actorId =
    // admin déclencheur, sinon propriétaire du compte) et l'audit porte la
    // transition d'état (from → to) dans ses détails.
    const confirmedTo = outcome.renewal ? OrderStatus.ACTIVE : OrderStatus.PAID;
    await this.audit.record({
      actorId: ctx.actorId ?? outcome.userId,
      actorEmail: ctx.actorEmail ?? outcome.order.customerEmail,
      action: 'payment.confirmed',
      resourceType: 'order',
      resourceId: orderId,
      details: {
        source: ctx.source,
        reference: ctx.reference ?? undefined,
        actorEmail: ctx.actorEmail ?? undefined,
        amountTtcCents: outcome.order.amountTtcCents,
        subscriptionAction: outcome.subscriptionAction,
        from: OrderStatus.PENDING_PAYMENT,
        to: confirmedTo,
        ...(outcome.renewal ? { renewal: true } : {}),
      },
    });
    // P9 (E1/M-05) — LA transition de bascule (PENDING_PAYMENT → PAID/ACTIVE)
    // journalisée dans l'AuditLog, avec l'acteur (meilleur effort).
    await this.audit.record({
      actorId: ctx.actorId ?? outcome.userId,
      actorEmail: ctx.actorEmail ?? outcome.order.customerEmail,
      action: 'order.transition',
      resourceType: 'order',
      resourceId: orderId,
      details: { from: OrderStatus.PENDING_PAYMENT, to: confirmedTo, source: ctx.source },
    });

    // Email de confirmation — best-effort (la source `free` le gère côté
    // checkout avec le mot de passe temporaire de l'invité).
    if (ctx.source !== 'free') {
      await this.sendPostCheckoutEmail(
        outcome.order.customerEmail,
        outcome.order.customerName,
        null,
        await this.invoiceNumberFor(orderId),
        outcome.subscriptionAction,
        { phase: 'confirmed', renewal: outcome.renewal },
      ).catch((e) =>
        this.traceAudit('', orderId, outcome.order.amountTtcCents, '', false, String(e), {
          stage: 'confirmed-email',
        }, { id: outcome.userId, email: ctx.actorEmail ?? outcome.order.customerEmail }),
      );
    }

    // Lancement de l'exécution APRÈS commit (provisioning only once PAID) :
    // fire-and-forget, échec JAMAIS avalé (audit + relance par le sweep).
    if (outcome.subscriptionAction === 'upgraded') {
      const active = await this.prisma.subscription.findFirst({
        where: { orderId, status: SubscriptionStatus.ACTIVE },
        select: { id: true },
      });
      if (active) {
        this.provisioning.syncAppLimits(active.id).catch((e) => {
          this.log.warn(`confirm order=${orderId}: syncAppLimits launch failed: ${String(e)}`);
        });
      }
    }
    // P8 (D2) : JAMAIS de provisioning sur un renouvellement (le service
    // existe déjà ; la commande sert uniquement à la période de facturation).
    if (
      !outcome.renewal &&
      (outcome.order.requestedSubdomain ||
        outcome.subscriptionAction !== 'upgraded')
    ) {
      this.provisioning.provisionOrder(orderId).catch((e) => {
        this.log.warn(`confirm order=${orderId}: provisionOrder launch failed: ${String(e)}`);
        this.audit
          .record({
            action: 'provision.launch_failed',
            resourceType: 'order',
            resourceId: orderId,
            details: { error: String(e) },
          })
          .catch(() => {});
      });
    }

    return {
      orderId,
      status: outcome.renewal ? OrderStatus.ACTIVE : OrderStatus.PAID,
      alreadyConfirmed: false,
      subscriptionAction: outcome.subscriptionAction,
    };
  }

  /**
   * Simulateur de paiement (RECETTE/TESTS uniquement — refus explicite en
   * production et sans activation `PAYMENT_SIMULATOR_ENABLED=true`, cf.
   * `config/payment-simulator.ts`). Aucun prestataire réel n'est appelé :
   * - `success` → confirmation serveur complète (mêmes droits qu'un règlement) ;
   * - `decline` → refus honnête, commande TOUTE CELLE qui reste en attente ;
   * - `timeout` → résultat INCERTAIN : protections C4 conservées, AUCUN droit
   *   ouvert, AUCUNE annonce de succès.
   */
  async simulatePaymentOutcome(
    orderId: string,
    outcome: 'success' | 'decline' | 'timeout',
  ): Promise<{ status: OrderStatus; outcome: string }> {
    if (!isPaymentSimulatorEnabled()) {
      throw new BadRequestException(
        'Simulateur de paiement désactivé (réservé aux tests et à la recette).',
      );
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { paymentMethod: { select: { type: true } } },
    });
    if (!order) {
      throw new NotFoundException('Commande introuvable.');
    }
    if (order.paymentMethod?.type !== PaymentMethodType.CARD) {
      throw new BadRequestException(
        'Le simulateur ne s’applique qu’à une commande CARTe en attente de règlement.',
      );
    }
    if (outcome === 'success') {
      const res = await this.confirmOrderPaid(orderId, { source: 'card-simulator' });
      return { status: res.status, outcome: res.alreadyConfirmed ? 'already-confirmed' : 'confirmed' };
    }

    const note =
      outcome === 'decline'
        ? 'Paiement refusé (simulateur) — commande toujours en attente de règlement.'
        : 'Délai dépassé (simulateur) — résultat incertain, protections conservées : aucun droit ouvert.';
    // CAS sous verrou (touch) : si la commande a basculé entre-temps (confirm
    // concurrent), on retourne l'état réel sans écrire un historique faux.
    const cas = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { updatedAt: new Date() },
    });
    if (cas.count === 0) {
      const cur = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      return { status: cur?.status ?? order.status, outcome: 'state-changed' };
    }
    await this.prisma.orderStatusHistory.create({
      data: { orderId, status: OrderStatus.PENDING_PAYMENT, note, actorEmail: null },
    });
    await this.audit.record({
      action: `payment.simulate_${outcome}`,
      resourceType: 'order',
      resourceId: orderId,
      details: { amountTtcCents: order.amountTtcCents },
    });
    return { status: OrderStatus.PENDING_PAYMENT, outcome };
  }

  /** Note d'historique de la confirmation (source + référence, traçable). */
  private confirmNote(ctx: ConfirmPaidContext): string {
    switch (ctx.source) {
      case 'free':
        return 'Commande gratuite (montant 0) — règle explicite, aucun encaissement fabriqué.';
      case 'admin-transfer':
        return `Règlement validé par l’administration${ctx.reference ? ` (réf. ${ctx.reference})` : ''}.`;
      case 'card-simulator':
        return 'Règlement confirmé (simulateur de recette — aucun prestataire réel).';
      case 'wallet':
        return 'Prélevé sur le solde du portefeuille (renouvellement d\'abonnement - P8).';
    }
  }

  /** Numéro de facture de la commande (email de confirmation). */
  private async invoiceNumberFor(orderId: string): Promise<string> {
    const inv = await this.prisma.invoice.findUnique({
      where: { orderId },
      select: { number: true },
    });
    return inv?.number ?? '';
  }

  /**
   * Prix actif d'un produit — RÈGLE PROMO UNIQUE (décision §6-2a, GO P5) :
   * la promo n'est facturée QUE si elle existe, est ≥ 0 et strictement
   * inférieure au prix catalogue ; sinon prix catalogue. Une seule source de
   * vérité, partagée par le devis, le checkout, l'Order et l'Invoice.
   */
  private static activeBasePrice(
    product: Pick<PublicProduct, 'priceHtCents' | 'promoPriceHtCents'>,
  ): number {
    const listPrice = product.priceHtCents ?? 0;
    const promo = product.promoPriceHtCents;
    if (
      promo !== null &&
      promo !== undefined &&
      promo >= 0 &&
      promo < listPrice
    ) {
      return promo;
    }
    return listPrice;
  }

  /**
   * POST /store/quote — re-fetch des prix du panier (B2) : recharge la
   * configuration vendable et recalcule EXACTEMENT les mêmes lignes/totaux que
   * le checkout (mème `buildPricing`), sans aucune écriture et sans jamais
   * recevoir de montant du client. C'est la référence affichée au panier :
   * prix affiché = prix débité, zéro écart client/serveur.
   */
  async quote(dto: QuoteDto): Promise<{
    lines: InvoiceLineInput[];
    amountHtCents: number;
    taxAmountCents: number;
    amountTtcCents: number;
    taxRatePercent: number;
    product: {
      name: string;
      priceHtCents: number;
      promoPriceHtCents: number | null;
      activePriceHtCents: number;
    };
  }> {
    const product = await this.products.findPublicBySlug(dto.productSlug);
    const pricing = this.buildPricing(product, dto);
    return {
      ...pricing,
      product: {
        name: product.name,
        priceHtCents: product.priceHtCents ?? 0,
        promoPriceHtCents: product.promoPriceHtCents ?? null,
        activePriceHtCents: CheckoutService.activeBasePrice(product),
      },
    };
  }

  /**
   * Construit les lignes de facture + les totaux (HT / taxe / TTC). La taxe est
   * arrondie PAR LIGNE (produit, options, suppléments) — arrondi serveur
   * UNIQUE (B2) ; le prix d'installation n'est jamais taxé. Order et Invoice
   * dérivent des mêmes totaux (cohérence), et le devis `quote()` utilise
   * EXACTEMENT cette fonction : prix affiché = prix débité, zéro écart client.
   *
   * Règle promo (décision §6-2a, GO P5) : le prix actif du produit est le prix
   * promo quand celui-ci existe et est strictement inférieur au prix catalogue
   * (un promo ≥ catalogue est ignoré — jamais de prix facturé supérieur au
   * prix affiché).
   */
  private buildPricing(
    product: PublicProduct,
    dto: Pick<CheckoutDto, 'options' | 'addonIds'>,
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

    const base = CheckoutService.activeBasePrice(product);
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

  /**
   * 17B.4F-C3 — catalogue C3 du produit (lecture dédiée sous ON) : pack,
   * méthode de provisioning et params d'environnement. `PublicProduct` ne les
   * expose pas tous (packId/provisionModuleId/moduleParams), d'où cette requête
   * ciblée. Jamais appelée sous OFF.
   */
  private async loadC3Catalog(productId: string): Promise<C3CatalogProduct | null> {
    return this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        packId: true,
        provisionModuleId: true,
        moduleParams: true,
        provisionModule: { select: { actions: true } },
        pack: {
          select: {
            id: true,
            name: true,
            ramMb: true,
            cpuCores: true,
            storageLimit: true,
            maxApps: true,
            status: true,
            deploymentModuleId: true,
          },
        },
      },
    });
  }

  /**
   * 17B.4F-C3 — intention de provisioning FIGÉE au checkout (fige le contrat
   * d'achat + l'environnement demandé, valeurs primitives uniquement : le
   * `claimToken`/lease sont ajoutés au runtime, jamais figés ici).
   */
  private buildC3Intent(
    product: Pick<PublicProduct, 'id' | 'packId' | 'billingCycle'>,
    order: {
      id: string;
      amountTtcCents: number;
      currency: string;
      requestedSubdomain: string | null;
      requestedDomainId: string | null;
    },
    c3Product: C3CatalogProduct,
  ): ReservationPayload {
    const params = (c3Product.moduleParams ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v : null;
    return {
      business: {
        productId: product.id,
        packId: product.packId ?? null,
        provisionModuleId: c3Product.provisionModuleId,
        billingCycle: String(product.billingCycle),
        currency: order.currency,
        amountTtcCents: order.amountTtcCents,
        requestedSubdomain: order.requestedSubdomain,
        requestedDomainId: order.requestedDomainId,
      },
      environment: {
        repoUrl: str(params.repoUrl),
        branch: str(params.branch),
        buildPack: str(params.buildPack),
        appName: str(params.appName),
        publishDirectory: str(params.publishDirectory),
        isStatic: typeof params.isStatic === 'boolean' ? params.isStatic : null,
      },
    };
  }

  /** Hash déterministe : adresse de facturation + slug + options + addons + moyen +
   *  montant TTC + SOUS-DOMAINE demandé (normalisé).
   *  Le sous-domaine fait partie de la configuration livrée : l'omettre faisait que
   *  re-commander le MÊME produit avec un sous-domaine DIFFÉRENT (même montant/options)
   *  produisait la MÊME clé → replay de l'ancienne commande, sans jamais provisionner la
   *  nouvelle app. Deux sous-domaines = deux commandes distinctes. */
  private idempotencyKey(
    dto: CheckoutDto,
    methodId: string,
    amountTtcCents: number,
    billingEmail: string,
    subdomain: string | null,
    requestedDomainId?: string | null,
  ): string {
    const options = [...(dto.options ?? [])]
      .map((o) => `${o.optionId}:${o.choiceId}`)
      .sort()
      .join(',');
    const addons = [...(dto.addonIds ?? [])].sort().join(',');
    const payload = [
      billingEmail,
      dto.productSlug,
      options,
      addons,
      methodId,
      amountTtcCents,
      subdomain ?? '',
      requestedDomainId ?? '',
    ].join('|');
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Réserve atomiquement le prochain numéro de facture « YYYY-<seq> » (row lock).
   * P7 (R-FAC-01) : singleton sûr sous concurrence — création **idempotente**
   * `INSERT … ON CONFLICT ("id") DO NOTHING` (jamais d'erreur P2002 : la
   * transaction reste valide, contrairement à create+catch qui laisserait une
   * tx Postgres avortée → 25P02), puis relecture ; deux checkouts simultanés
   * ne peuvent créer qu'UNE ligne, la PK `billing-settings` tranche. Lignes
   * legacy (cuid) gardées telles quelles, toujours lues dans l'ordre
   * `createdAt`. Retourne aussi la ligne figée (mentions/entreprise/échéance)
   * pour le snapshot de la facture.
   */
  private async claimInvoiceSequence(
    tx: Prisma.TransactionClient,
  ): Promise<{
    currency: string;
    invoiceNumber: string;
    billing: BillingSetting;
  }> {
    // P8 : implémentation partagée avec RenewalService (renouvellements D2) —
    // un SEUL chemin d'acquisition de numéro pour tout le dépôt.
    return claimInvoiceSequence(tx);
  }

  /** Audit des étapes paiement/commande (jamais le mot de passe en clair).
   *  P9 (E1/M-05) : `payment.checkout` porte MAINTENANT l'acteur (id +
   *  email) — créateur de compte pour un achat, propriétaire du compte pour
   *  une confirmation. */
  private async traceAudit(
    productId: string,
    orderId: string,
    amountTtcCents: number,
    methodId: string,
    ok: boolean,
    error?: string,
    extra?: Record<string, unknown>,
    actor?: { id?: string | null; email?: string | null },
  ): Promise<void> {
    await this.audit.record({
      action: ok ? 'payment.checkout' : 'payment.checkout.error',
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      resourceType: 'order',
      resourceId: orderId,
      details: {
        productId,
        amountTtcCents,
        methodId,
        ok,
        error: error ?? undefined,
        ...(extra ?? {}),
      },
    });
  }

  /**
   * Email de commande — best-effort, jamais bloquant. DEUX phases honnêtes :
   * - `pending` : commande enregistrée, règlement NON confirmé — AUCUNE
   *   promesse d'activation ni d'accès ; l'invité reçoit ses identifiants
   *   (le compte existe, il ne vaut pas confirmation).
   * - `confirmed` : règlement confirmé, exécution lancée (promesses réelles).
   */
  private async sendPostCheckoutEmail(
    to: string,
    name: string,
    tempPassword: string | null,
    invoiceNumber: string,
    subscriptionAction: 'upgraded' | 'created' | null,
    opts?: { phase?: 'pending' | 'confirmed'; methodLabel?: string; renewal?: boolean },
  ): Promise<void> {
    const phase = opts?.phase ?? 'confirmed';
    const isUpgrade = subscriptionAction === 'upgraded';
    const isNewAccount = !!tempPassword;
    const lines: string[] = [
      `Bonjour ${name},`,
      '',
    ];
    if (phase === 'pending') {
      lines.push(
        `Votre commande est enregistrée (facture ${invoiceNumber}). Le règlement`,
        'n’est pas encore confirmé : votre abonnement sera activé et votre',
        'application préparée dès que le règlement sera validé.',
        '',
      );
      if (opts?.methodLabel) {
        lines.push(`Moyen de paiement choisi : ${opts.methodLabel}.`, '');
      }
    } else if (opts?.renewal) {
      // P8 (D2) : renouvellement — AUCUNE promesse de « nouvelle app » : le
      // service existant continue, seule la période de facturation avance.
      lines.push(
        `Votre abonnement est renouvelé (facture ${invoiceNumber}). Votre`,
        'application et vos données restent inchangées ; la facture de la',
        'nouvelle période est disponible dans votre espace client.',
        '',
      );
    } else if (isUpgrade) {
      lines.push(
        `Votre règlement est confirmé : votre abonnement a été mis à jour (facture ${invoiceNumber}).`,
        'Vos données et votre/vos application(s) sont conservées, et les ressources',
        'de votre nouveau plan ont été appliquées.',
        '',
      );
    } else {
      lines.push(
        `Votre règlement est confirmé (facture ${invoiceNumber}). Votre`,
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
    } else if (phase === 'confirmed') {
      lines.push(
        'Retrouvez votre abonnement, vos applications et vos factures dans l’espace client.',
        '',
      );
    }
    lines.push('L’équipe Code Diali');
    await this.mail.sendPlain({
      to,
      subject:
        phase === 'pending'
          ? `Commande en attente de règlement — ${invoiceNumber}`
          : isUpgrade
            ? `Votre abonnement a été mis à jour — commande ${invoiceNumber}`
            : `Vos accès Code Diali — commande ${invoiceNumber}`,
      text: lines.join('\n'),
    });
  }

  /**
   * Phase 4 — Résout SOUS-DOMAINE + DOMAINE RACINE choisis au checkout. Aucun
   * fallback arbitraire (`allowedDomainIds[0]`, premier ACTIVE…). Produits sans
   * FreeSubdomainRule → rien. Sinon :
   *  - éligibles = racines ACTIVE restreintes par `allowedDomainIds` (si non vide) ;
   *  - 0 éligible → erreur ; >1 éligible SANS choix → ambiguïté (#10) ; 1 → unique ;
   *  - `requestedDomainId` fourni → doit être éligible (sinon rejet, #7/#13) ;
   *  - la dispo du sous-domaine est vérifiée sous la racine effectivement retenue.
   * Retourne la paire { requestedSubdomain, requestedDomainId } à persister.
   * `effectiveDomainId` (racine figée au provisioning) reste null ici.
   */
  private async resolveSubdomainAndRoot(
    product: PublicProduct,
    dto: CheckoutDto,
  ): Promise<{ requestedSubdomain: string | null; requestedDomainId: string | null }> {
    const rule = product.freeSubdomainRule;
    if (!rule) return { requestedSubdomain: null, requestedDomainId: null };

    const eligible = await this.prisma.domain.findMany({
      where: {
        status: 'ACTIVE',
        ...(rule.allowedDomainIds && rule.allowedDomainIds.length > 0
          ? { id: { in: rule.allowedDomainIds } }
          : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }],
    });
    if (eligible.length === 0) {
      throw new BadRequestException('Aucun domaine racine disponible.');
    }

    let requestedDomainId: string | null = null;
    let root: { id: string; name: string };
    if (dto.requestedDomainId) {
      const chosen = eligible.find((d) => d.id === dto.requestedDomainId);
      if (!chosen) {
        throw new BadRequestException(
          'Le domaine racine choisi n’est pas disponible pour ce produit.',
        );
      }
      root = chosen;
      requestedDomainId = chosen.id;
    } else {
      // Défaut (aucun choix) : le défaut PLATEFORME (rootDomainId, #1/#5) s'il est
      // éligible, sinon l'unique éligible ; >1 sans défaut plateforme → ambiguïté
      // (#10). `requestedDomainId` reste null → le provisioning re-résout la racine
      // (effective → requested → défaut). Coherent avec CloudflareService.resolveEffectiveRoot.
      const platformDefault = await this.platformDefaultEligible(eligible);
      if (platformDefault) {
        root = platformDefault;
      } else if (eligible.length > 1) {
        throw new BadRequestException(
          'Ce produit propose plusieurs domaines : veuillez choisir votre domaine racine.',
        );
      } else {
        root = eligible[0]!; // unique éligible (len 0 rejeté plus haut)
      }
    }

    const requestedSubdomain = await this.resolveRequestedSubdomainUnder(
      rule,
      dto.subdomain,
      root,
    );
    return { requestedSubdomain, requestedDomainId };
  }

  /**
   * Récupère la racine éligible du défaut PLATEFORME (CloudflareSetting.rootDomainId)
   * parmi la liste éligible, si elle y figure (ACTIVE + autorisée, donc éligible).
   * Retourne null si le défaut plateforme n'existe pas ou n'est pas éligible — même
   * logique que CloudflareService.resolveEffectiveRoot (#1/#5/#10).
   */
  private async platformDefaultEligible(
    eligible: { id: string; name: string }[],
  ): Promise<{ id: string; name: string } | null> {
    if (!eligible.length) return null;
    const settings = await this.prisma.cloudflareSetting.findFirst();
    if (!settings?.rootDomainId) return null;
    return eligible.find((d) => d.id === settings.rootDomainId) ?? null;
  }

  /**
   * Sous-domaine choisi au checkout : normalisé, dispo vérifiée en fail-fast SOUS
   * la racine `root` retenue (choix client ou unique éligible). Retourne null si
   * absent/non applicable → le provisioning auto-génère un sous-domaine (Bloc E).
   */
  private async resolveRequestedSubdomainUnder(
    rule: { minLength?: number; maxLength?: number; rejectPattern?: string | null },
    subdomain: string | undefined,
    root: { id: string; name: string },
  ): Promise<string | null> {
    const raw = subdomain?.trim();
    if (!raw) return null;
    const sub = raw.toLowerCase();
    if (sub.length < (rule.minLength ?? 3) || sub.length > (rule.maxLength ?? 40)) {
      throw new BadRequestException(
        `Sous-domaine invalide (longueur ${rule.minLength ?? 3}-${rule.maxLength ?? 40} caractères).`,
      );
    }
    if (rule.rejectPattern && regexFromRejectPattern(rule.rejectPattern)?.test(sub)) {
      throw new BadRequestException(`Sous-domaine « ${sub} » non autorisé.`);
    }
    const res = await this.cloudflare.checkSubdomainAvailability(sub, root.id);
    if (!res.available) {
      throw new BadRequestException(`Sous-domaine déjà pris : ${res.fqdn}`);
    }
    return sub;
  }
}
