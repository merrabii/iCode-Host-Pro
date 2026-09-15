'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui';
import { IconAlert } from '@/components/icons';

/**
 * Boîte de confirmation plateforme (remplace window.confirm) : rendu en overlay
 * au-dessus de la page, avec libellé clair et 2 actions. Utilisée notamment par
 * l'éditeur produit pour prévenir d'un changement d'onglet avec des modifs non
 * enregistrées. Toutefois, l'alerte navigateur `beforeunload` (fermer/rafraîchir
 * l'onglet) reste native — le CSS ne peut pas la styliser.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warn';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="confirm-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(10,12,20,0.55)',
        padding: 16,
      }}
      onClick={onCancel}
    >
      <div
        className="card cell"
        style={{ width: '100%', maxWidth: 420, padding: 18, border: '1px solid var(--active-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span
            style={{
              width: 34, height: 34, flex: '0 0 34px', borderRadius: 8,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: tone === 'danger' ? 'var(--danger)' : 'var(--warning)',
              color: '#fff',
            }}
          >
            <IconAlert size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{title}</div>
            <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>{message}</div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;