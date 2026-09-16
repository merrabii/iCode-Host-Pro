import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BillingCycle, Prisma, Product, ProductStatus, CheckoutFieldType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import {
  CreateCheckoutFieldDto,
  UpdateCheckoutFieldDto,
} from './dto/checkout-field.dto';
import {
  SetCategoriesDto,
  UpsertFreeSubdomainRuleDto,
  CreateOptionDto,
  UpdateOptionDto,
  CreateOptionChoiceDto,
  UpdateOptionChoiceDto,
  CreateAddonDto,
  UpdateAddonDto,
} from './dto/product-nested.dto';
import { Actor } from '../users/users.service';

/** Références embarquées dans la vue produit admin : catégorie + pack (limites)+
 *  store-front (onglets 1/2), options/addons/cat-links/règle domaine (onglets
 *  4/5/6/7/8). Additif : enrichit create/findAll/findOne/update sans casser le client. */
const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true } },
  pack: {
    select: {
      id: true,
      name: true,
      ramMb: true,
      cpuCores: true,
      storageLimit: true,
      bandwidth: true,
      status: true,
      maxApps: true,
      freeSubdomainsIncluded: true,
      // Onglet 3/5 — module de déploiement hérité du pack (A/B + serveur).
      deploymentModule: {
        select: { id: true, code: true, name: true, kind: true, server: { select: { id: true, hostname: true } } },
      },
    },
  },
  taxRate: { select: { id: true, name: true, ratePercent: true } },
  // Onglet 4 — catégories liées (multi), en plus de `category` (principale).
  categoryLinks: {
    select: { categoryId: true, category: { select: { id: true, name: true } } },
  },
  // Onglet 6 — options configurables + leurs choix.
  options: {
    orderBy: { sortOrder: 'asc' },
    include: { choices: { orderBy: { sortOrder: 'asc' } } },
  },
  // Onglet 7 — suppléments/add-ons.
  addons: { orderBy: { sortOrder: 'asc' } },
  // Onglet 8 — règle des sous-domaines gratuits du produit.
  freeSubdomainRule: true,
} as const;

/** Vue publique (catalogue) : pack sans le statut interne + configuration
 *  vendable (options à choix + add-ons) pour la fiche produit (Étape 2, ADR-07). */
const PUBLIC_INCLUDE = {
  category: { select: { id: true, name: true } },
  pack: {
    select: {
      id: true,
      name: true,
      ramMb: true,
      cpuCores: true,
      storageLimit: true,
      bandwidth: true,
    },
  },
  options: {
    orderBy: { sortOrder: 'asc' },
    include: { choices: { orderBy: { sortOrder: 'asc' } } },
  },
  addons: { orderBy: { sortOrder: 'asc' } },
  taxRate: { select: { id: true, name: true, ratePercent: true } },
  // Contrôles du récap /cart + champs de facturation éditables (admin).
  checkoutFields: {
    where: { enabled: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, key: true, label: true, type: true, placeholder: true, required: true },
  },
  // Présence = le produit exige un sous-domaine choisi au checkout (Plan Gratuit,
  // « Deploy my GitHub App »…) ; fournit contraintes + domaines autorisés.
  freeSubdomainRule: {
    select: {
      minLength: true,
      maxLength: true,
      allowedChars: true,
      reservedPrefixes: true,
      rejectPattern: true,
      allowedDomainIds: true,
    },
  },
} as const;

/** Type produit enrichi (valeur du PUBLIC_INCLUDE) renvoyé par le catalogue/fiche
 *  publics — expose options/choices, addons, taxRate, checkoutFields. */
