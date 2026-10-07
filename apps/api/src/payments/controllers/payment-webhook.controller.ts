import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PaymentWebhookService } from '../payment-webhook.service';

/**
 * GO Stripe §4 — point de réception WEBHOOK public.
 *
 *  - Corps BRUT (`rawBody` activé au bootstrap Nest) : la signature HMAC est
 *    calculée dessus, jamais sur un corps re-serialisé ;
 *  - Aucune authentification (signature = contrôle d'identité) ;
 *  - Code d'état dynamique : 200 traité/doublon, 401 signature invalide,
 *    500/503 rejeu prestataire ;
 *  - Aucun identifiant prestataire n'est exposé ailleurs (GO §4).
 */
@ApiTags('payments/webhook')
@Controller('payments/webhook')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('stripe-signature') signature?: string,
    @Headers('x-provider-code') providerHeader?: string,
  ) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException(
        'Corps brut absent : la vérification de signature est impossible (rawBody désactivé).',
      );
    }
    const providerCode = providerHeader === 'simulated' ? 'simulated' : 'stripe';
    const result = await this.webhooks.handleSignedPayload({
      providerCode,
      rawBody,
      header: signature,
    });
    res.status(result.httpStatus);
    return result.body;
  }
}
