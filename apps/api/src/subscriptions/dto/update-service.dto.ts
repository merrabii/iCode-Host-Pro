import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ServiceStatus } from '@prisma/client';

// Phase 5 (ADR-021): ADMIN-only. Assign a hosting Server and/or advance the
// status (REQUESTED → PROVISIONING → ACTIVE — provisioning is a stub, no real
// provider deploy). The client never sets serverId.
export class UpdateServiceDto {
  @ApiPropertyOptional({ enum: ServiceStatus })
  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;

  @ApiPropertyOptional({ description: 'An existing Server id to assign' })
  @IsOptional()
  @IsString()
  serverId?: string;
}
