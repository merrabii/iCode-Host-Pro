import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/** Réglages store par produit (contrôles du récap /cart) — PATCH admin. */
export class UpdateStoreSettingsDto {
  @IsOptional()
  @IsBoolean()
  allowEditConfig?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  installationFeeCents?: number;
}