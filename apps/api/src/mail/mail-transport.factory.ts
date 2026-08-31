import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/** Decrypted SMTP connection options used to build an actual transporter. */
export interface MailSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  fromEmail: string;
  fromName: string | null;
}

// Phase 6 (ADR-022): dedicated test seam — e2e overrides this provider with a
// stub so NO real SMTP server is ever contacted; unit tests mock it. Runtime
// creates the nodemailer transporter from the decrypted saved config.
@Injectable()
export class MailTransportFactory {
  create(config: MailSmtpConfig): Transporter {
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user
        ? { user: config.user, pass: config.pass ?? '' }
        : undefined,
    });
  }
}
