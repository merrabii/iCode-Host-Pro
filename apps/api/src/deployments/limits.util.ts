import { DeploymentModule, HostingPack } from '@prisma/client';
import { CoolifyAppLimits, cpusFromCores, memoryFromMb } from '../servers/panel-transport.factory';

/**
 * Phase 17 (3a/3c/3d) — limites EFFECTIVES d'une app d'un pack, avec primauté des
 * overrides du module de déploiement.
 *
 * OÙ vit la correspondance plan → limites (point 2 de l'audit) : `HostingPack`
 * (`schema.prisma`) porte `ramMb` (Mo) et `cpuCores` (fraction), valeurs **PAR APP**
 * — il n'existe PAS de budget total stocké. Le budget total d'un pack est DÉRIVÉ,
 * et compté **par pack** (jamais fusionné entre packs d'un même client) : voir
 * `assertUnderPackQuota` (deployments.service) et le monitoring per-pack.
 *
 * Primauté des overrides (point 2b) : un `DeploymentModule` lié au pack peut définir
 * `overrideRamMb`/`overrideCpuCores`/`overrideStorageLimit`, qui écrassent les
 * valeurs du pack (règle identique à l'ancienne `packLimits` de deployments.service).
 *
 * Note disque : `storageLimit`/`overrideStorageLimit` sont des valeurs ENREGISTRÉES
 * en Go, budget disque NON actif à ce jour (système de quota après mise en prod).
 */
export interface EffectiveLimits {
  ramMb: number;
  cpuCores: number;
  storageGb: number | null;
  /** Charge prête pour `PanelTransport.applyAppLimits` (CoolifyAppLimits). */
  limits: CoolifyAppLimits;
}

/**
 * Calcule les limites effectives d'un pack (+ overrides de module). Renvoie `null`
 * si aucun pack. Ne porte PAS le contrôle de statut ACTIVE (aux appelants de décider).
 */
export function resolveEffectiveLimits(
  pack: Pick<HostingPack, 'ramMb' | 'cpuCores' | 'storageLimit'> | null | undefined,
  module?: Pick<
    DeploymentModule,
    'overrideRamMb' | 'overrideCpuCores' | 'overrideStorageLimit'
  > | null,
): EffectiveLimits | null {
  if (!pack) return null;
  const ramMb = module?.overrideRamMb ?? pack.ramMb;
  const cpuCores = module?.overrideCpuCores ?? pack.cpuCores;
  const storageGb = module?.overrideStorageLimit ?? pack.storageLimit ?? null;
  const limits: CoolifyAppLimits = {};
  if (ramMb > 0) limits.memory = memoryFromMb(ramMb);
  if (cpuCores > 0) limits.cpus = cpusFromCores(cpuCores);
  return { ramMb, cpuCores, storageGb, limits };
}