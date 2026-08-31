'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiError,
  fetchMe,
  getAccessToken,
  getMailSettings,
  MailSettings,
  Me,
  sendTestMail,
  updateMailSettings,
} from '../../../lib/api';

type Phase = 'loading' | 'denied' | 'ready';

const inputStyle: React.CSSProperties = { padding: '6px 8px', boxSizing: 'border-box', width: 280 };

// Phase 6 (ADR-022): SMTP configuration administrée. Le mot de passe n'est
// JAMAIS renvoyé par l'API (hasPassword seulement) — le champ reste vide à
// l'édition et « inchangé si vide » à l'enregistrement.
export default function ManagerMailPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
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
    (async () => {
      const t = await getAccessToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m || m.role !== 'ADMIN') {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
      void load(t);
    })();
  }, [router]);

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
      text: (
        (r.data as { message?: string })?.message ??
        `Email de test envoyé à ${testTo.trim()}.`
      ),
    });
  }

  if (phase !== 'ready') {
    const denied = phase === 'denied';
    return (
      <main style={{ maxWidth: 720, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Configuration mail (Phase 6)</h1>
        {denied ? (
          <p style={{ color: 'var(--danger)' }}>Accès refusé : réservé aux administrateurs.</p>
        ) : (
          <p className="muted">Connexion…</p>
        )}
        <p>
          <Link href={denied ? '/auth' : '/manager'}>← Retour</Link>
        </p>
      </main>
    );
  }

  const configured = !!(settings?.host || form.host.trim());

  return (
    <main style={{ maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Configuration mail (Phase 6)</h1>
      <p className="muted">
        ADR-022 — saisie du SMTP + envoi automatique des emails d&apos;invitation. Connecté en tant
        que {me?.email} · <Link href="/manager">← Retour au manager</Link>
      </p>

      {message && <p style={{ color: 'var(--ok, #1a7f37)' }}>{message}</p>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ marginBottom: 16 }}>
        <span
          className="card"
          style={{
            padding: '4px 10px',
            color: configured ? 'var(--ok, #1a7f37)' : 'var(--danger)',
          }}
        >
          {configured ? '● Configuré' : '● Non configuré'}
        </span>
        {settings?.hasPassword ? (
          <span className="muted" style={{ marginLeft: 8 }}>
            Mot de passe SMTP enregistré (chiffré) — champ vide = inchangé.
          </span>
        ) : (
          <span className="muted" style={{ marginLeft: 8 }}>
            Aucun mot de passe SMTP enregistré.
          </span>
        )}
      </div>

      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Activer l&apos;envoi automatique des emails d&apos;invitation
        </label>
        <label>
          Serveur SMTP (host) *
          <input
            type="text"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            style={inputStyle}
            placeholder="smtp.gmail.com"
          />
        </label>
        <label>
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
            style={{ ...inputStyle, width: 120 }}
          />
          <span className="muted" style={{ marginLeft: 8 }}>
            convention : 465 = TLS implicite, 587 = STARTTLS (défaut), 25 = SMTP
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={form.secure}
            onChange={(e) => setForm({ ...form, secure: e.target.checked })}
          />
          Connexion sécurisée (TLS implicite)
        </label>
        <label>
          Utilisateur (login)
          <input
            type="text"
            value={form.user}
            onChange={(e) => setForm({ ...form, user: e.target.value })}
            style={inputStyle}
            placeholder="optionnel — vide = effacé"
          />
        </label>
        <label>
          Mot de passe
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            placeholder="inchangé si vide — chiffré au repos (AES-256-GCM)"
          />
        </label>
        <label>
          Email expéditeur (from) *
          <input
            type="email"
            value={form.fromEmail}
            onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
            style={inputStyle}
            placeholder="no-reply@exemple.com"
          />
        </label>
        <label>
          Nom de l&apos;expéditeur
          <input
            type="text"
            value={form.fromName}
            onChange={(e) => setForm({ ...form, fromName: e.target.value })}
            style={inputStyle}
            placeholder="optionnel — iCode Host Pro"
          />
        </label>
        <div>
          <button type="submit">Enregistrer la configuration</button>
        </div>
      </form>

      <section style={{ marginTop: '2rem' }}>
        <h2>Envoyer un mail de test</h2>
        <p className="muted">
          Utilise la configuration enregistrée (même si l&apos;envoi automatique est désactivé).
        </p>
        <form onSubmit={sendTest} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label>
            Destinataire du test
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              style={inputStyle}
              placeholder="toi@exemple.com"
            />
          </label>
          <button type="submit">Envoyer un mail de test</button>
        </form>
        {testResult && (
          <p style={{ color: testResult.ok ? 'var(--ok, #1a7f37)' : 'var(--danger)', marginTop: 8 }}>
            {testResult.ok ? '✅ ' : '❌ '}
            {testResult.text}
          </p>
        )}
      </section>
    </main>
  );
}
