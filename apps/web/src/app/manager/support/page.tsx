'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, EmptyState, Field, Input, PageIntro, PageLoading, Select } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Turnstile } from '@/components/turnstile';
import { SUPPORT_NAV } from '@/config/nav';
import { roleRank, useSupportSession } from '@/lib/session';
import {
  addTicketMessage,
  apiError,
  escalateTicket,
  getPublicAuthConfig,
  listSupportTickets,
  setImpToken,
  supportRedeem,
  updateTicketStatus,
  type PublicAuthConfig,
  type Ticket,
  type TicketStatus,
} from '@/lib/api';

type Tone = 'ok' | 'info' | 'warn' | 'violet' | 'neutral' | 'danger';
const STATUS_TONE: Record<TicketStatus, Tone> = {
  OPEN: 'info',
  IN_PROGRESS: 'warn',
  WAITING_CLIENT: 'violet',
  RESOLVED: 'ok',
  CLOSED: 'neutral',
};

const STATUS_OPTIONS: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED'];

export default function SupportPage() {
  const router = useRouter();
  const toast = useToast();
  const { phase, me, token } = useSupportSession();

  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [config, setConfig] = useState<PublicAuthConfig | null>(null);

  // Zone « code d'accès client » (L2+).
  const l2 = !!me && roleRank(me.role) >= roleRank('SUPPORT_L2');
  const [accessCode, setAccessCode] = useState('');
  const [accessTurnstile, setAccessTurnstile] = useState('');
  const [accessBusy, setAccessBusy] = useState(false);

  const loadQueue = useCallback(async () => {
    if (!token) return;
    const res = await listSupportTickets(token);
    if (res.ok) setTickets((res.data as Ticket[]) ?? []);
    else toast.error(apiError(res, 'Chargement de la file impossible.'));
  }, [token, toast]);

  useEffect(() => {
    if (phase === 'ready') loadQueue();
  }, [phase, loadQueue]);

  useEffect(() => {
    getPublicAuthConfig().then((c) => setConfig(c));
  }, []);

  useEffect(() => {
    setSelectedId((cur) => (cur && tickets?.some((t) => t.id === cur) ? cur : (tickets && tickets[0]?.id) ?? null));
  }, [tickets]);

  if (phase === 'loading') return <PageLoading label="Chargement du support…" />;
  if (phase === 'denied' || !me || !token) {
    return (
      <AppShell me={null} nav={SUPPORT_NAV} bare={false}>
        <div className="wrap-md">
          <Alert tone="error" title="Accès refusé">Réservé au support (L1 et supérieur).</Alert>
        </div>
      </AppShell>
    );
  }

  const selected = tickets?.find((t) => t.id === selectedId) ?? null;
  const isAdminLike = roleRank(me.role) >= roleRank('SUPPORT_L3');

  async function sendReply() {
    if (!selected || !reply.trim()) return;
    const res = await addTicketMessage(token, selected.id, reply.trim());
    if (!res.ok) {
      toast.error(apiError(res, 'Réponse impossible.'));
      return;
    }
    setReply('');
    toast.ok('Message ajouté.');
    loadQueue();
  }

  async function doEscalate(to: 'SUPPORT_L2' | 'SUPPORT_L3') {
    if (!selected) return;
    const res = await escalateTicket(token, selected.id, to);
    if (!res.ok) {
      toast.error(apiError(res, 'Escalade impossible.'));
      return;
    }
    toast.ok(`Ticket escaladé vers ${to === 'SUPPORT_L2' ? 'L2' : 'L3'}.`);
    loadQueue();
  }

  async function doStatus(status: TicketStatus) {
    if (!selected) return;
    const res = await updateTicketStatus(token, selected.id, status);
    if (!res.ok) {
      toast.error(apiError(res, 'Changement de statut impossible.'));
      return;
    }
    toast.ok(`Statut → ${status}.`);
    loadQueue();
  }

  async function redeemCode() {
    if (!accessCode.trim()) return;
    setAccessBusy(true);
    try {
      const res = await supportRedeem(token, accessCode.trim(), config?.turnstileSiteKey ? accessTurnstile || undefined : undefined);
      if (!res.ok) {
        toast.error(apiError(res, 'Code invalide ou restreint.'));
        return;
      }
      const d = res.data as { accessToken: string };
      setImpToken(d.accessToken);
      toast.ok('Accès en tant que client ouvert (lecture seule).');
      router.push('/client');
    } finally {
      setAccessBusy(false);
    }
  }

  return (
    <AppShell me={me} nav={SUPPORT_NAV}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Console de support"
          title="File de tickets"
          sub="Répondez, changez le statut et escaladez les demandes. Tout est audité."
        />

        {l2 && (
          <div className="panel mb">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">Accès en tant que client</div>
                <div className="panel-sub">
                  Saisissez le code 6 chiffres généré par le client pour consulter son espace en lecture seule.
                </div>
              </div>
            </div>
            <div className="panel-body">
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  redeemCode();
                }}
              >
                <div className="inline-form">
                  <Field label="Code d'accès (6 chiffres)">
                    <Input
                      inputMode="numeric"
                      maxLength={6}
                      value={accessCode}
                      onChange={(e) => setAccessCode(e.target.value)}
                      className="input-mono"
                    />
                  </Field>
                  <Button type="submit" disabled={accessBusy || !accessCode.trim()}>
                    Ouvrir l'accès
                  </Button>
                </div>
                {config?.turnstileSiteKey && (
                  <Turnstile siteKey={config.turnstileSiteKey} onChange={setAccessTurnstile} />
                )}
              </form>
            </div>
          </div>
        )}

        <div className="card-grid">
          {/* File de tickets */}
          <div className="panel">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">Tickets</div>
                <div className="panel-sub">{tickets?.length ?? 0} dans la file</div>
              </div>
            </div>
            <div className="panel-body stack" style={{ maxHeight: 480, overflowY: 'auto' }}>
              {!tickets && <EmptyState title="Chargement…" />}
              {tickets && tickets.length === 0 && <EmptyState title="Aucun ticket." />}
              {tickets?.map((t) => (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  className={`panel ${selectedId === t.id ? 'panel-active' : ''}`}
                  onClick={() => setSelectedId(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelectedId(t.id);
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="panel-head" style={{ padding: '12px 14px' }}>
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div className="panel-title" style={{ fontSize: 13.5, whiteSpace: 'normal' }}>
                        {t.subject}
                      </div>
                      <div className="panel-sub" style={{ fontSize: 11.5 }}>
                        {t.user?.email}
                      </div>
                    </div>
                    <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Détail du ticket sélectionné */}
          <div className="panel">
            <div className="panel-head">
              <div className="flex-1">
                <div className="panel-title">{selected ? selected.subject : 'Sélectionnez un ticket'}</div>
                {selected && (
                  <div className="panel-sub">
                    {selected.user?.email} · ouvert le {new Date(selected.createdAt).toLocaleString()}
                    {selected.escalatedTo && ` · escaladé vers ${selected.escalatedTo}`}
                  </div>
                )}
              </div>
              {selected && <Badge tone={STATUS_TONE[selected.status] ?? 'neutral'}>{selected.status}</Badge>}
            </div>
            <div className="panel-body stack" style={{ maxHeight: 560, overflowY: 'auto' }}>
              {selected ? (
                <>
                  <div className="stack">
                    {selected.messages?.map((m) => (
                      <div key={m.id} className="ticket-msg">
                        <div className="row" style={{ gap: 8 }}>
                          <b style={{ fontSize: 12.5 }}>{m.authorEmail}</b>
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {new Date(m.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="mt-sm" style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
                          {m.body}
                        </div>
                      </div>
                    ))}
                  </div>

                  <Field label="Réponse">
                    <Input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Rédigez votre réponse…" />
                  </Field>
                  <Button onClick={sendReply} disabled={!reply.trim()}>
                    Répondre
                  </Button>

                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="row">
                      {roleRank(me.role) >= roleRank('SUPPORT_L1') && selected.status !== 'CLOSED' && (
                        <>
                          <Button variant="secondary" size="sm" onClick={() => doEscalate('SUPPORT_L2')}>
                            Escalader vers L2
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => doEscalate('SUPPORT_L3')}>
                            Escalader vers L3
                          </Button>
                        </>
                      )}
                    </div>
                    <div className="row">
                      <Select
                        value={selected.status}
                        onChange={(e) => doStatus(e.target.value as TicketStatus)}
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  {isAdminLike && (
                    <p className="muted" style={{ fontSize: 12 }}>
                      Rang L3 — vous disposez aussi des vues administration (lecture seule).
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title="Aucun ticket sélectionné." />
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}