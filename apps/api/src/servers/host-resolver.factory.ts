// HostResolverFactory — seam de résolution DNS (Phase 9bis, ADR-010/ADR-025).
// Même pattern que ProbeTransportFactory / PanelTransportFactory : une factory
// @Injectable dont create() renvoie un transport, pour qu'on puisse la
// remplacer par un fake dans les tests e2e (pas de vraie résolution DNS).
// Utilisée pour auto-détecter l'IP d'un serveur depuis son hostname quand
// l'admin n'a pas saisi d'IP manuellement.

import { Injectable } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';

export abstract class HostResolver {
  /** Résout le hostname en adresse IP (première adresse). null si échec. */
  abstract resolveIp(hostname: string): Promise<string | null>;
}

export class NodeHostResolver implements HostResolver {
  async resolveIp(hostname: string): Promise<string | null> {
    try {
      const addrs = await dnsLookup(hostname, { family: 0, all: true });
      return addrs[0]?.address ?? null;
    } catch {
      // NXDOMAIN / timeout / … : aucune IP détectable => l'admin saisira
      // manuellement ; ce n'est pas une erreur fatale.
      return null;
    }
  }
}

@Injectable()
export class HostResolverFactory {
  create(): HostResolver {
    return new NodeHostResolver();
  }
}
