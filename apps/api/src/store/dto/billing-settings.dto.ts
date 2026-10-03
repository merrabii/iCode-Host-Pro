import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * GO P7 (lot D1) — paramètres d'édition de facture (ADMIN).
 * `legalMentions` = lignes de pied de facture figées à l'émission dans
 * `Invoice.legalMentionsSnapshot` ; `invoiceDueDays` alimente `dueDate`.
 * Champs vides (`''`) = effacement (→ null en base).
 */
export class UpdateBillingSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  companyAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyTaxId?: string;

  @IsOptional()
  @ValidateIf((o: UpdateBillingSettingsDto) => o.companyEmail !== '')
  @IsEmail()
  @MaxLength(320)
  companyEmail?: string;

  /** Lignes de pied de facture (10 max). `[]` = effacement. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  legalMentions?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  invoiceDueDays?: number;
}
