'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * QR code TOTP généré LOCALEMENT dans le navigateur (lib `qrcode` → data URL).
 * Remplace l'ancien générateur externe (api.qrserver.com) : le secret TOTP
 * ne quitte JAMAIS la page, aucune requête vers un tiers.
 *
 * Trois états — chargement / succès / erreur — dérivés de l'URI courante :
 *  - jamais le QR d'une ancienne URI pendant la génération d'une nouvelle
 *    (la résolution n'est acceptée que si elle correspond à l'URI affichée) ;
 *  - une résolution asynchrone périmée (cleanup du composant) est ignorée ;
 *  - en cas d'échec : message accessible invitant à la clé manuelle,
 *    aucun spinner permanent.
 */
type QrGen = { uri: string; size: number; status: 'ok' | 'error'; dataUrl?: string };

export function TotpQr({ uri, size = 180 }: { uri: string; size?: number }) {
  const [gen, setGen] = useState<QrGen | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(uri, { width: size, margin: 1 })
      .then((url) => { if (alive) setGen({ uri, size, status: 'ok', dataUrl: url }); })
      .catch(() => { if (alive) setGen({ uri, size, status: 'error' }); });
    return () => { alive = false; };
  }, [uri, size]);

  // Résolution correspondant à l'URI/taille affichées, sinon état de chargement.
  const current = gen && gen.uri === uri && gen.size === size ? gen : null;

  if (current?.status === 'error') {
    return (
      <div className="qr-error" role="alert">
        Génération du QR code impossible — utilisez la clé secrète (saisie manuelle) ci-dessous.
      </div>
    );
  }

  if (!current || current.status !== 'ok' || !current.dataUrl) {
    return (
      <div
        className="qr-pending"
        style={{ width: size, height: size }}
        role="status"
        aria-label="Génération du QR code…"
      >
        <span className="spinner" />
      </div>
    );
  }

  return (
    <img
      src={current.dataUrl}
      width={size}
      height={size}
      alt="QR code TOTP à scanner avec votre application d’authentification"
      data-testid="totp-qr"
      style={{ borderRadius: 10, border: '1px solid var(--border-soft)', background: '#fff' }}
    />
  );
}
