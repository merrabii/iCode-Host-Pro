import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentModuleKind, DeploymentStatus, PackStatus } from '@prisma/client';

export interface ProjectConsumption {
  /** Clé de ligne composite (un client avec plusieurs packs → plusieurs lignes). */
  id: string;
  clientName: string | null;
  clientEmail: string;
  projectUuid: string;
  packId: string | null;
  packName: string | null;
  moduleKind: DeploymentModuleKind | null;
  appsCount: number;
  totalRamMb: number;
  totalCpuCores: number;
  totalStorageGb: number | null;
  /** Budget du pack (quota dérivé) : limite effective par app × maxApps. null = illimité. */
  budgetRamMb: number | null;
  budgetCpuCores: number | null;
  budgetStorageGb: number | null;
  overRam: boolean;
  overCpu: boolean;
  overDisk: boolean;
  totalConsumption: number; // score pour tri desc : RAM(1) + CPU(1024) + Disk(1024*1024) approx
}

type PackAgg = {
  id: string;
  name: string;
  status: PackStatus;
  maxApps: number | null;
  ramMb: number;
  cpuCores: number;
  storageLimit: number | null;
  deploymentModule: {
    overrideRamMb: number | null;
    overrideCpuCores: number | null;
    overrideStorageLimit: number | null;
  } | null;
};

/**
 * Service de monitoring (Phase 13/17).
 * Agrégation OFFLINE des déploiements ACTIVE, groupée PAR (client, pack) — un client
 * avec plusieurs packs a donc plusieurs lignes/quotas SÉPARÉS, jamais fusionnés entre
 * packs (décision 3d). Les ressources allouées viennent des limites EFFECTIVES
 * enregistrées sur la Deployment (`limitsRamMb`/`limitsCpu`, override du module incluse),
 * avec repli sur le pack quand absente (lignes legacy). Le « budget » affiché = quota
 * dérivé du pack : limite effective par app × maxApps.
 */
@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService) {}

  async getProjectsConsumption(): Promise<ProjectConsumption[]> {
    const deployments = await this.prisma.deployment.findMany({
      where: { status: DeploymentStatus.ACTIVE, coolifyProjectUuid: { not: null } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        module: { include: { server: true } },
        clientProject: { include: { module: { include: { server: true } } } },
      },
    });

    // Packs référencés par les déploiements, avec les overrides de leur module
    // (pour le budget per-app). `select` limite la forme, indépendante du type
    // de relation complet du modèle (évite un couplage au type généré).
    const packIds = [...new Set(deployments.map((d) => d.packId).filter(Boolean))] as string[];
    const packs = await this.prisma.hostingPack.findMany({
      where: { id: { in: packIds } },
      select: {
        id: true,
        name: true,
        status: true,
        maxApps: true,
        ramMb: true,
        cpuCores: true,
        storageLimit: true,
        deploymentModule: {
          select: { overrideRamMb: true, overrideCpuCores: true, overrideStorageLimit: true },
        },
      },
    });
    const packById = new Map<string, PackAgg>(packs.map((p) => [p.id, p as unknown as PackAgg]));

    // Limite effective par app d'un pack (override du module du pack primant).
    const perApp = (p: PackAgg | undefined): { ramMb: number; cpuCores: number; storageGb: number | null } => {
      if (!p || p.status !== PackStatus.ACTIVE) return { ramMb: 0, cpuCores: 0, storageGb: null };
      return {
        ramMb: p.deploymentModule?.overrideRamMb ?? p.ramMb,
        cpuCores: p.deploymentModule?.overrideCpuCores ?? p.cpuCores,
        storageGb: p.deploymentModule?.overrideStorageLimit ?? p.storageLimit ?? null,
      };
    };

    // Groupe par (userId, packId) : jamais de fusion entre packs d'un même client.
    type Group = {
      userId: string;
      clientName: string | null;
      clientEmail: string;
      projectUuid: string;
      packId: string | null;
      packName: string | null;
      moduleKind: DeploymentModuleKind | null;
      appsCount: number;
      totalRamMb: number;
      totalCpuCores: number;
      totalStorageGb: number;
    };
    const groups = new Map<string, Group>();

    for (const d of deployments) {
      const pack = d.packId ? packById.get(d.packId) : undefined;
      const effPerApp = perApp(pack);
      // Ressource allouée réelle = limite effective enregistrée (override incluse), sinon repli pack.
      const ramMb = d.limitsRamMb ?? effPerApp.ramMb;
      const cpuCores = d.limitsCpu ?? effPerApp.cpuCores;
      const storageGb = effPerApp.storageGb ?? 0;

      const key = `${d.userId}:${d.packId ?? 'no-pack'}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          userId: d.userId,
          clientName: d.user.name,
          clientEmail: d.user.email,
          projectUuid: d.coolifyProjectUuid!,
          packId: d.packId ?? null,
          packName: pack?.name ?? (d.packId ? null : null),
          moduleKind: d.module?.kind ?? d.clientProject?.module?.kind ?? null,
          appsCount: 0,
          totalRamMb: 0,
          totalCpuCores: 0,
          totalStorageGb: 0,
        };
        groups.set(key, g);
      }
      g.appsCount += 1;
      g.totalRamMb += ramMb;
      g.totalCpuCores += cpuCores;
      g.totalStorageGb += storageGb;
    }

    const results: ProjectConsumption[] = [];
    for (const g of groups.values()) {
      const pack = g.packId ? packById.get(g.packId) : undefined;
      const effPerApp = perApp(pack);
      const maxApps = pack?.maxApps ?? null;
      // Budget = limite effective par app × maxApps (quota dérivé, par pack).
      const budgetRamMb = maxApps != null && effPerApp.ramMb > 0 ? effPerApp.ramMb * maxApps : null;
      const budgetCpuCores = maxApps != null && effPerApp.cpuCores > 0 ? effPerApp.cpuCores * maxApps : null;
      // Quota disque : inactif (valeur enregistrée seulement) — on affiche « illimité ».
      const budgetStorageGb = null;

      results.push({
        id: `${g.projectUuid}:${g.packId ?? 'no-pack'}`,
        clientName: g.clientName,
        clientEmail: g.clientEmail,
        projectUuid: g.projectUuid,
        packId: g.packId,
        packName: g.packName ?? (pack ? pack.name : null),
        moduleKind: g.moduleKind,
        appsCount: g.appsCount,
        totalRamMb: g.totalRamMb,
        totalCpuCores: g.totalCpuCores,
        totalStorageGb: g.totalStorageGb,
        budgetRamMb,
        budgetCpuCores,
        budgetStorageGb,
        overRam: budgetRamMb != null && g.totalRamMb > budgetRamMb,
        overCpu: budgetCpuCores != null && g.totalCpuCores > budgetCpuCores,
        overDisk: false,
        totalConsumption:
          g.totalRamMb + g.totalCpuCores * 1000 + (g.totalStorageGb ?? 0) * 1_000_000,
      });
    }

    results.sort((a, b) => b.totalConsumption - a.totalConsumption);
    return results;
  }
}