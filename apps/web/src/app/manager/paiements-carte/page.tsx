'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  apiError,
  cancelCardRefund,
  CARD_PAYMENT_LABEL,
  CARD_PAYMENT_TONE,
  checkPaymentProvider,
  createCardRefund,
  getCardPaymentAdmin,
  getPaymentProvider,
  listCardPayments,
  listPaymentWebhookEvents,
  resolveCardIntervention,
  retryCardRefund,
  savePaymentProvider,
  type AdminCardPaymentDetail,
  type CardPaymentPage,
  type ProviderConfigView,
  type WebhookEventPage,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
  Select,
} from '@/components/ui';

type Phase = 'loading' | 'denied' | 'ready';

const PER_PAGE = 20;

const money = (cents: number, currency: string) =>
  `${(cents / 100).toFixed(2)} ${currency}`;

const REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En cours (à relancer si bloqué)',
  SUCCEEDED: 'Remboursé',
  FAILED: 'Échec (solde restitué)',
};

const REFUND_STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  PENDING: 'amber',
  SUCCEEDED: 'green',
  FAILED: 'red',
};

const EVENT_STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Reçu',
  PROCESSED: 'Traité',
  IGNORED: 'Ignoré',
  FAILED: 'Échec (à rejouer)',
};

/**
 * GO Stripe §2/§6/§7 — console d'administration des paiements carte (mode test) :
 * connecteur (secrets écrits-seuls, jamais relus), recherche de paiements avec
 * référence prestataire, remboursements plafonnés + idempotence, signalements,
 * et événements webhook. Aucune clé secrète n'est jamais réaffichée.
 */
