import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  OrderStatus,
  ProvisioningStepStatus,
  ProvisionAction,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { MailSettingsService } from '../mail/mail-settings.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import {
  PanelKind,
  PanelTarget,
  PanelTransportFactory,
} from '../servers/panel-transport.factory';

/**
 * Bloc D — provision réel d'une commande store.
 *
 * Déclenché juste après `checkout.service` (même requête) ou via un appel
 * admin « relancer ». Exécute dans l'ordre les ProvisionAction du
 * ProvisionMethod lié au produit (CREATE_APP → CONFIGURE_DNS → GENERATE_SSL
 * → ENABLE_BACKUP), trace chaque étape dans ProvisioningLog, bascule
 * l'Order PAID → PROVISIONING → ACTIVE, et envoie l'email de livraison du
 * sous-domaine gratuit. Le hostname Coolify n'est JAMAIS communiqué au client.
 *
 * Best-effort par étape : un échec met la step en FAILED mais ne coupe pas
 * les suivantes ; le statut final dépend du succès des steps critiques.
 */
@Injectable()
export class ProvisioningService {
  private readonly log = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly mail: MailSettingsService,
    private readonly cloudflare: CloudflareService,
    private readonly panelFactory: PanelTransportFactory,
  ) {}

  /**
   * Provisionne une commande payée. Idempotent : si l'Order est déjà
   * PROVISIONING/ACTIVE, on renvoie l'état sans refaire le travail
   * (sauf `force=true` côté admin).
   */
  async provisionOrder(orderId: string, opts?: { force?: boolean }): Promise<{
    orderId: string;
    status: string;
    fqdn: string | null;
    steps: { step: string; status: string; message: string | null }[];
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        product: {
          include: {
            provisionModule: true,
            pack: { include: { deploymentModule: { include: { server: true } } } },
          },
        },
        customer: true,
      },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');

    if (
      !opts?.force &&
      (order.status === OrderStatus.PROVISIONING || order.status === OrderStatus.ACTIVE)
    ) {
      const logs = await this.prisma.provisioningLog.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      return {
        orderId,
        status: order.status,
        fqdn: order.domainValue ?? null,
        steps: logs.map((l) => ({ step: l.step, status: l.status, message: l.message })),
      };
    }

    const method = order.product.provisionModule;
    const actions: ProvisionAction[] = (method?.actions as ProvisionAction[]) ?? [];

    // Aucune méthode configurée → rien à provisionner : on passe ACTIVE direct.
    if (!method || actions.length === 0) {
      await this.setOrderStatus(orderId, OrderStatus.ACTIVE, 'Aucune action de provisioning configurée.');
      return { orderId, status: OrderStatus.ACTIVE, fqdn: order.domainValue ?? null, steps: [] };
    }

    await this.setOrderStatus(orderId, OrderStatus.PROVISIONING, `Provisioning lancé (${method.name}).`);

    let fqdn: string | null = order.domainValue ?? null;
    let appUuid: string | null = null;

    for (const action of actions) {
      const stepName = this.stepName(action);
      const logId = await this.openStep(orderId, stepName);
      try {
        const out = await this.runAction(action, {
          order,
          method,
          fqdn,
          appUuid,
        });
        if (out.fqdn) fqdn = out.fqdn;
        if (out.appUuid) appUuid = out.appUuid;
        await this.closeStep(logId, ProvisioningStepStatus.SUCCESS, out.message ?? null);
        await this.audit.record({
          action: `provision.${stepName}`,
          resourceType: 'order',
          resourceId: orderId,
          details: { step: stepName, status: 'SUCCESS', fqdn, message: out.message ?? undefined },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`provision ${stepName} order=${orderId}: ${msg}`);
        await this.closeStep(logId, ProvisioningStepStatus.FAILED, msg);
        await this.audit.record({
          action: `provision.${stepName}`,
          resourceType: 'order',
          resourceId: orderId,
          details: { step: stepName, status: 'FAILED', message: msg },
        });
        // Les steps non critiques n'interrompent pas la suite ; on continue.
        // Si CREATE_APP échoue, les steps suivants resteront FAILED/SKIPPED
        // mais l'Order passera quand même en ACTIVE si un fqdn existe déjà
        // (ex. DNS déjà alloué), sinon on laisse PROVISIONING pour retry admin.
      }
    }

    // Persiste le fqdn livré sur l'Order (jamais le hostname Coolify).
    if (fqdn && fqdn !== order.domainValue) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { domainType: 'FREE_SUBDOMAIN', domainValue: fqdn, domainStatus: 'READY' },
      });
    }

    // Si un fqdn a été livré ou qu'aucune step critique n'a échoué, on passe ACTIVE.
    const logs = await this.prisma.provisioningLog.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    const hasFailedCreateApp = logs.some(
      (l) => l.step === 'create_app' && l.status === ProvisioningStepStatus.FAILED,
    );
    const nextStatus = hasFailedCreateApp && !fqdn ? OrderStatus.PROVISIONING : OrderStatus.ACTIVE;
    await this.setOrderStatus(
      orderId,
      nextStatus,
      nextStatus === OrderStatus.ACTIVE ? 'Provisioning terminé.' : 'Provisioning partiel — relance requise.',
    );

    // Email de livraison du sous-domaine (best-effort, jamais bloquant).
    if (fqdn && nextStatus === OrderStatus.ACTIVE) {
      await this.sendDeliveryEmail(order.customerEmail, order.customerName, fqdn, orderId).catch((e) => {
        this.log.warn(`delivery email order=${orderId} failed: ${String(e)}`);
        this.audit.record({
          action: 'provision.delivery_email',
          resourceType: 'order',
          resourceId: orderId,
          details: { ok: false, error: String(e) },
        });
      });
    }

    const finalLogs = await this.prisma.provisioningLog.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      orderId,
      status: nextStatus,
      fqdn,
      steps: finalLogs.map((l) => ({ step: l.step, status: l.status, message: l.message })),
    };
  }

  private stepName(a: ProvisionAction): string {
    switch (a) {
      case ProvisionAction.CREATE_APP:
        return 'create_app';
      case ProvisionAction.CONFIGURE_DNS:
        return 'configure_dns';
      case ProvisionAction.GENERATE_SSL:
        return 'generate_ssl';
      case ProvisionAction.ENABLE_BACKUP:
        return 'enable_backup';
      default:
        return String(a).toLowerCase();
    }
  }

  private async openStep(orderId: string, step: string): Promise<string> {
    const row = await this.prisma.provisioningLog.create({
      data: { orderId, step, status: ProvisioningStepStatus.RUNNING },
    });
    return row.id;
  }

  private async closeStep(id: string, status: ProvisioningStepStatus, message: string | null): Promise<void> {
    await this.prisma.provisioningLog.update({ where: { id }, data: { status, message } });
  }

  private async setOrderStatus(orderId: string, status: OrderStatus, note: string): Promise<void> {
    await this.prisma.order.update({ where: { id: orderId }, data: { status } });
    await this.prisma.orderStatusHistory.create({ data: { orderId, status, note } });
  }

  private buildTarget(server: NonNullable<NonNullable<Awaited<ReturnType<ProvisioningService['resolveServer']>>>>): PanelTarget {
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc!);
    } catch {
      throw new Error('Impossible de déchiffrer le jeton API Coolify (ENCRYPTION_KEY ?).');
    }
    return {
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl!,
      token,
      user: null,
      strictTls: server.strictTls,
    };
  }

  private async resolveServer(order: {
    product: { pack?: { deploymentModule?: { server?: unknown } | null } | null };
  }): Promise<{ id: string; panelProvider: string; apiBaseUrl: string | null; apiTokenEnc: string | null; strictTls: boolean; hostname: string; coolifyProjectUuid: string | null; coolifyServerUuid: string | null } | null> {
    const s = order.product.pack?.deploymentModule?.server as
      | { id: string; panelProvider: string; apiBaseUrl: string | null; apiTokenEnc: string | null; strictTls: boolean; hostname: string; coolifyProjectUuid: string | null; coolifyServerUuid: string | null }
      | null
      | undefined;
    if (!s) return null;
    return s;
  }

  private async runAction(
    action: ProvisionAction,
    ctx: {
      order: {
        id: string;
        customerEmail: string;
        customerName: string;
        productId: string;
        product: { name: string; moduleParams?: unknown; pack?: unknown };
      };
      method: { name: string };
      fqdn: string | null;
      appUuid: string | null;
    },
  ): Promise<{ fqdn?: string; appUuid?: string; message?: string }> {
    switch (action) {
      case ProvisionAction.CREATE_APP:
        return this.actionCreateApp(ctx);
      case ProvisionAction.CONFIGURE_DNS:
        return this.actionConfigureDns(ctx);
      case ProvisionAction.GENERATE_SSL:
        return { message: 'SSL géré par Cloudflare (proxied).' };
      case ProvisionAction.ENABLE_BACKUP:
        return { message: 'Sauvegarde non configurée (best-effort).' };
      default:
        return { message: `Action inconnue : ${String(action)}` };
    }
  }

  private async actionCreateApp(ctx: {
    order: { id: string; product: { name: string; moduleParams?: unknown; pack?: unknown } };
    fqdn: string | null;
    appUuid: string | null;
  }): Promise<{ appUuid?: string; message?: string }> {
    // On tente de créer l'app Coolify si le module a un serveur configuré.
    // moduleParams peut porter repoUrl/branch/buildPack/appName (produit GitHub).
    const fullOrder = await this.prisma.order.findUnique({
      where: { id: ctx.order.id },
      include: { product: { include: { pack: { include: { deploymentModule: { include: { server: true } } } } } } },
    });
    const server = fullOrder?.product.pack?.deploymentModule?.server ?? null;
    if (!server || server.panelProvider !== 'COOLIFY' || !server.apiBaseUrl || !server.apiTokenEnc) {
      return { message: 'Aucun serveur Coolify configuré pour ce produit — app non créée (DNS seul).' };
    }
    const params = (fullOrder?.product.moduleParams ?? {}) as Record<string, unknown>;
    const repoUrl = typeof params.repoUrl === 'string' ? params.repoUrl : null;
    // Sans repoUrl, on ne peut pas créer d'app Coolify — on considère le produit
    // comme « sans app » (ex. pack WordPress géré déjà provisionné ailleurs).
    if (!repoUrl) {
      return { message: 'Produit sans repoUrl — création Coolify ignorée.' };
    }
    const branch = typeof params.branch === 'string' && params.branch.trim() ? String(params.branch).trim() : 'main';
    const buildPack = typeof params.buildPack === 'string' ? String(params.buildPack) : 'nixpacks';
    const appName = typeof params.appName === 'string' && String(params.appName).trim()
      ? String(params.appName).trim()
      : fullOrder?.product.name ?? 'app';
    const target = this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]);
    const transport = this.panelFactory.create();
    const mod = fullOrder?.product.pack?.deploymentModule ?? null;
    const projectUuid =
      mod && mod.kind === 'SHARED_PROJECT' && mod.sharedProjectUuid
        ? mod.sharedProjectUuid
        : (server.coolifyProjectUuid ?? undefined);
    const created = await transport.createGitApp(target, {
      repoUrl,
      branch,
      serviceName: appName,
      buildPack,
      appName,
      projectUuid,
      serverUuid: server.coolifyServerUuid ?? undefined,
    });
    // Limites pack (si configuré) — best-effort.
    try {
      const pack = fullOrder?.product.pack as { ramMb?: number; cpuCores?: number; status?: string } | null;
      if (pack && pack.status === 'ACTIVE') {
        const limits: Record<string, string> = {};
        if (pack.cpuCores && pack.cpuCores > 0) {
          const n = Math.round(pack.cpuCores * 100) / 100;
          limits.cpus = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        }
        if (pack.ramMb && pack.ramMb > 0) {
          limits.memory = pack.ramMb < 1024 ? `${Math.round(pack.ramMb)}m` : `${Math.round((pack.ramMb / 1024) * 100) / 100}g`;
        }
        if (limits.cpus || limits.memory) {
          await transport.applyAppLimits(target, created.uuid, limits as { cpus?: string; memory?: string });
        }
      }
    } catch {
      // best-effort
    }
    // Si le sous-domaine a déjà été alloué (ordre CONFIGURE_DNS avant CREATE_APP),
    // on le pose sur l'app AVANT le déploiement pour que le premier build porte
    // la bonne étiquette traefik (déterminant : c'est ce qui fait que le
    // sous-domaine est réellement servi publiquement — vérifié live 4.1.2).
    if (ctx.fqdn) {
      try {
        await transport.setAppDomain(target, created.uuid, ctx.fqdn);
      } catch {
        // best-effort — le domaine sera posable en retry
      }
    }
    await transport.deployApp(target, created.uuid);
    return { appUuid: created.uuid, message: `App Coolify créée (${created.uuid}).` };
  }

  private async actionConfigureDns(ctx: {
    order: { id: string; customerName: string };
    fqdn: string | null;
    appUuid: string | null;
  }): Promise<{ fqdn?: string; message?: string }> {
    if (ctx.fqdn) return { fqdn: ctx.fqdn, message: `Sous-domaine déjà alloué : https://${ctx.fqdn}` };
    const fullOrder = await this.prisma.order.findUnique({
      where: { id: ctx.order.id },
      include: { product: { include: { pack: { include: { deploymentModule: { include: { server: true } } } } } } },
    });
    const server = fullOrder?.product.pack?.deploymentModule?.server ?? null;
    const root = await this.cloudflare.findActiveRootDomain();
    if (!root) {
      throw new Error('Aucun domaine racine Cloudflare actif configuré.');
    }
    const fallbackHost = (server as { hostname?: string } | null)?.hostname ?? root.cnameTarget ?? 'localhost';
    const seed = ctx.order.customerName || fullOrder?.product.name || 'app';
    // Store: pas de Deployment row — on passe sans deploymentId (ClientSubdomain nullable côté store).
    const alloc = await this.cloudflare.allocateClientSubdomain({
      root,
      seed,
      fallbackHost,
    });
    // Si l'app a déjà été créée, on pose le domaine dessus puis on redéploie
    // (best-effort) pour que le conteneur redémarre avec traefik relié au
    // sous-domaine client — sans ça, l'app n'est pas servie publiquement.
    if (ctx.appUuid && server && (server as { apiBaseUrl?: string | null }).apiBaseUrl) {
      try {
        const target = this.buildTarget(server as Parameters<ProvisioningService['buildTarget']>[0]);
        const transport = this.panelFactory.create();
        await transport.setAppDomain(target, ctx.appUuid, alloc.fqdn);
        await transport.deployApp(target, ctx.appUuid);
      } catch {
        // best-effort — reposable en retry
      }
    }
    // On persiste via domainValue (Order), pas via Deployment.
    await this.prisma.order.update({
      where: { id: ctx.order.id },
      data: { domainType: 'FREE_SUBDOMAIN', domainValue: alloc.fqdn, domainStatus: 'READY' },
    });
    return { fqdn: alloc.fqdn, message: `Sous-domaine alloué : https://${alloc.fqdn}` };
  }

  private async sendDeliveryEmail(
    to: string,
    name: string,
    fqdn: string,
    orderId: string,
  ): Promise<void> {
    await this.mail.sendPlain({
      to,
      subject: 'Votre application est prête — Code Diali',
      text: [
        `Bonjour ${name},`,
        '',
        'Votre application est prête.',
        '',
        `Accédez-y à l’adresse : https://${fqdn}`,
        '',
        `Commande : ${orderId}`,
        '',
        'Si vous avez la moindre question, répondez simplement à cet email.',
        '',
        'L’équipe Code Diali',
      ].join('\n'),
    });
    await this.audit.record({
      action: 'provision.delivery_email',
      resourceType: 'order',
      resourceId: orderId,
      details: { ok: true, fqdn },
    });
  }
}
