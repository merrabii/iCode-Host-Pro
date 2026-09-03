import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Phase 10bis.5 : détection automatique d'une URL de dépôt collée par le
// client (sans liaison GitHub). L'URL est assainie + contrôlée dans le service.
export class DetectRepoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  url!: string;
}
