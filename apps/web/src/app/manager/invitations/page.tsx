'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createInvitation,
  inviteLink,
  Invitation,
  listInvitations,
  revokeInvitation,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Alert,
  Badge,
  Button,
  Denied,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
} from '@/components/ui';
import { IconCopy, IconKey } from '@/components/icons';

const STATUS_LABEL: Record<string, string> = {
  pending: 'En attente',
  used: 'Utilisée',
  revoked: 'Révoquée',
  expired: 'Expirée',
};

const STATUS_TONE: Record<string, 'ok' | 'neutral' | 'danger'> = {
  pending: 'ok',
  used: 'neutral',
  revoked: 'danger',
  expired: 'danger',
};

export default function ManagerInvitationsPage() {
  const { phase, me, token } = useAdminSession();
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<{
    email: string;
    token: string;
    link: string;
    emailSent: boolean;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(t: string) {
    setError(null);
    const r = await listInvitations(t);
    if (!r.ok) {
      setError(apiError(r, 'Impossible de charger les invitations.'));
      return;
    }
    setInvites((r.data as Invitation[]) ?? []);
  }

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    const r = await createInvitation(token, email.trim());
    if (!r.ok) {
      setError(apiError(r, 'Échec de la création de l’invitation.'));
      return;
    }
    const inv = r.data as { email: string; token: string; emailSent?: boolean };
    const emailSent = !!inv.emailSent;
    setEmail('');
    setCreated({ email: inv.email, token: inv.token, link: inviteLink(inv.token, inv.email), emailSent });
    setMessage(
      emailSent
        ? `Invitation créée — l’email d’invitation a été envoyé à ${inv.email}. Le lien reste copiable en secours.`
        : 'Invitation créée. Configuration mail absente ou envoi échoué : lien affiché manuellement.',
    );
    void load(token);
  }

  async function revoke(id: string) {
    setError(null);
    const r = await revokeInvitation(token, id);
    if (!r.ok) {
      setError(apiError(r, 'Échec de la révocation.'));
      return;
    }
    setMessage('Invitation révoquée.');
    void load(token);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('Lien copié dans le presse-papiers.');
      setError(null);
    } catch {
      setMessage(null);
      setError('Impossible de copier automatiquement — sélectionne le texte.');
    }
  }

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <Denied />
      </AppShell>
    );
  }

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-sm">
        <PageIntro
          eyebrow="Administration"
          title="Invitations"
          sub="L’inscription libre est fermée (ADR-020) : un compte se crée uniquement par invitation à une adresse email."
        />

        {message && <Alert tone="ok">{message}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <Panel title="Créer une invitation" sub="Envoie un email si la configuration mail est active ; sinon le lien est affiché ici.">
          <form className="inline-form" onSubmit={submit}>
            <Field label="Email à inviter" required>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="client@exemple.com"
              />
            </Field>
            <Button type="submit">Créer l&apos;invitation</Button>
          </form>

          {created && (
            <div className="stack mb mt">
              {created.emailSent ? (
                <Alert tone="ok" title="Email d’invitation envoyé">
                  à {created.email}.
                </Alert>
              ) : (
                <Alert tone="warn" title="Envoi automatique absent ou en échec">
                  transmets ce lien manuellement (configure le SMTP dans « Configuration mail »).
                </Alert>
              )}
              <div className="alert">
                <b>{created.emailSent ? 'Lien de secours à transmettre à ' : 'Lien à transmettre à '}{created.email} :</b>
                <div className="row mt-sm">
                  <Input readOnly value={window.location.origin + created.link} className="input-mono flex-1" />
                  <Button size="sm" variant="secondary" onClick={() => copy(window.location.origin + created.link)}>
                    <IconCopy size={14} />
                    Copier le lien
                  </Button>
                </div>
                <div className="muted cell-sub mt-sm">
                  <IconKey size={12} /> Jeton à usage unique : <code>{created.token}</code>
                </div>
              </div>
            </div>
          )}
        </Panel>

        <div className="mt">
          <Panel
            title="Invitations émises"
            sub={invites.length > 0 ? `${invites.length} invitation(s)` : undefined}
          >
            {invites.length === 0 ? (
              <EmptyState>Aucune invitation pour l’instant.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Statut</th>
                      <th>Expire le</th>
                      <th className="ta-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((inv) => (
                      <tr key={inv.id}>
                        <td className="cell-title">{inv.email}</td>
                        <td>
                          <Badge tone={STATUS_TONE[inv.status] ?? 'neutral'}>{STATUS_LABEL[inv.status] ?? inv.status}</Badge>
                        </td>
                        <td className="muted nowrap">{new Date(inv.expiresAt).toLocaleDateString()}</td>
                        <td className="ta-right">
                          {inv.status === 'pending' && (
                            <Button size="sm" variant="danger" onClick={() => revoke(inv.id)}>
                              Révoquer
                            </Button>
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
      </div>
    </AppShell>
  );
}
