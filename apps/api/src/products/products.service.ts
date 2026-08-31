import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Product } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Actor } from '../users/users.service';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateProductDto, actor: Actor): Promise<Product> {
    const product = await this.prisma.product.create({
      data: {
        name: dto.name,
        kind: dto.kind ?? 'generic',
        status: dto.status,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'product.create',
      resourceType: 'product',
      resourceId: product.id,
      details: { name: product.name, kind: product.kind, status: product.status },
    });
    return product;
  }

  async findAll(): Promise<Product[]> {
    return this.prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(id: string, dto: UpdateProductDto, actor: Actor): Promise<Product> {
    const before = await this.findOne(id);
    const product = await this.prisma.product.update({ where: { id }, data: dto });
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