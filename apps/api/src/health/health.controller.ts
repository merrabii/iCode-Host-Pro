import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unreachable';
  timestamp: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns application + database connectivity status.
   *  Database reachability is proven with a real raw query (SELECT 1),
   *  no artificial model/table is involved (ADR-014).
   */
  @Get()
  @ApiOperation({ summary: 'Application and database connectivity status' })
  async check(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        database: 'ok',
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'degraded',
        database: 'unreachable',
        timestamp: new Date().toISOString(),
      };
    }
  }
}