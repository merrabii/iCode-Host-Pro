import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CheckoutIntentDto {
  @ApiProperty({ description: 'Product the visitor is about to order' })
  @IsString()
  productId!: string;
}