export type PublicProduct =
  Prisma.ProductGetPayload<{ include: typeof PUBLIC_INCLUDE }> & {
    /** Phase 4 — racines éligibles {id, name} pour un produit à sous-domaine gratuit
     *  (résolues ACTIVE + restreintes par `allowedDomainIds`). Absent sinon. */
    freeDomains?: { id: string; name: string }[];
    /** Phase 4 — domaine racine INITIAL canonique pour le sélecteur store :
     *  CloudflareSetting.rootDomainId s'il est éligible, sinon l'unique éligible,
     *  sinon `null` (ambiguïté 2+ sans défaut plateforme, aucun éligible, ou produit
     *  sans sous-domaine gratuit). Jamais `freeDomains[0]` arbitraire. Toujours posé
     *  par `attachFreeDomains`. */
    initialDomainId: string | null;
  };

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Vérifie qu'une catégorie/pack référencé existe (best-effort clair). */
  private async assertRefs(categoryId?: string, packId?: string): Promise<void> {
    if (categoryId) {
      const cat = await this.prisma.productCategory.findUnique({ where: { id: categoryId } });
      if (!cat) throw new BadRequestException('Catégorie introuvable.');
    }
    if (packId) {
      const pack = await this.prisma.hostingPack.findUnique({ where: { id: packId } });
      if (!pack) throw new BadRequestException('Pack introuvable.');
    }
  }

  /** Le slug est @unique : refuse une collision (hors soi-même en édition). */
  private async assertSlugUnique(slug: string | null | undefined, exceptId?: string): Promise<void> {
    if (!slug) return;
    const found = await this.prisma.product.findFirst({
      where: { slug, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (found) throw new ConflictException(`Le slug « ${slug} » est déjà utilisé par un autre produit.`);
  }

  /** Normalise un champ texte nullable : null ou '' → null ; sinon trim. */
  private static nullable(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined; // non transmis = inchangé
    const t = typeof v === 'string' ? v.trim() : v;
    return t === '' ? null : t;
  }

  async create(dto: CreateProductDto, actor: Actor): Promise<Product> {
    await this.assertRefs(dto.categoryId, dto.packId);
    await this.assertSlugUnique(dto.slug);
    const data: Prisma.ProductUncheckedCreateInput = {
      name: dto.name,
      kind: dto.kind ?? 'generic',
      // Seulement les clés fournies : l'API de création produit est partielle
      // (les défauts du schéma — status/freePlan/hidden/displayOrder/crossSell… —
      // s'appliquent via Prisma quand absentes). Cohérent avec `update`.
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      categoryId: dto.categoryId ?? null,
      packId: dto.packId ?? null,
      ...(dto.slug !== undefined ? { slug: ProductsService.nullable(dto.slug) } : {}),
      ...(dto.slogan !== undefined ? { slogan: ProductsService.nullable(dto.slogan) } : {}),
      ...(dto.shortDescription !== undefined ? { shortDescription: ProductsService.nullable(dto.shortDescription) } : {}),
      ...(dto.freePlan !== undefined ? { freePlan: dto.freePlan } : {}),
      ...(dto.description !== undefined ? { description: ProductsService.nullable(dto.description) } : {}),
      ...(dto.color !== undefined ? { color: ProductsService.nullable(dto.color) } : {}),
      ...(dto.hidden !== undefined ? { hidden: dto.hidden } : {}),
      ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
      ...(dto.priceHtCents !== undefined ? { priceHtCents: dto.priceHtCents } : {}),
      ...(dto.promoPriceHtCents !== undefined ? { promoPriceHtCents: dto.promoPriceHtCents } : {}),
      ...(dto.billingCycle !== undefined ? { billingCycle: dto.billingCycle } : {}),
      ...(dto.taxRateId !== undefined ? { taxRateId: ProductsService.nullable(dto.taxRateId) } : {}),
      ...(dto.domainRequired !== undefined ? { domainRequired: dto.domainRequired } : {}),
      ...(dto.welcomeEmailTemplate !== undefined ? { welcomeEmailTemplate: ProductsService.nullable(dto.welcomeEmailTemplate) } : {}),
      ...(dto.stockEnabled !== undefined ? { stockEnabled: dto.stockEnabled } : {}),
      ...(dto.stockQty !== undefined ? { stockQty: dto.stockQty } : {}),
      ...(dto.crossSell !== undefined ? { crossSell: dto.crossSell } : {}),
    };
    const product = await this.prisma.product.create({
      data,
      include: PRODUCT_INCLUDE,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'product.create',
      resourceType: 'product',
      resourceId: product.id,
      details: {
        name: product.name,
        kind: product.kind,
        status: product.status,
        categoryId: product.categoryId,
        packId: product.packId,
      },
    });
    return product;
  }

  async findAll(): Promise<Product[]> {
    return this.prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      include: PRODUCT_INCLUDE,
    });
  }

  /** Public catalogue (no auth) — uniquement les produits commandables :
   *  status ACTIVE (jamais DRAFT/DISABLED/SUSPENDED) et non masqués (`hidden`).
   *  Triage : ordre d'affichage défini en admin, puis création. (Store, ADR-027.) */
  async findPublicCatalog(): Promise<PublicProduct[]> {
    const products = await this.prisma.product.findMany({
      where: { status: ProductStatus.ACTIVE, hidden: false },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      include: PUBLIC_INCLUDE,
    });
    return this.attachFreeDomains(products);
  }

  /** Public — fiche produit par slug (Étape 2). Ne sert QUE les produits
   *  commandables (ACTIVE, non masqués), comme le catalogue. `hidden` prime. */
  async findPublicBySlug(slug: string): Promise<PublicProduct> {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: ProductStatus.ACTIVE, hidden: false },
      include: PUBLIC_INCLUDE,
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    const [enriched] = await this.attachFreeDomains([product]);
    return enriched;
  }

  /** Phase 4 — Rattache aux produits à sous-domaine gratuit leur(s) racine(s)
   *  éligibles `{id, name}` (ACTIVE, restreinte par `allowedDomainIds` si posée ;
   *  [] = toutes ACTIVE) + la sélection initiale canonique `initialDomainId`
   *  (rootDomainId éligible → sinon unique éligible → sinon null). Le web checkout
   *  a besoin des NOMS de zones + du défaut pour le sélecteur de racine. Aligne le
   *  store sur `findMemberFreeDomains` et sur le résolveur canonique Phase 4. */
  private async attachFreeDomains(
    items: Array<Prisma.ProductGetPayload<{ include: typeof PUBLIC_INCLUDE }>>,
  ): Promise<PublicProduct[]> {
    if (!items.some((p) => !!p.freeSubdomainRule)) {
      // Aucun produit à sous-domaine gratuit : initialDomainId = null (rien
      // d'applicable), freeDomains absent (comportement public inchangé), aucune
      // requête domain.
      return items.map((p) => ({ ...p, initialDomainId: null }));
    }
    const [allActive, cfSettings] = await Promise.all([
      this.prisma.domain.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }],
      }),
      this.prisma.cloudflareSetting.findFirst({ select: { rootDomainId: true } }),
    ]);
    const rootDomainId = cfSettings?.rootDomainId ?? null;
    return items.map((p): PublicProduct => {
      if (!p.freeSubdomainRule) return { ...p, initialDomainId: null };
      const allowed = p.freeSubdomainRule.allowedDomainIds ?? [];
      const freeDomains =
        allowed.length > 0 ? allActive.filter((d) => allowed.includes(d.id)) : allActive;
      // Racine initiale canonique : défaut PLATEFORME (rootDomainId) s'il est
      // éligible, sinon l'unique éligible, sinon null (ambiguïté 2+ ou aucun).
      // Jamais freeDomains[0] arbitraire.
      let initialDomainId: string | null = null;
      if (rootDomainId && freeDomains.some((d) => d.id === rootDomainId)) {
        initialDomainId = rootDomainId;
      } else if (freeDomains.length === 1) {
        initialDomainId = freeDomains[0]!.id;
      }
      return { ...p, freeDomains, initialDomainId };
    });
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(id: string, dto: UpdateProductDto, actor: Actor): Promise<Product> {
    const before = await this.findOne(id);
    await this.assertRefs(dto.categoryId, dto.packId);
    await this.assertSlugUnique(dto.slug, id);
    const data: {
      name?: string;
      kind?: string;
      status?: ProductStatus;
      categoryId?: string | null;
      packId?: string | null;
      provisionModuleId?: string | null;
      moduleParams?: Prisma.InputJsonValue;
      // Bloc A — store-front (onglets 1 & 2), optionnels/rétro-compatibles.
      slug?: string | null;
      slogan?: string | null;
      shortDescription?: string | null;
      freePlan?: boolean;
      description?: string | null;
      color?: string | null;
      hidden?: boolean;
      displayOrder?: number;
      priceHtCents?: number | null;
      promoPriceHtCents?: number | null;
      billingCycle?: BillingCycle;
      taxRateId?: string | null;
      domainRequired?: boolean;
      welcomeEmailTemplate?: string | null;
      stockEnabled?: boolean;
      stockQty?: number | null;
      crossSell?: boolean;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.categoryId !== undefined) data.categoryId = dto.categoryId === '' ? null : dto.categoryId;
    if (dto.packId !== undefined) data.packId = dto.packId === '' ? null : dto.packId;
    // Bloc A — store-front : null/'' = effacer ; undefined = inchangé.
    if (dto.slug !== undefined) data.slug = ProductsService.nullable(dto.slug);
    if (dto.slogan !== undefined) data.slogan = ProductsService.nullable(dto.slogan);
    if (dto.shortDescription !== undefined) data.shortDescription = ProductsService.nullable(dto.shortDescription);
    if (dto.freePlan !== undefined) data.freePlan = dto.freePlan;
    if (dto.description !== undefined) data.description = ProductsService.nullable(dto.description);
    if (dto.color !== undefined) data.color = ProductsService.nullable(dto.color);
    if (dto.hidden !== undefined) data.hidden = dto.hidden;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (dto.priceHtCents !== undefined) data.priceHtCents = dto.priceHtCents ?? null;
    if (dto.promoPriceHtCents !== undefined) data.promoPriceHtCents = dto.promoPriceHtCents ?? null;
    if (dto.billingCycle !== undefined) data.billingCycle = dto.billingCycle;
    if (dto.taxRateId !== undefined) data.taxRateId = ProductsService.nullable(dto.taxRateId);
    if (dto.domainRequired !== undefined) data.domainRequired = dto.domainRequired;
    if (dto.welcomeEmailTemplate !== undefined) data.welcomeEmailTemplate = ProductsService.nullable(dto.welcomeEmailTemplate);
    if (dto.stockEnabled !== undefined) data.stockEnabled = dto.stockEnabled;
    if (dto.stockQty !== undefined) data.stockQty = dto.stockQty ?? null;
    if (dto.crossSell !== undefined) data.crossSell = dto.crossSell;
    // Déploiement par défaut (admin) : on MERGE les clés utiles sur moduleParams
    // existant (repoUrl/branch/buildPack/appName/publishDirectory/isStatic), on préserve
    // les autres ; '' → null/absent, et on re-câble une autre method de provisioning si
    // demandé ('' → null). NB : `isStatic` + `publishDirectory` étaient ABSENTS du merge
    // (bug : l'app static enregistrée par l'admin se « décochait » après re-fetch).
    if (dto.moduleParams !== undefined || dto.provisionModuleId !== undefined) {
      const current = (before.moduleParams as Record<string, unknown> | null) ?? {};
      if (dto.moduleParams !== undefined) {
        const patch = dto.moduleParams;
        const merged: Record<string, unknown> = { ...current };
        for (const key of ['repoUrl', 'branch', 'buildPack', 'appName', 'publishDirectory', 'isStatic'] as const) {
          const v = patch[key];
          if (v !== undefined) merged[key] = v === '' ? null : v;
        }
        data.moduleParams = merged as Prisma.InputJsonValue;
      }
      if (dto.provisionModuleId !== undefined) {
        data.provisionModuleId = dto.provisionModuleId === '' ? null : dto.provisionModuleId;
      }
    }
    const product = await this.prisma.product.update({
      where: { id },
      data,
      include: PRODUCT_INCLUDE,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'product.update',
      resourceType: 'product',
      resourceId: id,
      details: { from: before, to: product },
    });
    return product;
  }

  async remove(id: string, actor: Actor): Promise<Product> {
    const before = await this.findOne(id);
    // Un produit référencé par une souscription ne peut pas être supprimé
    // physiquement (violation de FK → 500 Prisma P2003) : l'admin doit passer
    // par le statut DISABLED pour le masquer du catalogue.
    const refs = await this.prisma.subscription.count({
      where: { productId: id },
    });
    if (refs > 0) {
      throw new ConflictException(
        'Ce produit est référencé par des souscriptions — passez-le en statut DISABLED pour le retirer du catalogue.',
      );
    }
    const product = await this.prisma.product.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'product.delete',
      resourceType: 'product',
      resourceId: id,
      details: { name: before.name },
    });
    return product;
  }

  // ── Réglages store par produit (admin) ─────────────────────────────
  /** Mise à jour des contrôles du récap /cart (bouton « Modifier », prix d'installation). */
  async updateStoreSettings(id: string, dto: UpdateStoreSettingsDto, actor: Actor) {
    await this.findOne(id);
    const data: { allowEditConfig?: boolean; installationFeeCents?: number } = {};
    if (dto.allowEditConfig !== undefined) data.allowEditConfig = dto.allowEditConfig;
    if (dto.installationFeeCents !== undefined) data.installationFeeCents = dto.installationFeeCents;
    const product = await this.prisma.product.update({ where: { id }, data, include: PRODUCT_INCLUDE });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.product.settings',
      resourceType: 'product',
      resourceId: id,
      details: data,
    });
    return product;
  }

  /** Champs de facturation d'un produit (tous, y compris désactivés, ordonnés). */
  async listCheckoutFields(id: string) {
    await this.findOne(id);
    return this.prisma.productCheckoutField.findMany({
      where: { productId: id },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createCheckoutField(productId: string, dto: CreateCheckoutFieldDto, actor: Actor) {
    await this.findOne(productId);
    const field = await this.prisma.productCheckoutField.create({
      data: {
        productId,
        key: dto.key,
        label: dto.label,
        type: dto.type ?? CheckoutFieldType.TEXT,
        placeholder: dto.placeholder ?? null,
        required: dto.required ?? false,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.checkoutfield.create',
      resourceType: 'product',
      resourceId: productId,
      details: { key: field.key },
    });
    return field;
  }

  async updateCheckoutField(fieldId: string, dto: UpdateCheckoutFieldDto, actor: Actor) {
    const field = await this.prisma.productCheckoutField.findUnique({ where: { id: fieldId } });
    if (!field) throw new NotFoundException('Checkout field not found');
    const data: Parameters<typeof this.prisma.productCheckoutField.update>[0]['data'] = {};
    if (dto.key !== undefined) data.key = dto.key;
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.placeholder !== undefined) data.placeholder = dto.placeholder ?? null;
    if (dto.required !== undefined) data.required = dto.required;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    const updated = await this.prisma.productCheckoutField.update({ where: { id: fieldId }, data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.checkoutfield.update',
      resourceType: 'product',
      resourceId: field.productId,
      details: { key: updated.key },
    });
    return updated;
  }

  async deleteCheckoutField(fieldId: string, actor: Actor) {
    const field = await this.prisma.productCheckoutField.findUnique({ where: { id: fieldId } });
    if (!field) throw new NotFoundException('Checkout field not found');
    await this.prisma.productCheckoutField.delete({ where: { id: fieldId } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.checkoutfield.delete',
      resourceType: 'product',
      resourceId: field.productId,
      details: { key: field.key },
    });
    return { ok: true };
  }

  /** Réordonne statiquement (sortOrder = index) — transaction sur le masque global. */
  async reorderCheckoutFields(productId: string, ids: string[], actor: Actor) {
    await this.findOne(productId);
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.productCheckoutField.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.checkoutfield.reorder',
      resourceType: 'product',
      resourceId: productId,
      details: { ids },
    });
    return this.listCheckoutFields(productId);
  }

  // ── Onglet 4 — catégories liées (multi, ProductCategoryLink) ────────────
  /** Liste les catégories liées (en plus de la catégorie principale). */
  async listCategoryLinks(id: string) {
    await this.findOne(id);
    return this.prisma.productCategoryLink.findMany({
      where: { productId: id },
      orderBy: { category: { name: 'asc' } },
      include: { category: { select: { id: true, name: true } } },
    });
  }

  /** Remplace l'ensemble des catégories liées du produit (transaction). */
  async setCategories(id: string, categoryIds: string[], actor: Actor) {
    await this.findOne(id);
    for (const cid of categoryIds) {
      const cat = await this.prisma.productCategory.findUnique({ where: { id: cid }, select: { id: true } });
      if (!cat) throw new BadRequestException('Catégorie introuvable.');
    }
    await this.prisma.$transaction([
      this.prisma.productCategoryLink.deleteMany({ where: { productId: id } }),
      this.prisma.productCategoryLink.createMany({
        data: categoryIds.map((categoryId) => ({ productId: id, categoryId })),
        skipDuplicates: true,
      }),
    ]);
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.categories.set',
      resourceType: 'product',
      resourceId: id,
      details: { categoryIds },
    });
    return this.listCategoryLinks(id);
  }

  /** Retire une catégorie liée. */
  async unlinkCategory(id: string, categoryId: string, actor: Actor) {
    await this.findOne(id);
    const where = { productId_categoryId: { productId: id, categoryId } };
    const link = await this.prisma.productCategoryLink.findUnique({ where });
    if (!link) throw new NotFoundException('Catégorie liée introuvable.');
    await this.prisma.productCategoryLink.delete({ where });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.category.unlink',
      resourceType: 'product',
      resourceId: id,
      details: { categoryId },
    });
    return { ok: true };
  }

  // ── Onglet 5/8 — règle des sous-domaines gratuits (1:1, upsert) ─────────
  async getFreeSubdomainRule(id: string) {
    await this.findOne(id);
    return this.prisma.freeSubdomainRule.findUnique({ where: { productId: id } });
  }

  async upsertFreeSubdomainRule(id: string, dto: UpsertFreeSubdomainRuleDto, actor: Actor) {
    await this.findOne(id);
    const data = {
      ...(dto.allowedDomainIds !== undefined ? { allowedDomainIds: dto.allowedDomainIds } : {}),
      ...(dto.reservedPrefixes !== undefined ? { reservedPrefixes: dto.reservedPrefixes } : {}),
      ...(dto.minLength !== undefined ? { minLength: dto.minLength } : {}),
      ...(dto.maxLength !== undefined ? { maxLength: dto.maxLength } : {}),
      ...(dto.allowedChars !== undefined ? { allowedChars: dto.allowedChars } : {}),
      ...(dto.rejectPattern !== undefined ? { rejectPattern: dto.rejectPattern ?? null } : {}),
    };
    const rule = await this.prisma.freeSubdomainRule.upsert({
      where: { productId: id },
      create: { productId: id, ...data },
      update: data,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.subdomain.rule.upsert',
      resourceType: 'product',
      resourceId: id,
      details: { allowedDomainIds: rule.allowedDomainIds, reservedPrefixes: rule.reservedPrefixes },
    });
    return rule;
  }

  async deleteFreeSubdomainRule(id: string, actor: Actor) {
    await this.findOne(id);
    const rule = await this.prisma.freeSubdomainRule.findUnique({ where: { productId: id } });
    if (!rule) throw new NotFoundException('Règle de sous-domaines absente pour ce produit.');
    await this.prisma.freeSubdomainRule.delete({ where: { productId: id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.subdomain.rule.delete',
      resourceType: 'product',
      resourceId: id,
      details: { cleared: true },
    });
    return { ok: true };
  }

  // ── Onglet 6 — options configurables + choix ───────────────────────────
  async listOptions(id: string) {
    await this.findOne(id);
    return this.prisma.productOption.findMany({
      where: { productId: id },
      orderBy: { sortOrder: 'asc' },
      include: { choices: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  async createOption(id: string, dto: CreateOptionDto, actor: Actor) {
    await this.findOne(id);
    const option = await this.prisma.productOption.create({
      data: {
        productId: id,
        name: dto.name,
        required: dto.required ?? false,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.option.create',
      resourceType: 'product',
      resourceId: id,
      details: { name: option.name },
    });
    return option;
  }

  async updateOption(optionId: string, dto: UpdateOptionDto, actor: Actor) {
    const option = await this.prisma.productOption.findUnique({ where: { id: optionId } });
    if (!option) throw new NotFoundException('Option introuvable.');
    const data: { name?: string; required?: boolean; sortOrder?: number } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.required !== undefined) data.required = dto.required;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    const updated = await this.prisma.productOption.update({ where: { id: optionId }, data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.option.update',
      resourceType: 'product',
      resourceId: option.productId,
      details: { name: updated.name },
    });
    return updated;
  }

  async deleteOption(optionId: string, actor: Actor) {
    const option = await this.prisma.productOption.findUnique({ where: { id: optionId } });
    if (!option) throw new NotFoundException('Option introuvable.');
    await this.prisma.productOption.delete({ where: { id: optionId } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.option.delete',
      resourceType: 'product',
      resourceId: option.productId,
      details: { name: option.name },
    });
    return { ok: true };
  }

  async reorderOptions(id: string, ids: string[], actor: Actor) {
    await this.findOne(id);
    const found = await this.prisma.productOption.findMany({
      where: { id: { in: ids }, productId: id },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('Certaines options n’appartiennent pas à ce produit.');
    }
    await this.prisma.$transaction(
      ids.map((optionId, index) =>
        this.prisma.productOption.update({ where: { id: optionId }, data: { sortOrder: index } }),
      ),
    );
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.option.reorder',
      resourceType: 'product',
      resourceId: id,
      details: { ids },
    });
    return this.listOptions(id);
  }

  async createChoice(optionId: string, dto: CreateOptionChoiceDto, actor: Actor) {
    const option = await this.prisma.productOption.findUnique({ where: { id: optionId } });
    if (!option) throw new NotFoundException('Option introuvable.');
    const choice = await this.prisma.productOptionChoice.create({
      data: {
        optionId,
        label: dto.label,
        priceDeltaHtCents: dto.priceDeltaHtCents,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.choice.create',
      resourceType: 'product',
      resourceId: option.productId,
      details: { optionId, label: choice.label },
    });
    return choice;
  }

  async updateChoice(choiceId: string, dto: UpdateOptionChoiceDto, actor: Actor) {
    const choice = await this.prisma.productOptionChoice.findUnique({
      where: { id: choiceId },
      include: { option: { select: { productId: true } } },
    });
    if (!choice) throw new NotFoundException('Choix introuvable.');
    const data: { label?: string; priceDeltaHtCents?: number; sortOrder?: number } = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.priceDeltaHtCents !== undefined) data.priceDeltaHtCents = dto.priceDeltaHtCents;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    const updated = await this.prisma.productOptionChoice.update({ where: { id: choiceId }, data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.choice.update',
      resourceType: 'product',
      resourceId: choice.option.productId,
      details: { choiceId, label: updated.label },
    });
    return updated;
  }

  async deleteChoice(choiceId: string, actor: Actor) {
    const choice = await this.prisma.productOptionChoice.findUnique({
      where: { id: choiceId },
      include: { option: { select: { productId: true } } },
    });
    if (!choice) throw new NotFoundException('Choix introuvable.');
    await this.prisma.productOptionChoice.delete({ where: { id: choiceId } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.choice.delete',
      resourceType: 'product',
      resourceId: choice.option.productId,
      details: { choiceId, label: choice.label },
    });
    return { ok: true };
  }

  async reorderChoices(optionId: string, ids: string[], actor: Actor) {
    const option = await this.prisma.productOption.findUnique({
      where: { id: optionId },
      select: { id: true, productId: true },
    });
    if (!option) throw new NotFoundException('Option introuvable.');
    const found = await this.prisma.productOptionChoice.findMany({
      where: { id: { in: ids }, optionId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('Certains choix n’appartiennent pas à cette option.');
    }
    await this.prisma.$transaction(
      ids.map((choiceId, index) =>
        this.prisma.productOptionChoice.update({ where: { id: choiceId }, data: { sortOrder: index } }),
      ),
    );
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.choice.reorder',
      resourceType: 'product',
      resourceId: option.productId,
      details: { optionId, ids },
    });
    return this.prisma.productOptionChoice.findMany({
      where: { optionId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  // ── Onglet 7 — suppléments / add-ons ────────────────────────────────────
  async listAddons(id: string) {
    await this.findOne(id);
    return this.prisma.productAddon.findMany({
      where: { productId: id },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createAddon(id: string, dto: CreateAddonDto, actor: Actor) {
    await this.findOne(id);
    const addon = await this.prisma.productAddon.create({
      data: {
        productId: id,
        name: dto.name,
        description: dto.description ?? null,
        priceHtCents: dto.priceHtCents,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.addon.create',
      resourceType: 'product',
      resourceId: id,
      details: { name: addon.name, priceHtCents: addon.priceHtCents },
    });
    return addon;
  }

  async updateAddon(addonId: string, dto: UpdateAddonDto, actor: Actor) {
    const addon = await this.prisma.productAddon.findUnique({ where: { id: addonId } });
    if (!addon) throw new NotFoundException('Add-on introuvable.');
    const data: {
      name?: string;
      description?: string | null;
      priceHtCents?: number;
      sortOrder?: number;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.priceHtCents !== undefined) data.priceHtCents = dto.priceHtCents;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    const updated = await this.prisma.productAddon.update({ where: { id: addonId }, data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.addon.update',
      resourceType: 'product',
      resourceId: addon.productId,
      details: { name: updated.name },
    });
    return updated;
  }

  async deleteAddon(addonId: string, actor: Actor) {
    const addon = await this.prisma.productAddon.findUnique({ where: { id: addonId } });
    if (!addon) throw new NotFoundException('Add-on introuvable.');
    await this.prisma.productAddon.delete({ where: { id: addonId } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.addon.delete',
      resourceType: 'product',
      resourceId: addon.productId,
      details: { name: addon.name },
    });
    return { ok: true };
  }

  async reorderAddons(id: string, ids: string[], actor: Actor) {
    await this.findOne(id);
    const found = await this.prisma.productAddon.findMany({
      where: { id: { in: ids }, productId: id },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('Certains add-ons n’appartiennent pas à ce produit.');
    }
    await this.prisma.$transaction(
      ids.map((addonId, index) =>
        this.prisma.productAddon.update({ where: { id: addonId }, data: { sortOrder: index } }),
      ),
    );
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'store.addon.reorder',
      resourceType: 'product',
      resourceId: id,
      details: { ids },
    });
    return this.listAddons(id);
  }

  // ── Onglet 3 — résumé provisioning + méthodes disponibles ───────────────
  /** Vue admin du provisioning d'un produit : module de déploiement A/B hérité
   *  du pack (lecture seule) + méthode de provisioning + paramètres. */
  async getProvisioning(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        moduleParams: true,
        provisionModule: {
          select: { id: true, name: true, code: true, description: true, endpoint: true, actions: true, isSystem: true },
        },
        pack: {
          select: {
            id: true,
            name: true,
            deploymentModule: {
              select: { id: true, code: true, name: true, kind: true, server: { select: { id: true, hostname: true } } },
            },
          },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return {
      deploymentModule: product.pack?.deploymentModule ?? null,
      provisionMethod: product.provisionModule,
      moduleParams: (product.moduleParams as Record<string, unknown> | null) ?? {},
    };
  }

  /** Méthodes de provisioning actives (registre, pour choisir à l’onglet 3). */
  async listActiveProvisionMethods() {
    return this.prisma.provisionMethod.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }
}