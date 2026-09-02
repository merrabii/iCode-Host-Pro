import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ProductStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SaRateLimiter, RATE, rateKey } from './rate-limiter';

export const CHECKOUT_INTENT_TTL_SECONDS = 600;

interface CheckoutTokenPayload {
  productId: string;
  exp: number;
}

/**
 * Phase 10 (ADR-027): signed short-lived "checkout intent" that ties account
 * creation strictly to an actual order. Issued by POST /api/checkout/intent
 * (public) into the httpOnly cookie `ihp_checkout`; required by the order-time
 * registration (email+pass or OAuth callback). Stateless (JWT) — the cookie is
 * cleared on success; reuse within the TTL merely places another order.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly limiter: SaRateLimiter,
  ) {}

  /** USER-facing validation that the product can be ordered. */
  private async assertOrderable(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Produit introuvable.');
    if (
      product.status === ProductStatus.DRAFT ||
      product.status === ProductStatus.DISABLED
    ) {
      throw new NotFoundException('Ce produit n’est pas disponible à la commande.');
    }
    return product;
  }

  async createIntent(
    productId: string,
    ip?: string,
  ): Promise<{ token: string; maxAgeSeconds: number }> {
    const rl = this.limiter.consume(
      rateKey(ip, 'checkout'),
      RATE.checkoutIntent.limit,
      RATE.checkoutIntent.windowMs,
    );
    if (!rl.allowed) {
      throw new NotFoundException(
        `Trop de demandes. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
      );
    }
    await this.assertOrderable(productId);
    const token = await this.jwt.signAsync(
      { productId } as CheckoutTokenPayload,
      { expiresIn: CHECKOUT_INTENT_TTL_SECONDS },
    );
    await this.audit.record({
      action: 'checkout.intent',
      resourceType: 'product',
      resourceId: productId,
    });
    return { token, maxAgeSeconds: CHECKOUT_INTENT_TTL_SECONDS };
  }

  /** Validate a checkout cookie token and return its productId, or null. */
  async readProductId(cookieToken: string | null | undefined): Promise<string | null> {
    if (!cookieToken) return null;
    try {
      const payload = await this.jwt.verifyAsync<CheckoutTokenPayload>(cookieToken);
      if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload.productId ?? null;
    } catch {
      return null;
    }
  }
}