import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Product, ProductStatus, CheckoutFieldType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import {
  CreateCheckoutFieldDto,
  UpdateCheckoutFieldDto,
} from './dto/checkout-field.dto';
import { Actor } from '../users/users.service';

/** Références embarquées dans la vue produit : catégorie + pack (limites). */
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
    },
  },
};

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
} as const;

/** Type produit enrichi (valeur du PUBLIC_INCLUDE) renvoyé par le catalogue/fiche
 *  publics — expose options/choices, addons, taxRate, checkoutFields. */
export type PublicProduct =
  Prisma.ProductGetPayload<{ include: typeof PUBLIC_INCLUDE }>;

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

  async create(dto: CreateProductDto, actor: Actor): Promise<Product> {
    await this.assertRefs(dto.categoryId, dto.packId);
    const product = await this.prisma.product.create({
      data: {
        name: dto.name,
        kind: dto.kind ?? 'generic',
        status: dto.status,
        categoryId: dto.categoryId ?? null,
        packId: dto.packId ?? null,
      },
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
    return this.prisma.product.findMany({
      where: { status: ProductStatus.ACTIVE, hidden: false },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      include: PUBLIC_INCLUDE,
    });
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
    return product;
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
    const data: {
      name?: string;
      kind?: string;
      status?: ProductStatus;
      categoryId?: string | null;
      packId?: string | null;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.categoryId !== undefined) data.categoryId = dto.categoryId === '' ? null : dto.categoryId;
    if (dto.packId !== undefined) data.packId = dto.packId === '' ? null : dto.packId;
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
}