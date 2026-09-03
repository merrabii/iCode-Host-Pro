import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  KnowledgeAudience,
  KnowledgeStatus,
  KnowledgeType,
} from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateKnowledgeArticleDto {
  @ApiProperty({ enum: KnowledgeAudience, example: KnowledgeAudience.ADMIN })
  @IsEnum(KnowledgeAudience)
  audience!: KnowledgeAudience;

  @ApiProperty({ enum: KnowledgeType, example: KnowledgeType.INFORMATIVE })
  @IsEnum(KnowledgeType)
  type!: KnowledgeType;

  @ApiProperty({ example: 'Phase 10 — Sécurité & comptes' })
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title!: string;

  @ApiPropertyOptional({ example: 'phase-10-securite-comptes' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug invalide : lettres minuscules, chiffres et tirets uniquement.',
  })
  slug?: string;

  @ApiPropertyOptional({ example: 'Récapitulatif de la refonte sécurité de l’authentification.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @ApiProperty({ example: '<p>Contenu <b>HTML</b> de l’article…</p>' })
  @IsString()
  @MinLength(3)
  body!: string;

  @ApiPropertyOptional({ example: 'Sécurité' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({ example: 'Phase 10' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phase?: string;

  @ApiPropertyOptional({ example: ['sécurité', 'mfa', 'oauth'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: KnowledgeStatus, default: KnowledgeStatus.DRAFT })
  @IsOptional()
  @IsEnum(KnowledgeStatus)
  status?: KnowledgeStatus;
}
