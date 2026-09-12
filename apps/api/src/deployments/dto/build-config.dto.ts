import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Prévisualisation / détection de la config de build d'un dépôt (Phase 16). */
export class BuildConfigPreviewDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[\w.-]+\/[\w.-]+$/, {
    message: 'Format attendu : owner/repo (dépôt GitHub).',
  })
  @MaxLength(200)
  repoFullName: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  branch?: string;
}