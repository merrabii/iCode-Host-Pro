import { Injectable } from '@nestjs/common';

/**
 * Preuve de disponibilité HTTP/HTTPS — extraite de ProvisioningService.isServed
 * (17B.3A) pour un usage partagé (awaitAppReady aujourd'hui, réconciliateur 17B
 * demain), SANS changement de comportement : HEAD `https://<fqdn>`,
 * redirects suivis, 2xx/3xx = servi, toute autre issue (timeout, DNS non prêt,
 * erreur réseau, AbortError, statut non accepté) = false. Aucune requête
 * mutative, aucun secret/contenu journalisé.
 */
@Injectable()
export class HttpAvailabilityService {
  private readonly defaultTimeoutMs = 8000;
  private readonly fqdnPattern = /^[a-z0-9.\-]+$/i;

  async isServed(fqdn: string, timeoutMs: number = this.defaultTimeoutMs): Promise<boolean> {
    const host = fqdn.trim();
    if (!host || host.length > 253 || !this.fqdnPattern.test(host)) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://${host}`, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort(); // libère les écoutes restantes ; idempotent après résolution normale
    }
  }
}