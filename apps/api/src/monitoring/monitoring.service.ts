import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentModuleKind, DeploymentStatus, PackStatus } from '@prisma/client';

export interface ProjectConsumption {
  projectUuid: string;
  clientName: string | null;
  clientEmail: string;
  moduleKind: DeploymentModuleKind | null;
  appsCount: number;
  totalRamMb: number;
  totalCpuCores: number;
  totalStorageGb: number;
  packRamMb: number | null;
  packCpuCores: number | null;
  packStorageGb: number | null;
  overRam: boolean;
  overCpu: boolean;
  overDisk: boolean;
  totalConsumption: number; // score pour tri desc : RAM(1) + CPU(1024) + Disk(1024*1024) approx
}

/**
 * Service de monitoring des projets client (Phase 13).
 * Agrégation OFFLINE des déploiements par projet Coolify (coolifyProjectUuid).
 * Compare les limites Σ des apps aux limites du pack → flags overRam/overCpu/overDisk.
 * Trie par consommation totale descendante.
 */
@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService) {}

  async getProjectsConsumption(): Promise<ProjectConsumption[]> {
    // 1. Récupérer tous les déploiements ACTIVE avec leurs infos pack/module
    const deployments = await this.prisma.deployment.findMany({
      where: {
        status: DeploymentStatus.ACTIVE,
        coolifyProjectUuid: { not: null },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        server: { select: { id: true, name: true } },
        // Le module peut venir de Deployment.moduleId OU de Deployment.clientProject.module
        module: {
          include: { server: true },
        },
        clientProject: {
          include: { module: { include: { server: true } } },
        },
      },
    });

    // 2. Pour chaque déploiement, déterminer le pack actif du client
    // On doit charger l'abonnement ACTIVE → produit → pack
    const userIds = [...new Set(deployments.map((d) => d.userId))];
    const userPacks = await this.getUserActivePacks(userIds);

    // 3. Grouper par coolifyProjectUuid
    const byProject = new Map<string, {
      projectUuid: string;
      clientName: string | null;
      clientEmail: string;
      moduleKind: DeploymentModuleKind | null;
      deployments: typeof deployments;
      pack: { ramMb: number; cpuCores: number; storageLimit: number | null } | null;
    }>();

    for (const d of deployments) {
      const projectUuid = d.coolifyProjectUuid!;
      const pack = userPacks.get(d.userId) ?? null;
      const moduleKind = d.module?.kind ?? d.clientProject?.module?.kind ?? null;

      if (!byProject.has(projectUuid)) {
        byProject.set(projectUuid, {
          projectUuid,
          clientName: d.user.name,
          clientEmail: d.user.email,
          moduleKind,
          deployments: [],
          pack,
        });
      }
      byProject.get(projectUuid)!.deployments.push(d);
    }

    // 4. Calculer les totaux par projet
    const results: ProjectConsumption[] = [];
    for (const [projectUuid, data] of byProject) {
      const { deployments: deps, pack, clientName, clientEmail, moduleKind } = data;

      let totalRamMb = 0;
      let totalCpuCores = 0;
      let totalStorageGb = 0;

      for (const dep of deps) {
        // RAM/CPU appliqués côté Coolify via applyAppLimits → on lit les limites du pack (avec overrides module)
        // Note: les overrides du module priment sur le pack (voir deployments.service.packLimits)
        // Pour le monitoring offline, on approxime avec les limites du pack (sans overrides pour simplifier)
        if (pack) {
          totalRamMb += pack.ramMb;
          totalCpuCores += pack.cpuCores;
          totalStorageGb += pack.storageLimit ?? 0;
        }
      }

      const packRamMb = pack?.ramMb ?? null;
      const packCpuCores = pack?.cpuCores ?? null;
      const packStorageGb = pack?.storageLimit ?? null;

      const overRam = packRamMb !== null && totalRamMb > packRamMb;
      const overCpu = packCpuCores !== null && totalCpuCores > packCpuCores;
      const overDisk = packStorageGb !== null && totalStorageGb > packStorageGb;

      // Score de tri : RAM en Mo + CPU*1000 + Disk*1000000 (pour ordre de grandeur)
      const totalConsumption = totalRamMb + totalCpuCores * 1000 + totalStorageGb * 1_000_000;

      results.push({
        projectUuid,
        clientName,
        clientEmail,
        moduleKind,
        appsCount: deps.length,
        totalRamMb,
        totalCpuCores,
        totalStorageGb,
        packRamMb,
        packCpuCores,
        packStorageGb,
        overRam,
        overCpu,
        overDisk,
        totalConsumption,
      });
    }

    // 5. Trier par consommation totale descendante
    results.sort((a, b) => b.totalConsumption - a.totalConsumption);

    return results;
  }

  /**
   * Récupère le pack ACTIF de chaque utilisateur (via subscription ACTIVE → product → pack).
   * Retourne un Map userId -> { ramMb, cpuCores, storageLimit }.
   */
  private async getUserActivePacks(userIds: string[]): Promise<Map<string, { ramMb: number; cpuCores: number; storageLimit: number | null }>> {
    const subs = await this.prisma.subscription.findMany({
      where: {
        userId: { in: userIds },
        status: 'ACTIVE',
      },
      include: {
        product: {
          include: {
            pack: true,
          },
        },
      },
    });

    const map = new Map<string, { ramMb: number; cpuCores: number; storageLimit: number | null }>();
    for (const sub of subs) {
      if (sub.product?.pack && sub.product.pack.status === PackStatus.ACTIVE) {
        map.set(sub.userId, {
          ramMb: sub.product.pack.ramMb,
          cpuCores: sub.product.pack.cpuCores,
          storageLimit: sub.product.pack.storageLimit,
        });
      }
    }
    return map;
  }
}