'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiError,
  createWalletRecharge,
  fetchMe,
  formatCents,
  getMyWallet,
  getSessionToken,
  listMyWalletTransactions,
  WALLET_STATUS_LABEL,
  WALLET_STATUS_TONE,
  WALLET_TYPE_LABEL,
  type Me,
  type WalletBalance,
  type WalletTxPage,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { CLIENT_NAV } from '@/config/nav';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
  StatCard,
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

const PER_PAGE = 20;
const PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
// Bornes serveur (centimes) : 1 $ .. 100 000 $.
const MIN_CENTS = 100;
const MAX_CENTS = 10_000_000;

/**
 * GO P6 (lots C2 + C3a) — « Mon portefeuille » : solde + historique paginé +
 * dépôt de recharge par virement avec justificatif OBLIGATOIRE (PNG/JPEG/WebP/
 * PDF ≤ 5 Mo). La recharge déposée reste `PENDING` sans effet solde : seul le
 * contrôle d'un administrateur crédite le portefeuille (une seule fois).
 * Isolation portée par l'API (dossier lié au compte).
 */
export default function ClientWalletPage() {
  const router = useRouter();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [data, setData] = useState<WalletTxPage | null>(null);
  const [page, setPage] = useState(1);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async (t: string, p: number) => {
    const [b, h] = await Promise.all([
      getMyWallet(t),
      listMyWalletTransactions(t, p, PER_PAGE),
    ]);
    if (b.ok) setBalance(b.data);
    else toast.error('Impossible de charger votre portefeuille.');
    if (h.ok) setData(h.data);
    else toast.error('Impossible de charger votre historique.');
  }, [toast]);

  useEffect(() => {
    (async () => {
      const t = await getSessionToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m) {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
      await loadAll(t, 1);
    })();
  }, [router, loadAll]);

  const changePage = (p: number) => {
    setPage(p);
    void loadAll(token, p);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = amount.trim().replace(',', '.');
    const value = Number(normalized);
    const cents = Math.round(value * 100);
    if (!normalized || !Number.isFinite(value) || value <= 0) {
      toast.warn('Indiquez un montant à recharger.');
      return;
    }
    if (cents < MIN_CENTS || cents > MAX_CENTS) {
      toast.warn('Le montant doit être compris entre 1 et 100 000 USD.');
      return;
    }
    if (!proof) {
      toast.warn('Le justificatif du virement est requis (image ou PDF).');
      return;
    }
    if (!PROOF_TYPES.includes(proof.type)) {
      toast.warn('Type de justificatif refusé (PNG, JPEG, WebP ou PDF).');
      return;
    }
    if (proof.size > PROOF_MAX_BYTES) {
      toast.warn('Justificatif trop volumineux (5 Mo maximum).');
      return;
    }
    setBusy(true);
    const r = await createWalletRecharge(token, {
      amountCents: cents,
      note: note.trim() || undefined,
      proof,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(apiError(r, 'Dépôt impossible.'));
      return;
    }
    toast.ok(
      `Dépôt enregistré (référence ${r.data?.reference ?? ''}) — en attente de validation.`,
    );
    setAmount('');
    setNote('');
    setProof(null);
    const input = document.getElementById('wallet-proof') as HTMLInputElement | null;
    if (input) input.value = '';
    setPage(1);
    await loadAll(token, 1);
  };

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} activeHref="/client/portefeuille">
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell
        me={null}
        nav={CLIENT_NAV}
        tenant={{ label: 'Espace client' }}
        activeHref="/client/portefeuille"
      >
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connectez-vous pour gérer votre portefeuille.</p>
            <a className="btn-primary" href="/auth">
              Se connecter
            </a>
          </div>
        </div>
      </AppShell>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <AppShell
      me={me}
      nav={CLIENT_NAV}
      tenant={{ label: 'Espace client' }}
      activeHref="/client/portefeuille"
    >
      <div className="wrap-md">
        <PageIntro
          eyebrow="Espace client"
          title="Portefeuille"
          sub="Solde prépayé et historique des mouvements. Rechargez par virement : chaque dépôt est crédité après contrôle du justificatif par un administrateur."
        />

        <div className="grid-2 mb">
          <StatCard
            label="Solde disponible"
            value={balance ? formatCents(balance.balanceCents) : '—'}
            unit={balance?.currency ?? ''}
            sub={balance ? `Compte ${balance.customerEmail}` : 'Chargement…'}
            icon={<span aria-hidden>💰</span>}
          />
          <Panel title="Recharger par virement" sub="Justificatif obligatoire — PNG, JPEG, WebP ou PDF (5 Mo max).">
            <form onSubmit={(e) => void submit(e)} className="row">
              <Field label="Montant (USD)" required htmlFor="wallet-amount">
                <Input
                  id="wallet-amount"
                  value={amount}
                  placeholder="50"
                  inputMode="decimal"
                  onChange={(e) => setAmount(e.target.value)}
                  className="input-sm"
                />
              </Field>
              <Field label="Justificatif" required htmlFor="wallet-proof">
                <input
                  id="wallet-proof"
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.pdf"
                  onChange={(e) => setProof(e.target.files?.[0] ?? null)}
                  style={{ fontSize: 13 }}
                />
              </Field>
              <Field label="Référence / note (optionnel)" htmlFor="wallet-note">
                <Input
                  id="wallet-note"
                  value={note}
                  placeholder="N° du virement…"
                  onChange={(e) => setNote(e.target.value)}
                  className="input-sm"
                />
              </Field>
              <div style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Envoi…' : 'Déposer le justificatif'}
                </Button>
              </div>
            </form>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Le dépôt n’augmente pas immédiatement le solde : il reste « en
              attente » jusqu’à validation. En cas de rejet, aucun montant n’est
              crédité.
            </p>
          </Panel>
        </div>

        <Panel
          title="Historique"
          sub={
            data
              ? `${data.total} mouvement${data.total > 1 ? 's' : ''} — page ${page}/${totalPages}`
              : 'Chargement…'
          }
        >
          {!data || data.items.length === 0 ? (
            <EmptyState>Aucun mouvement pour l’instant.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Référence</th>
                    <th>Note</th>
                    <th>Statut</th>
                    <th style={{ textAlign: 'right' }}>Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((tx) => (
                    <tr key={tx.id}>
                      <td className="nowrap">{new Date(tx.createdAt).toLocaleString()}</td>
                      <td className="nowrap">{WALLET_TYPE_LABEL[tx.type] ?? tx.type}</td>
                      <td className="nowrap mono">{tx.reference ?? '—'}</td>
                      <td className="muted">{tx.note ?? '—'}</td>
                      <td className="nowrap">
                        <Badge tone={WALLET_STATUS_TONE[tx.status] ?? 'neutral'}>
                          {WALLET_STATUS_LABEL[tx.status] ?? tx.status}
                        </Badge>
                      </td>
                      <td
                        className="nowrap"
                        style={{ textAlign: 'right', fontWeight: 600 }}
                      >
                        {tx.type === 'CREDIT' ? '+' : '−'}
                        {formatCents(tx.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <div className="row" style={{ marginTop: 12 }}>
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => changePage(page - 1)}
              >
                Précédent
              </Button>{' '}
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => changePage(page + 1)}
              >
                Suivant
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
