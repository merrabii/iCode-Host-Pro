import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Product, ProductStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
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
      diskGb: true,
      bandwidth: true,
      status: true,
    },
  },
};

/** Vue publique (catalogue) : pack sans le statut interne. */
const PUBLIC_INCLUDE = {
  category: { select: { id: true, name: true } },
  pack: {
    select: {
      id: true,
      name: true,
      ramMb: true,
      cpuCores: true,
      diskGb: true,
      bandwidth: true,
    },
  },
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

  /** Public catalogue (no auth) — only orderable products (Phase 10, ADR-027). */
  async findPublicCatalog(): Promise<Product[]> {
    return this.prisma.product.findMany({
      where: { status: { notIn: [ProductStatus.DRAFT, ProductStatus.DISABLED] } },
      orderBy: { createdAt: 'desc' },
      include: PUBLIC_INCLUDE,
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
}