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
    // Le bon domaine (la règle peut lister plusieurs Domain ; [] = tous les ACTIVE).
    const domainId =
      rule.allowedDomainIds[0] ??
      (await this.prisma.domain.findFirst({ where: { status: 'ACTIVE' } }))?.id ??
      null;
    if (!domainId) {
      return { available: false, fqdn: previewFqdn(sub, null), reason: 'invalid' };
    }

    const res = await this.cloudflare.checkSubdomainAvailability(sub, domainId);
    return {
      available: res.available,
      fqdn: res.fqdn,
      reason: res.available ? undefined : 'taken',
    };
  }
}

/** Aperçu du FQDN quand le domaine racine n'est pas encore chargé (fallback). */
function previewFqdn(sub: string, root: string | null): string {
  return `${sub}.${root ?? '…'}`;
}