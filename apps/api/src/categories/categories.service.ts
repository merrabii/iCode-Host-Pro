import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../users/users.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';

/** Vue d'une catégorie : pack recommandé (limites présentées à l'admin) + nb de
 *  produits qui la référencent. */
export type CategoryView = ProductCategory & {
  recommendedPack?: {
    id: string;
    name: string;
    ramMb: number;
    cpuCores: number;
    diskGb: number | null;
    bandwidth: string | null;
  } | null;
  _count?: { products: number };
};

const PACK_SELECT = {
  select: {
    id: true,
    name: true,
    ramMb: true,
    cpuCores: true,
    diskGb: true,
    bandwidth: true,
  },
};

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Normalise la saisie du pack recommandé : undefined = inchangé, '' = effacer,
   *  sinon un packId réel (vérifié). */
  private static toPackRef(value?: string): string | null | undefined {
    if (value === undefined) return undefined;
    return value.trim() === '' ? null : value.trim();
  }

  /** Vérifie que le pack recommandé existe (best-effort clair). */
  private async assertPackExists(packId?: string): Promise<void> {
    const ref = CategoriesService.toPackRef(packId);
    if (!ref) return;
    const pack = await this.prisma.hostingPack.findUnique({ where: { id: ref } });
    if (!pack) {
      throw new BadRequestException('Pack recommandé introuvable.');
    }
  }

  async create(dto: CreateCategoryDto, actor: Actor): Promise<CategoryView> {
    const ref = CategoriesService.toPackRef(dto.recommendedPackId);
    await this.assertPackExists(dto.recommendedPackId);
    const category = await this.prisma.productCategory.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        displayOrder: dto.displayOrder ?? 0,
        recommendedPackId: ref ?? null,
      },
      include: {
        recommendedPack: PACK_SELECT,
        _count: { select: { products: true } },
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'category.create',
      resourceType: 'product-category',
      resourceId: category.id,
      details: { name: category.name, recommendedPackId: category.recommendedPackId },
    });
    return category;
  }

  async findAll(): Promise<CategoryView[]> {
    return this.prisma.productCategory.findMany({
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      include: {
        recommendedPack: PACK_SELECT,
        _count: { select: { products: true } },
      },
    });
  }

  async findOne(id: string): Promise<CategoryView> {
    const category = await this.prisma.productCategory.findUnique({
      where: { id },
      include: {
        recommendedPack: PACK_SELECT,
        _count: { select: { products: true } },
      },
    });
    if (!category) {
      throw new NotFoundException('Catégorie introuvable.');
    }
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto, actor: Actor): Promise<CategoryView> {
    const before = await this.findOne(id);
    await this.assertPackExists(dto.recommendedPackId);
    const ref = CategoriesService.toPackRef(dto.recommendedPackId);
    const data: {
      name?: string;
      description?: string | null;
      displayOrder?: number;
      recommendedPackId?: string | null;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (dto.recommendedPackId !== undefined) data.recommendedPackId = ref ?? null;
    const category = await this.prisma.productCategory.update({
      where: { id },
      data,
      include: {
        recommendedPack: PACK_SELECT,
        _count: { select: { products: true } },
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'category.update',
      resourceType: 'product-category',
      resourceId: id,
      details: { from: before.name, to: category.name, recommendedPackId: category.recommendedPackId },
    });
    return category;
  }

  async remove(id: string, actor: Actor): Promise<CategoryView> {
    const before = await this.findOne(id);
    if (before._count?.products && before._count.products > 0) {
      throw new ConflictException(
        'Cette catégorie est référencée par des produits — dissociez-les avant de supprimer.',
      );
    }
    const category = await this.prisma.productCategory.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'category.delete',
      resourceType: 'product-category',
      resourceId: id,
      details: { name: before.name },
    });
    return category;
  }
}