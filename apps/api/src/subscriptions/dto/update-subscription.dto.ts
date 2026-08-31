import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SubscriptionStatus } from '@prisma/client';

// Phase 5 (ADR-021): ADMIN-only status transition on a Subscription. The valid
// source→target transitions are enforced in the service layer.
export class UpdateSubscriptionDto {
  @ApiProperty({ enum: SubscriptionStatus })
  @IsEnum(SubscriptionStatus)
  status!: SubscriptionStatus;
}
