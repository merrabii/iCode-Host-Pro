import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthCookiesService } from './auth-cookies.service';
import { CheckoutService } from './checkout.service';
import { CheckoutIntentDto } from './dto/checkout-intent.dto';

type CheckoutRequest = Request & { ip?: string };

/**
 * Phase 10 (ADR-027): the public "checkout intent" — a visitor browsing the
 * public catalog picks a product, we sign a short-lived intent cookie
 * (`ihp_checkout`, 10 min) that ALONE authorizes order-time account creation.
 * Without it, registration (email+pass or OAuth) returns 403.
 */
@ApiTags('checkout')
@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly cookies: AuthCookiesService,
  ) {}

  @Post('intent')
  @ApiOperation({ summary: 'Public — begin an order on a product (sets intent cookie)' })
  async createIntent(
    @Body() dto: CheckoutIntentDto,
    @Req() req: CheckoutRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, maxAgeSeconds } = await this.checkout.createIntent(
      dto.productId,
      req.ip,
    );
    this.cookies.setCheckout(res, token, maxAgeSeconds);
    return { ok: true, expiresInSeconds: maxAgeSeconds };
  }
}