export default function ManagerCardPaymentsPage() {
  const { phase: sessionPhase, me, token } = useAdminSession();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [provider, setProvider] = useState<ProviderConfigView | null>(null);
  const [data, setData] = useState<CardPaymentPage | null>(null);
  const [events, setEvents] = useState<WebhookEventPage | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminCardPaymentDetail | null>(null);

  // Formulaire connecteur — les secrets sont écrits-seuls (jamais pré-remplis).
  const [fDisplay, setFDisplay] = useState('');
  const [fActive, setFActive] = useState(false);
  const [fMerchant, setFMerchant] = useState('');
  const [fPub, setFPub] = useState('');
  const [fSecret, setFSecret] = useState('');
  const [fWhsec, setFWhsec] = useState('');

  // Remboursement.
  const [rfAmount, setRfAmount] = useState('');
  const [rfReason, setRfReason] = useState('');

  const load = useCallback(
    async (t: string, p: number, st: string, search: string) => {
      const [cfg, list, ev] = await Promise.all([
        getPaymentProvider(t),
        listCardPayments(t, {
          page: p,
          perPage: PER_PAGE,
          status: st || undefined,
          q: search.trim() || undefined,
        }),
        listPaymentWebhookEvents(t),
      ]);
      if (cfg.ok && cfg.data) {
        setProvider(cfg.data);
        const s = cfg.data.stripe;
        if (s) {
          setFDisplay(s.displayName);
          setFActive(s.isActive);
          setFMerchant(s.merchantAccount ?? '');
          setFPub(s.publishableKey ?? '');
        }
      }
      if (list.ok) setData(list.data);
      else toast.error(apiError(list, 'Impossible de charger les paiements.'));
      if (ev.ok) setEvents(ev.data);
    },
    [toast],
  );

  useEffect(() => {
    if (sessionPhase === 'loading') return;
    if (sessionPhase === 'denied') {
      setPhase('denied');
      return;
    }
    setPhase('ready');
    void load(token, 1, '', '');
  }, [sessionPhase, token, load]);

  const loadDetail = async (id: string) => {
    setSelectedId(id);
    const r = await getCardPaymentAdmin(token, id);
    if (r.ok && r.data) setDetail(r.data);
    else {
      setDetail(null);
      toast.error(apiError(r, 'Détail indisponible.'));
    }
  };

  const applyFilters = (st: string, search: string) => {
    setStatus(st);
    setQ(search);
    setPage(1);
    void load(token, 1, st, search);
  };

  const changePage = (p: number) => {
    setPage(p);
    void load(token, p, status, q);
  };

  const saveProvider = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await savePaymentProvider(token, {
      code: 'stripe',
      displayName: fDisplay.trim() || 'Stripe (test)',
      isActive: fActive,
      merchantAccount: fMerchant.trim() || undefined,
      publishableKey: fPub.trim() || undefined,
      secretKey: fSecret.trim() || undefined,
      webhookSecret: fWhsec.trim() || undefined,
      allowedCurrencies: ['USD', 'EUR'],
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(apiError(r, 'Enregistrement refusé.'));
      return;
    }
    setFSecret('');
    setFWhsec('');
    toast.ok('Connecteur enregistré (secrets chiffrés, jamais relus).');
    await load(token, page, status, q);
  };

  const checkProvider = async () => {
    setBusy(true);
    setCheckMsg(null);
    const r = await checkPaymentProvider(token);
    setBusy(false);
    if (!r.ok) {
      setCheckMsg(apiError(r, 'Test de connexion impossible.'));
      return;
    }
    const v = r.data;
    setCheckMsg(
      v?.simulated
        ? 'Simulateur local opérationnel (aucun appel réseau).'
        : `Connexion ${v?.code ?? 'stripe'} OK — compte ${v?.lastCheckAccount ?? '—'} (${v?.environment ?? 'test'}).`,
    );
    await load(token, page, status, q);
  };

  const refund = async () => {
    if (!detail) return;
    const value = Number(rfAmount.trim().replace(',', '.'));
    const cents = Math.round(value * 100);
    if (!rfAmount.trim() || !Number.isFinite(value) || value <= 0 || cents < 1) {
      toast.warn('Montant de remboursement invalide.');
      return;
    }
    if (
      !window.confirm(
        `Rembourser ${money(cents, detail.currency)} vers la carte du client (réf. ${detail.reference}) ?`,
      )
    ) {
      return;
    }
    setBusy(true);
    const r = await createCardRefund(token, detail.id, {
      amountCents: cents,
      reason: rfReason.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(apiError(r, 'Remboursement impossible.'));
      return;
    }
    toast.ok('Remboursement enregistré (traitement côté prestataire).');
    setRfAmount('');
    setRfReason('');
    await loadDetail(detail.id);
    await load(token, page, status, q);
  };

  const retryRefund = async (id: string) => {
    setBusy(true);
    const r = await retryCardRefund(token, id);
    setBusy(false);
    if (!r.ok) toast.error(apiError(r, 'Reprise impossible.'));
    else toast.ok('Relance effectuée.');
    if (detail) await loadDetail(detail.id);
  };

  const cancelRefund = async (id: string) => {
    const reason = window.prompt('Motif de l’annulation de l’intention de remboursement :');
    if (reason === null) return;
    setBusy(true);
    const r = await cancelCardRefund(token, id, reason.trim() || undefined);
    setBusy(false);
    if (!r.ok) toast.error(apiError(r, 'Annulation impossible.'));
    else toast.ok('Intention annulée — le crédit réservé est restitué.');
    if (detail) await loadDetail(detail.id);
  };

  const resolveIntervention = async () => {
    if (!detail) return;
    const note = window.prompt(
      'Note de vérification (levée du signalement) — décrire ce qui a été vérifié :',
    );
    if (note === null) return;
    if (note.trim().length < 3) {
      toast.warn('Note trop courte.');
      return;
    }
    setBusy(true);
    const r = await resolveCardIntervention(token, detail.id, note.trim());
    setBusy(false);
    if (!r.ok) toast.error(apiError(r, 'Lèvement impossible.'));
    else toast.ok('Signalement levé.');
    await loadDetail(detail.id);
    await load(token, page, status, q);
  };

  if (sessionPhase === 'loading' || phase === 'loading') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <PageLoading />
      </AppShell>
    );
  }
  if (sessionPhase === 'denied' || phase === 'denied') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <EmptyState>Accès réservé aux administrateurs.</EmptyState>
      </AppShell>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const stripe = provider?.stripe ?? null;
  const simulated = provider?.simulated ?? null;

  return (
    <AppShell
      me={me}
      nav={ADMIN_NAV}
      tenant={{ label: 'Administration' }}
      activeHref="/manager/paiements-carte"
    >
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Paiements carte (test)"
          sub="Recharges par carte en mode test : connecteur, recherche, remboursements et événements webhook. Aucune activation réelle possible depuis cet écran et aucune clé secrète n'est jamais réaffichée."
        />

        <Panel
          title="Connecteur Stripe (mode test)"
          sub={
            stripe
              ? `Actif : ${stripe.isActive ? 'oui' : 'non'} · environnement ${stripe.environment} · compte marchand ${stripe.merchantAccount ?? '—'}`
              : 'Aucun connecteur configuré.'
          }
        >
          {provider && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              Endpoint webhook à déposer chez le prestataire :{' '}
              <span className="mono">{provider.endpointUrl}</span> — {provider.note}
            </p>
          )}
          <form onSubmit={(e) => void saveProvider(e)}>
            <div className="row">
              <Field label="Libellé" htmlFor="sp-name">
                <Input
                  id="sp-name"
                  value={fDisplay}
                  onChange={(e) => setFDisplay(e.target.value)}
                  className="input-sm"
                  placeholder="Stripe (test)"
                />
              </Field>
              <Field label="Compte marchand" htmlFor="sp-merchant">
                <Input
                  id="sp-merchant"
                  value={fMerchant}
                  onChange={(e) => setFMerchant(e.target.value)}
                  className="input-sm"
                  placeholder="acct_…"
                />
              </Field>
              <Field
                label="Clé publiable"
                htmlFor="sp-pub"
                hint={stripe?.publishableKey ? `Enregistrée : ${stripe.publishableKey}` : 'Non renseignée.'}
              >
                <Input
                  id="sp-pub"
                  value={fPub}
                  onChange={(e) => setFPub(e.target.value)}
                  className="input-sm"
                  placeholder="pk_test_…"
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="row">
              <Field
                label="Clé secrète"
                htmlFor="sp-secret"
                hint={
                  stripe?.hasSecretKey
                    ? 'Une clé est déjà enregistrée (chiffrée) — laisser vide pour la conserver.'
                    : 'Aucune clé enregistrée (obligatoire pour les appels API).'
                }
              >
                <Input
                  id="sp-secret"
                  type="password"
                  value={fSecret}
                  onChange={(e) => setFSecret(e.target.value)}
                  className="input-sm"
                  placeholder={stripe?.hasSecretKey ? '•••••••• (conserver)' : 'sk_test_…'}
                  autoComplete="new-password"
                />
              </Field>
              <Field
                label="Secret de signature webhook"
                htmlFor="sp-whsec"
                hint={
                  stripe?.hasWebhookSecret
                    ? 'Secret déjà enregistré (chiffré) — laisser vide pour le conserver.'
                    : 'Requis pour valider la signature des événements.'
                }
              >
                <Input
                  id="sp-whsec"
                  type="password"
                  value={fWhsec}
                  onChange={(e) => setFWhsec(e.target.value)}
                  className="input-sm"
                  placeholder={stripe?.hasWebhookSecret ? '•••••••• (conserver)' : 'whsec_…'}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Connecteur actif" htmlFor="sp-active">
                <Select
                  id="sp-active"
                  value={fActive ? '1' : '0'}
                  onChange={(e) => setFActive(e.target.value === '1')}
                  className="select-sm"
                >
                  <option value="1">Actif</option>
                  <option value="0">Inactif</option>
                </Select>
              </Field>
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <Button type="submit" size="sm" disabled={busy}>
                Enregistrer
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void checkProvider()}
              >
                Tester la connexion
              </Button>
            </div>
          </form>
          {checkMsg && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {checkMsg}
            </p>
          )}
          {!stripe?.isActive && (
            <Alert tone="warn" title="Connecteur inactif">
              {simulated?.isActive
                ? 'Stripe inactif : le simulateur local sert les paiements tant qu’il est autorisé (aucun appel réseau, aucun réel encaissement).'
                : 'Aucun connecteur actif : la création de recharge carte est refusée (409) tant que la configuration n’est pas faite.'}
            </Alert>
          )}
        </Panel>

        <div className="grid-2 mb">
          <Panel
            title="Paiements carte"
            sub={data ? `${data.total} paiement(s) pour ce filtre` : 'Chargement…'}
          >
            <form
              className="row"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                applyFilters(status, q);
              }}
            >
              <Field label="Statut" htmlFor="cp-status">
                <Select
                  id="cp-status"
                  value={status}
                  onChange={(e) => applyFilters(e.target.value, q)}
                  className="select-sm"
                >
                  <option value="">Tous</option>
                  {Object.keys(CARD_PAYMENT_LABEL).map((s) => (
                    <option key={s} value={s}>
                      {CARD_PAYMENT_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Recherche" htmlFor="cp-q">
                <Input
                  id="cp-q"
                  value={q}
                  placeholder="Référence, référence prestataire ou client…"
                  onChange={(e) => setQ(e.target.value)}
                  className="input-sm"
                />
              </Field>
              <div style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
                <Button type="submit" size="sm" variant="secondary">
                  Filtrer
                </Button>
              </div>
            </form>
          </Panel>
          <Panel title="Événements webhook" sub={events ? `${events.total} reçu(s) · ${events.failed} en échec` : 'Chargement…'}>
            {!events || events.items.length === 0 ? (
              <EmptyState>Aucun événement reçu pour l’instant.</EmptyState>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reçu</th>
                      <th>Type</th>
                      <th>État</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.items.slice(0, 20).map((ev) => (
                      <tr key={ev.id}>
                        <td className="nowrap" style={{ fontSize: 12 }}>
                          {new Date(ev.receivedAt).toLocaleString()}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {ev.type}
                          {ev.cardPaymentId && (
                            <div className="muted">paiement lié</div>
                          )}
                        </td>
                        <td className="nowrap">
                          <Badge
                            tone={
                              ev.status === 'FAILED'
                                ? 'red'
                                : ev.status === 'PROCESSED'
                                  ? 'green'
                                  : ev.status === 'IGNORED'
                                    ? 'neutral'
                                    : 'amber'
                            }
                          >
                            {EVENT_STATUS_LABEL[ev.status] ?? ev.status}
                          </Badge>
                          {ev.error && (
                            <div className="muted" style={{ fontSize: 11 }}>
                              {ev.error.slice(0, 80)}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Rechercher / ouvrir">
          {!data || data.items.length === 0 ? (
            <EmptyState>Aucun paiement carte pour ce filtre.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Créé le</th>
                    <th>Client</th>
                    <th>Référence</th>
                    <th>Réf. prestataire</th>
                    <th style={{ textAlign: 'right' }}>Montant</th>
                    <th>Statut</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                      <td className="nowrap">{row.customerEmail ?? '—'}</td>
                      <td className="nowrap mono">{row.reference}</td>
                      <td className="nowrap mono" style={{ fontSize: 12 }}>
                        {row.providerPaymentRef ?? row.providerSessionRef ?? '—'}
                      </td>
                      <td className="nowrap" style={{ textAlign: 'right', fontWeight: 600 }}>
                        {money(row.amountCents, row.currency)}
                        {row.refundedCents > 0 && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            remboursé {money(row.refundedCents, row.currency)}
                          </div>
                        )}
                      </td>
                      <td className="nowrap">
                        <Badge tone={CARD_PAYMENT_TONE[row.status] ?? 'neutral'}>
                          {CARD_PAYMENT_LABEL[row.status] ?? row.status}
                        </Badge>
                        {row.interventionNeeded && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            intervention requise
                          </div>
                        )}
                      </td>
                      <td className="nowrap" style={{ textAlign: 'right' }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void loadDetail(row.id)}
                        >
                          Ouvrir
                        </Button>
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

        {detail && (
          <Panel
            title={`Paiement ${detail.reference}`}
            sub={`${detail.customerEmail ?? '—'} · créé le ${new Date(detail.createdAt).toLocaleString()} · ${detail.environment}`}
          >
            <div className="grid-2 mb">
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Statut</span>
                  <Badge tone={CARD_PAYMENT_TONE[detail.status] ?? 'neutral'}>
                    {CARD_PAYMENT_LABEL[detail.status] ?? detail.status}
                  </Badge>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Montant</span>
                  <b>{money(detail.amountCents, detail.currency)}</b>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Remboursé</span>
                  <b>{money(detail.refundedCents, detail.currency)}</b>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Référence prestataire</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {detail.providerPaymentRef ?? detail.providerSessionRef ?? '—'}
                  </span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Session / intent</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {detail.providerSessionRef ?? '—'}
                  </span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Marchand</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {detail.merchantAccount}
                  </span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Transaction portefeuille</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {detail.walletTransactionId ?? '—'}
                  </span>
                </div>
                {detail.failureMessage && (
                  <p className="muted" style={{ fontSize: 12 }}>
                    {detail.failureMessage}
                  </p>
                )}
              </div>
              <div>
                {detail.interventionNeeded && (
                  <Alert tone="error" title="Intervention requise">
                    {detail.interventionReason ?? 'Signalement ouvert.'}
                    <div style={{ marginTop: 6 }}>
                      <Button size="sm" disabled={busy} onClick={() => void resolveIntervention()}>
                        Lever le signalement (après vérification)
                      </Button>
                    </div>
                  </Alert>
                )}
                {detail.disputedAt && (
                  <Alert tone="warn" title="Litige carte">
                    Signalé le {new Date(detail.disputedAt).toLocaleString()} — solde
                    inchangé jusqu’à vérification.
                  </Alert>
                )}
                <Field
                  label="Rembourser (montant)"
                  htmlFor="rf-amount"
                  hint={
                    detail.currency
                      ? `Plafond restant : ${money(
                          Math.max(0, detail.amountCents - detail.refundedCents),
                          detail.currency,
                        )} — le crédit déjà dépensé est refusé (pas de dette silencieuse).`
                      : undefined
                  }
                >
                  <Input
                    id="rf-amount"
                    value={rfAmount}
                    placeholder="10.00"
                    inputMode="decimal"
                    onChange={(e) => setRfAmount(e.target.value)}
                    className="input-sm"
                  />
                </Field>
                <Field label="Motif (optionnel)" htmlFor="rf-reason">
                  <Input
                    id="rf-reason"
                    value={rfReason}
                    onChange={(e) => setRfReason(e.target.value)}
                    className="input-sm"
                    placeholder="Remboursement partiel demandé par le client."
                  />
                </Field>
                <Button
                  size="sm"
                  disabled={busy || detail.status === 'NEEDS_REVIEW'}
                  onClick={() => void refund()}
                >
                  Rembourser vers la carte
                </Button>
                <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Le remboursement est réservé sur le portefeuille AVANT l’appel
                  prestataire : en cas d’échec définitif, le crédit est restitué.
                </p>
              </div>
            </div>

            <h3 style={{ fontSize: 14, margin: '4px 0 8px' }}>Remboursements</h3>
            {detail.refunds.length === 0 ? (
              <EmptyState>Aucun remboursement.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Créé</th>
                      <th>Statut</th>
                      <th style={{ textAlign: 'right' }}>Montant</th>
                      <th>Réf. prestataire</th>
                      <th>Motif / échec</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.refunds.map((rf) => (
                      <tr key={rf.id}>
                        <td className="nowrap">
                          {new Date(rf.createdAt).toLocaleString()}
                        </td>
                        <td className="nowrap">
                          <Badge tone={REFUND_STATUS_TONE[rf.status] ?? 'neutral'}>
                            {REFUND_STATUS_LABEL[rf.status] ?? rf.status}
                          </Badge>
                        </td>
                        <td className="nowrap" style={{ textAlign: 'right' }}>
                          {money(rf.amountCents, rf.currency)}
                        </td>
                        <td className="nowrap mono" style={{ fontSize: 12 }}>
                          {rf.providerRef ?? '—'}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {rf.failureReason ?? rf.reason ?? '—'}
                        </td>
                        <td className="nowrap" style={{ textAlign: 'right' }}>
                          {rf.status === 'PENDING' && (
                            <>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void retryRefund(rf.id)}
                              >
                                Relancer
                              </Button>{' '}
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={() => void cancelRefund(rf.id)}
                              >
                                Annuler
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
