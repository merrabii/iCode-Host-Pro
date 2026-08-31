import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

// Phase 5 (ADR-021): a USER subscribes to a platform Product (client-owned).
export class CreateSubscriptionDto {
  @ApiProperty({ description: 'Product id to subscribe to' })
  @IsString()
  productId!: string;
}
