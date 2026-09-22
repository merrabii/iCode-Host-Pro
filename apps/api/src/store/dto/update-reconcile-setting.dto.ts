import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

// 17B.4C1 — overrides admin du réconciliateur. PATCH semantics : absent =
// inchangé ; `null` = supprime l'override et revient au fallback env/défaut.
// Mêmes bornes que le moteur (reconcile-settings.ts) — double protection, une
// ligne DB corrompue retombe toujours sur un fallback sûr. Aucune valeur
// secrète. Modifier `enabled` ne démarre AUCUN worker (17B.4C2).
export class UpdateReconcileSettingDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;

  /** Intervalle de scan (10 000..900 000 ms, défaut 30 000). */
  @IsOptional()
  @IsInt()
  @Min(10_000)
  @Max(900_000)
  scanIntervalMs?: number | null;

  /** Taille du batch (1..100, défaut 10). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  batchSize?: number | null;

  /** Durée du lease/claim (30 000..1 800 000 ms, défaut 120 000). */
  @IsOptional()
  @IsInt()
  @Min(30_000)
  @Max(1_800_000)
  leaseMs?: number | null;

  /** Seuil d'alerte des tentatives (1..100, défaut 12). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  attemptAlertThreshold?: number | null;

  /** Délai de backoff initial (10 000..1 800 000 ms, défaut 30 000). */
  @IsOptional()
  @IsInt()
  @Min(10_000)
  @Max(1_800_000)
  backoffInitialMs?: number | null;

  /** Délai de backoff maximal (60 000..86 400 000 ms, défaut 3 600 000). */
  @IsOptional()
  @IsInt()
  @Min(60_000)
  @Max(86_400_000)
  maxBackoffMs?: number | null;
}