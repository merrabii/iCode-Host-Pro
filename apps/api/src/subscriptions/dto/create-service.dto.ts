import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

// Phase 5 (ADR-021): a client requests a Service under one of their ACTIVE
// subscriptions. No serverId here — the ADMIN assigns the host (the client
// never touches infrastructure).
export class CreateServiceDto {
  @ApiProperty({ example: 'Mon site vitrine' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Own ACTIVE subscription id' })
  @IsString()
  subscriptionId!: string;
}
