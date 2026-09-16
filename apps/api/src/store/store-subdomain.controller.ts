import { BadRequestException, Controller, Body, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { CheckSubdomainPublicDto } from './dto/check-subdomain.dto';
import { regexFromRejectPattern } from './subdomain.util';

/**
 * Endpoint PUBLIC de vérification du sous-domaine choisi au checkout.
 * Réutilise la logique Cloudflare (checkSubdomainAvailability) + la
 * FreeSubdomainRule du produit (longueur, allowedChars, reservedPrefixes, reject).
 * Nécessaire car le check admin (`/admin/cloudflare/check`) est réservé admin.
 */
@Controller('store')
export class StoreSubdomainController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudflare: CloudflareService,
  ) {}

  @Post('subdomain/check')
  async check(@Body() dto: CheckSubdomainPublicDto): Promise<{
    available: boolean;
    fqdn: string;
    reason?: 'invalid' | 'taken' | 'reserved' | 'no-rule';
  }> {
    const product = await this.prisma.product.findUnique({
      where: { slug: dto.productSlug },
      include: { freeSubdomainRule: true },
    });
    const rule = product?.freeSubdomainRule;
    if (!rule) {
      throw new BadRequestException('Ce produit ne nécessite pas de sous-domaine.');
    }

    const sub = dto.subdomain.trim().toLowerCase();
    if (sub.length < rule.minLength || sub.length > rule.maxLength) {
      return { available: false, fqdn: previewFqdn(sub, null), reason: 'invalid' };
    }
    if (rule.rejectPattern && regexFromRejectPattern(rule.rejectPattern)?.test(sub)) {
      return { available: false, fqdn: previewFqdn(sub, null), reason: 'reserved' };
    }
    if (rule.reservedPrefixes.some((p) => sub.startsWith(p))) {
      return { available: false, fqdn: previewFqdn(sub, null), reason: 'reserved' };
    }
    // Phase 4 — la racine est choisie (requestedDomainId) ou unique : AUCUN
    // fallback arbitraire (`allowedDomainIds[0]`, premier ACTIVE…). Éligibles =
    // racines ACTIVE restreintes par la whitelist de la règle ([] = toutes).
    const eligible = await this.eligibleDomains(rule);
    if (eligible.length === 0) {
      return { available: false, fqdn: previewFqdn(sub, null), reason: 'invalid' };
    }

    let root: { id: string; name: string };
    if (dto.requestedDomainId) {
      const chosen = eligible.find((d) => d.id === dto.requestedDomainId);
      if (!chosen) {
        return { available: false, fqdn: previewFqdn(sub, null), reason: 'invalid' };
      }
      root = chosen;
    } else {
      // Défaut : le défaut PLATEFORME (rootDomainId, #1/#5) s'il est éligible, sinon
      // l'unique éligible ; >1 sans défaut plateforme → ambiguïté (#10), pas de pick.
      const platformDefault = await this.platformDefaultEligible(eligible);
      if (platformDefault) {
        root = platformDefault;
      } else if (eligible.length > 1) {
        return { available: false, fqdn: previewFqdn(sub, null), reason: 'invalid' };
      } else {
        root = eligible[0]; // unique éligible
      }
    }

    const res = await this.cloudflare.checkSubdomainAvailability(sub, root.id);
    return {
      available: res.available,
      fqdn: res.fqdn,
      reason: res.available ? undefined : 'taken',
    };
  }

  /** Racines éligibles (ACTIVE) pour la règle du produit : `allowedDomainIds` non
   *  vide = whitelist ; vide = toutes les racines ACTIVE. (Aligné sur l'existant.) */
  private async eligibleDomains(rule: { allowedDomainIds: string[] }): Promise<{ id: string; name: string }[]> {
    return this.prisma.domain.findMany({
      where: {
        status: 'ACTIVE',
        ...(rule.allowedDomainIds.length > 0 ? { id: { in: rule.allowedDomainIds } } : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }],
    });
  }

  /** Racine du défaut PLATEFORME (CloudflareSetting.rootDomainId) parmi les éligibles,
   *  si elle y figure. Même logique que CloudflareService.resolveEffectiveRoot (#1/#5). */
  private async platformDefaultEligible(
    eligible: { id: string; name: string }[],
  ): Promise<{ id: string; name: string } | null> {
    if (!eligible.length) return null;
    const settings = await this.prisma.cloudflareSetting.findFirst();
    if (!settings?.rootDomainId) return null;
    return eligible.find((d) => d.id === settings.rootDomainId) ?? null;
  }
}

/** Aperçu du FQDN quand le domaine racine n'est pas encore chargé (fallback). */
function previewFqdn(sub: string, root: string | null): string {
  return `${sub}.${root ?? '…'}`;
}