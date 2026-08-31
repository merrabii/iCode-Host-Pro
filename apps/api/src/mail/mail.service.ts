import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailSmtpConfig, MailTransportFactory } from './mail-transport.factory';

/** A send failure — message carries the SMTP error surfaced to the admin. */
export class MailException extends Error {}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// Phase 6 (ADR-022): stateless mail sender — builds the nodemailer transport
// from a config provided by the caller (MailSettingsService owns the decrypted
// saved config) and sends one message. Deliberately has NO settings dependency,
// so MailSettingsService can inject it without a provider cycle and tests can
// mock it trivially.
@Injectable()
export class MailService {
  constructor(
    private readonly transportFactory: MailTransportFactory,
    private readonly config: ConfigService,
  ) {}

  /** Send one mail through the given SMTP config. Throws MailException. */
  async sendMail(cfg: MailSmtpConfig, msg: MailMessage): Promise<void> {
    const transport = this.transportFactory.create(cfg);
    const from = cfg.fromName
      ? `"${cfg.fromName}" <${cfg.fromEmail}>`
      : cfg.fromEmail;
    try {
      await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
    } catch (err) {
      throw new MailException(this.errMessage(err));
    }
  }

  /** Absolute invitation link + French message body for an invitation email. */
  buildInviteMessage(input: {
    to: string;
    token: string;
    email: string;
  }): MailMessage {
    const base = (this.config.get<string>('publicBaseUrl') ??
      'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/auth?invite=${encodeURIComponent(
      input.token,
    )}&email=${encodeURIComponent(input.email)}`;
    return {
      to: input.to,
      subject: 'Votre invitation — iCode Host Pro',
      text: [
        'Bonjour,',
        '',
        'Vous avez été invité(e) à créer un compte sur iCode Host Pro.',
        '',
        "Pour accepter l'invitation, ouvrez ce lien :",
        link,
        '',
        "Ce lien n'est utilisable qu'une seule fois et expire après 7 jours.",
      ].join('\n'),
    };
  }

  private errMessage(err: unknown): string {
    return err instanceof Error && err.message ? err.message : String(err);
  }
}
