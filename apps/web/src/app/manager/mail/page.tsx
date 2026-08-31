'use client';

import { useEffect, useState } from 'react';
import { apiError, getMailSettings, MailSettings, sendTestMail, updateMailSettings } from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Alert, Badge, Button, Denied, Field, Input, PageIntro, PageLoading, Panel } from '@/components/ui';

// Phase 6 (ADR-022): SMTP configuration administrée. Le mot de passe n'est
// JAMAIS renvoyé par l'API (hasPassword seulement) — le champ reste vide à
// l'édition et « inchangé si vide » à l'enregistrement.
export default function ManagerMailPage() {
  const { phase, me, token } = useAdminSession();
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    fromEmail: '',
    fromName: '',
  });
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function load(t: string) {
    setError(null);
    const r = await getMailSettings(t);
    if (!r.ok) {
      setError(apiError(r, 'Impossible de charger la configuration mail.'));
      return;
    }
    const s = (r.data as MailSettings) ?? null;
    setSettings(s);
    setForm({
      enabled: s?.enabled ?? false,
      host: s?.host ?? '',
      port: s?.port ?? 587,
      secure: s?.secure ?? false,
      user: s?.user ?? '',
      fromEmail: s?.fromEmail ?? '',
      fromName: s?.fromName ?? '',
    });
    setPassword('');
    setTestResult(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    // PATCH semantics : ''/absent = inchangé sur le serveur. user/fromName vides
    // sont normalisés '' → effacé. Le mot de passe n'est envoyé que s'il est rempli.
    const dto: Record<string, unknown> = {
      enabled: form.enabled,
      port: Number(form.port) || 587,
      secure: form.secure,
      user: form.user.trim(),
      fromName: form.fromName.trim(),
    };
    if (form.host.trim()) dto.host = form.host.trim();
    if (form.fromEmail.trim()) dto.fromEmail = form.fromEmail.trim();
    if (password.trim()) dto.password = password.trim();

    if (form.enabled && (!form.host.trim() || !form.fromEmail.trim())) {
      setError('Impossible d’activer l’envoi : host et fromEmail sont requis.');
      return;
    }
    // Première création : on exige host + fromEmail (sinon l'API refuse un host vide)
    if (!settings?.id && (!form.host.trim() || !form.fromEmail.trim())) {
      setError('Renseigne au moins host et fromEmail pour enregistrer la configuration.');
      return;
    }

    const r = await updateMailSettings(token, dto);
    if (!r.ok) {
      setError(apiError(r, 'Échec de l’enregistrement de la configuration mail.'));
      return;
    }
    setMessage('Configuration mail enregistrée.');
    void load(token);
  }

  async function sendTest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTestResult(null);
    if (!testTo.trim()) {
      setError('Renseigne un destinataire pour le mail de test.');
      return;
    }
    const r = await sendTestMail(token, testTo.trim());
    if (!r.ok) {
      setTestResult({ ok: false, text: apiError(r, 'Envoi du test échoué.') });
      return;
    }
    setTestResult({
      ok: true,
      text: (r.data as { message?: string })?.message ?? `Email de test envoyé à ${testTo.trim()}.`,
    });
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

  const configured = !!(settings?.host || form.host.trim());

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-sm">
        <PageIntro
          eyebrow="Administration"
          title="Configuration mail"
          sub="Saisie du serveur SMTP + envoi automatique des emails d’invitation (ADR-022). Le mot de passe est chiffré au repos et jamais réaffiché."
        />

        {message && <Alert tone="ok">{message}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <div className="row mb">
          <Badge tone={configured ? 'ok' : 'danger'}>{configured ? '● Configuré' : '● Non configuré'}</Badge>
          {settings?.hasPassword ? (
            <span className="muted cell-sub">Mot de passe SMTP enregistré (chiffré) — champ vide = inchangé.</span>
          ) : (
            <span className="muted cell-sub">Aucun mot de passe SMTP enregistré.</span>
          )}
        </div>

        <Panel title="Paramètres SMTP" sub="Utilisé pour envoyer les emails d’invitation et le mail de test.">
          <form className="stack" onSubmit={save}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Activer l&apos;envoi automatique des emails d&apos;invitation
            </label>

            <div className="row-end">
              <Field label="Serveur SMTP (host)" required className="flex-1">
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.gmail.com" />
              </Field>
              <Field label="Port" required className="input-sm">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </Field>
            </div>
            <span className="muted cell-sub">Ports usuels : 465 = TLS implicite · 587 = STARTTLS (défaut) · 25 = SMTP.</span>

            <label className="check-row">
              <input
                type="checkbox"
                checked={form.secure}
                onChange={(e) => setForm({ ...form, secure: e.target.checked })}
              />
              Connexion sécurisée (TLS implicite)
            </label>

            <Field label="Utilisateur (login)">
              <Input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="optionnel — vide = effacé" />
            </Field>

            <Field label="Mot de passe">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="inchangé si vide — chiffré au repos (AES-256-GCM)"
              />
            </Field>

            <div className="row-end">
              <Field label="Email expéditeur (from)" required className="flex-1">
                <Input type="email" value={form.fromEmail} onChange={(e) => setForm({ ...form, fromEmail: e.target.value })} placeholder="no-reply@exemple.com" />
              </Field>
              <Field label="Nom de l’expéditeur" className="flex-1">
                <Input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} placeholder="optionnel — iCode Host Pro" />
              </Field>
            </div>

            <div className="row">
              <Button type="submit">Enregistrer la configuration</Button>
            </div>
          </form>
        </Panel>

        <div className="mt">
          <Panel
            title="Envoyer un mail de test"
            sub="Utilise la configuration enregistrée (même si l’envoi automatique est désactivé)."
          >
            <form className="inline-form" onSubmit={sendTest}>
              <Field label="Destinataire du test" required>
                <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="toi@exemple.com" />
              </Field>
              <Button type="submit">Envoyer un mail de test</Button>
            </form>
            {testResult &&
              (testResult.ok ? (
                <Alert tone="ok" title="✅ Envoyé">
                  {testResult.text}
                </Alert>
              ) : (
                <Alert tone="error" title="❌ Échec">
                  {testResult.text}
                </Alert>
              ))}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
