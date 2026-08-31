import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Server } from '@prisma/client';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';

@Injectable()
export class ServersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateServerDto): Promise<Server> {
    return this.prisma.server.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        status: dto.status,
      },
    });
  }

  async findAll(): Promise<Server[]> {
    return this.prisma.server.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<Server> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) {
      throw new NotFoundException('Server not found');
    }
    return server;
  }

  async update(id: string, dto: UpdateServerDto): Promise<Server> {
    await this.findOne(id);
    return this.prisma.server.update({ where: { id }, data: dto });
  }

  async remove(id: string): Promise<Server> {
    await this.findOne(id);
    return this.prisma.server.delete({ where: { id } });
  }
}