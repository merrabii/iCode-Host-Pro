import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CardPayment, CardPaymentStatus } from '@prisma/client';
import type { Response } from 'express';
import { isPaymentSimulatorEnabled } from '../../config/payment-simulator';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProviderService } from '../payment-provider.service';
import { PaymentWebhookService } from '../payment-webhook.service';
import { signStripeWebhook } from '../stripe-signature';
import { SimulatedCompleteDto } from '../dto/payments.dto';

const BRAND = '#5b5bd6';

/**
 * GO Stripe §8 — page « hébergée » du SIMULATEUR (recette/CI uniquement).
 *
 * Elle joue le rôle de la page Stripe Checkout dans les parcours de test :
 * aucun numéro de carte, aucun réseau, aucun prestataire réel. L'événement
 * est ÉMIS côté serveur, SIGNÉ avec le secret webhook local puis injecté dans
 * la MÊME chaîne que Stripe (signature → déduplication → confirmation) —
 * aucun chemin court vers le crédit. Refusée (404) dès que le simulateur
 * n'est pas explicitement activé ou en production.
 */
@ApiTags('payments/simulated')
@Controller('payments/simulated')
export class SimulatedPaymentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProviderService,
    private readonly webhooks: PaymentWebhookService,
    private readonly config: ConfigService,
  ) {}

  private gate(): void {
    if (!isPaymentSimulatorEnabled()) {
      throw new NotFoundException('Simulateur de paiement désactivé.');
    }
  }

  private async load(sessionRef: string): Promise<CardPayment> {
    const row = await this.prisma.cardPayment.findFirst({
      where: { providerSessionRef: sessionRef },
    });
    if (!row) throw new NotFoundException('Session simulée introuvable.');
    return row;
  }

  @Get('sessions/:ref')
  @ApiOperation({ summary: 'Page de paiement simulée (recette)' })
  async page(@Param('ref') ref: string, @Res() res: Response): Promise<void> {
    this.gate();
    const row = await this.load(ref);
    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    const data = {
      reference: row.reference,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      sessionRef: row.providerSessionRef,
      webOrigin,
      editable: row.status === CardPaymentStatus.CREATED,
      failed: row.status === CardPaymentStatus.FAILED,
      expired: row.status === CardPaymentStatus.EXPIRED,
    };
    res.type('html').send(this.renderPage(data));
  }

  @Post('sessions/:ref/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Émettre un événement de paiement simulé signé' })
  async complete(@Param('ref') ref: string, @Body() dto: SimulatedCompleteDto) {
    this.gate();
    const row = await this.load(ref);
    if (row.status !== CardPaymentStatus.CREATED && row.status !== CardPaymentStatus.PROCESSING) {
      throw new NotFoundException(
        `Session déjà terminée (${row.status}) : aucun nouvel événement émis.`,
      );
    }

    const paymentRef = row.providerPaymentRef ?? `pi_sim_${row.reference}`;
    const common = {
      id: row.providerSessionRef,
      object: 'checkout.session',
      livemode: false,
      client_reference_id: row.reference,
      payment_intent: paymentRef,
      amount_total: row.amountCents,
      currency: row.currency.toLowerCase(),
      metadata: { reference: row.reference, customerId: row.customerId },
    };

    let type: string;
    let object: Record<string, unknown>;
    switch (dto.outcome) {
      case 'success':
        type = 'checkout.session.completed';
        object = { ...common, payment_status: 'paid', status: 'complete' };
        break;
      case 'failed':
        type = 'payment_intent.payment_failed';
        object = {
          id: paymentRef,
          object: 'payment_intent',
          livemode: false,
          amount: row.amountCents,
          currency: row.currency.toLowerCase(),
          last_payment_error: { message: 'Carte refusée (simulation locale).' },
        };
        break;
      default:
        type = 'checkout.session.expired';
        object = { ...common, payment_status: 'unpaid', status: 'expired' };
        break;
    }

    const rawBody = JSON.stringify({ id: `evt_sim_${Date.now()}`, type, data: { object } });
    const secret = await this.provider.webhookSecretFor('simulated');
    const header = signStripeWebhook({ rawBody, secret });

    const result = await this.webhooks.handleSignedPayload({
      providerCode: 'simulated',
      rawBody,
      header,
    });

    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return {
      providerResult: result.body,
      httpStatus: result.httpStatus,
      reference: row.reference,
      redirect: `${webOrigin}/client/portefeuille/paiement?ref=${encodeURIComponent(row.reference)}`,
    };
  }

  private renderPage(data: {
    reference: string;
    amountCents: number;
    currency: string;
    status: string;
    sessionRef: string | null;
    webOrigin: string;
    editable: boolean;
    failed: boolean;
    expired: boolean;
  }): string {
    const amount = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: data.currency.toUpperCase(),
    }).format(data.amountCents / 100);
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paiement simulé — Code Diali</title>
<style>
 :root{--brand:${BRAND};--bg:#0f1020;--card:#171836;--txt:#eef0ff;--muted:#a9adde}
 *{box-sizing:border-box}body{margin:0;background:linear-gradient(160deg,var(--bg),#1d1f4d);color:var(--txt);font:15px/1.5 system-ui,Segoe UI,Roboto,Arial;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
 .card{width:min(520px,100%);background:var(--card);border:1px solid #2b2d63;border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
 h1{margin:0 0 4px;font-size:20px}h1 span{color:var(--brand)}
 .badge{display:inline-block;background:#2b2d63;color:var(--muted);border-radius:999px;padding:3px 10px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:16px}
 .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px dashed #2b2d63;font-size:14px}
 .row b{font-variant-numeric:tabular-nums}
 .amount{font-size:30px;font-weight:700;margin:16px 0 4px;color:#fff}
 .muted{color:var(--muted);font-size:13px}
 .btns{display:flex;flex-direction:column;gap:10px;margin-top:22px}
 button{border:0;border-radius:10px;padding:13px 16px;font-size:15px;font-weight:600;cursor:pointer}
 .ok{background:var(--brand);color:#fff}.no{background:#ff5b6e;color:#1a0a10}.ex{background:#3a3c7a;color:#dfe1ff}
 button[disabled]{opacity:.45;cursor:not-allowed}
 .warn{margin-top:16px;background:#241a2b;border:1px solid #4a2b3a;color:#ffb3c0;border-radius:10px;padding:10px 12px;font-size:13px}
 .foot{margin-top:14px;font-size:11px;color:var(--muted)}
</style></head><body><div class="card">
 <div class="badge">Simulateur local · aucun paiement réel</div>
 <h1>Code <span>Diali</span> — recharge de portefeuille</h1>
 <div class="amount">${amount}</div>
 <div class="muted">Référence ${data.reference} · statut ${data.status}</div>
 <div class="row"><span>Session</span><b>${data.sessionRef ?? '—'}</b></div>
 <div class="row"><span>Devise</span><b>${data.currency.toUpperCase()}</b></div>
 <div class="row"><span>Environnement</span><b>TEST</b></div>
 <div class="btns">
   <button class="ok" id="ok" ${data.editable ? '' : 'disabled'}>Simuler un paiement réussi</button>
   <button class="no" id="ko" ${data.editable ? '' : 'disabled'}>Simuler un refus de carte</button>
   <button class="ex" id="ex" ${data.editable ? '' : 'disabled'}>Simuler une expiration</button>
 </div>
 <div id="msg" class="muted" style="margin-top:12px"></div>
 ${data.failed ? '<div class="warn">Cette session a échoué (aucun crédit).</div>' : ''}
 ${data.expired ? '<div class="warn">Cette session est expirée (aucun crédit).</div>' : ''}
 <div class="foot">Aucune donnée de carte n'est saisie ici : la page sert uniquement à produire les événements de test (signés, dédupliqués, confirmés par le serveur).</div>
</div>
<script>
const session=${json};
const msg=document.getElementById('msg');
async function go(outcome){
  msg.textContent='Envoi de l\\'événement signé…';
  const r=await fetch('/api/payments/simulated/sessions/'+encodeURIComponent(session.sessionRef)+'/complete',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outcome})
  });
  const j=await r.json().catch(()=>null);
  if(!r.ok||!j){msg.textContent='Échec de la simulation ('+r.status+').';return;}
  msg.textContent='Événement traité — redirection…';
  setTimeout(()=>{window.location.href=j.redirect;},450);
}
document.getElementById('ok').onclick=()=>go('success');
document.getElementById('ko').onclick=()=>go('failed');
document.getElementById('ex').onclick=()=>go('expired');
</script></body></html>`;
  }
}
