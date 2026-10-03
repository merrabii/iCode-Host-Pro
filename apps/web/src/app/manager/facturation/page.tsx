'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  getBillingSettings,
  updateBillingSettings,
  type BillingSettings,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Badge,
  Button,
  Denied,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Panel,
} from '@/components/ui';

const MAX_MENTIONS = 10;
const MAX_DUE_DAYS = 90;

/**
 * GO P7 (lot D1) — Paramètres de facturation (ADMIN) : identité de l'émetteur,
 * mentions légales (1 ligne = 1 mention, 10 max) et échéance de paiement
 * (`invoiceDueDays`, 0..90 j). **Tout est figé à l'émission** de chaque
 * facture (snapshot + PDF) : modifier ce formulaire ne modifie jamais les
 * factures déjà émises. Numérotation `AAAA-<seq>` conservée telle quelle —
 * remise à zéro annuelle = décision restante §6-6 (non implémentée).
 */
export default function ManagerBillingSettingsPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [form, setForm] = useState({
    companyName: '',
    companyAddress: '',
    companyTaxId: '',
    companyEmail: '',
    invoiceDueDays: 14,
    mentions: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  function apply(s: BillingSettings | null) {
    setSettings(s);
    setForm({
      companyName: s?.companyName ?? '',
      companyAddress: s?.companyAddress ?? '',
      companyTaxId: s?.companyTaxId ?? '',
      companyEmail: s?.companyEmail ?? '',
      invoiceDueDays: s?.invoiceDueDays ?? 14,
      mentions: (s?.legalMentions ?? []).join('\n'),
    });
  }

  async function load(t: string) {
    const r = await getBillingSettings(t);
    if (!r.ok) {
      toast.error(apiError(r, 'Impossible de charger les paramètres de facturation.'));
      return;
    }
    apply((r.data as BillingSettings) ?? null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    const days = Number(form.invoiceDueDays);
    if (!Number.isInteger(days) || days < 0 || days > MAX_DUE_DAYS) {
      toast.error(`Échéance de paiement : un entier entre 0 et ${MAX_DUE_DAYS} jours.`);
      return;
    }
    const lines = form.mentions
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > MAX_MENTIONS) {
      toast.error(`${MAX_MENTIONS} lignes de mentions maximum.`);
      return;
    }

    setSaving(true);
    const r = await updateBillingSettings(token, {
      companyName: form.companyName.trim(),
      companyAddress: form.companyAddress.trim(),
      companyTaxId: form.companyTaxId.trim(),
      companyEmail: form.companyEmail.trim(),
      invoiceDueDays: days,
      legalMentions: lines,
    });
    setSaving(false);
    if (!r.ok) {
      toast.error(apiError(r, 'Échec de l’enregistrement des paramètres.'));
      return;
    }
    apply((r.data as BillingSettings) ?? null);
    toast.ok('Paramètres de facturation enregistrés.');
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
          title="Paramètres de facturation"
          sub="Identité de l’émetteur, mentions légales et échéance de paiement des factures. Tout est figé à l’émission : les factures déjà émises (et leur PDF) ne sont jamais modifiés."
        />

        <div className="row mb">
          <Badge tone="blue">
            Prochain numéro : {new Date().getFullYear()}-
            {String(settings?.invoiceSequence ?? 1).padStart(4, '0')}
          </Badge>
          <span className="muted cell-sub">
            Échéance actuelle : {settings?.invoiceDueDays ?? 14} jour(s) après émission.
          </span>
        </div>

        <Panel
          title="Identité de l’émetteur"
          sub="Affiché sur chaque facture émise à partir de maintenant."
        >
          <form className="stack" onSubmit={save}>
            <Field label="Raison sociale" required>
              <Input
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                placeholder="Code Diali"
                maxLength={200}
              />
            </Field>

            <Field label="Adresse">
              <Input
                value={form.companyAddress}
                onChange={(e) => setForm({ ...form, companyAddress: e.target.value })}
                placeholder="voie, code postal, ville — optionnel"
                maxLength={500}
              />
            </Field>

            <div className="row-end">
              <Field label="N° de TVA / SIREN" className="flex-1">
                <Input
                  value={form.companyTaxId}
                  onChange={(e) => setForm({ ...form, companyTaxId: e.target.value })}
                  placeholder="FR00000000000 — optionnel"
                  maxLength={200}
                />
              </Field>
              <Field label="Email de facturation" className="flex-1">
                <Input
                  type="email"
                  value={form.companyEmail}
                  onChange={(e) => setForm({ ...form, companyEmail: e.target.value })}
                  placeholder="facture@exemple.com — vide = effacé"
                  maxLength={320}
                />
              </Field>
            </div>
          </form>
        </Panel>

        <div className="mt">
          <Panel
            title="Factures"
            sub="Échéance de paiement + mentions de pied de facture (figées à l’émission)."
          >
            <form className="stack" onSubmit={save}>
              <Field
                label="Échéance de paiement (jours après émission)"
                hint={`0 à ${MAX_DUE_DAYS} jours — la date d’échéance de chaque facture est calculée à son émission.`}
              >
                <Input
                  type="number"
                  min={0}
                  max={MAX_DUE_DAYS}
                  value={form.invoiceDueDays}
                  onChange={(e) =>
                    setForm({ ...form, invoiceDueDays: Number(e.target.value) })
                  }
                  style={{ maxWidth: 160 }}
                />
              </Field>

              <Field
                label="Mentions légales"
                hint={`${MAX_MENTIONS} lignes maximum — une mention par ligne. Ligne vide = retirée.`}
              >
                <textarea
                  className="input"
                  rows={5}
                  style={{ resize: 'vertical' }}
                  value={form.mentions}
                  onChange={(e) => setForm({ ...form, mentions: e.target.value })}
                  placeholder={'TVA acquittée sur les encaissements\nMentions propres à l’activité…'}
                />
              </Field>

              <div className="row">
                <Button type="submit" disabled={saving}>
                  {saving ? 'Enregistrement…' : 'Enregistrer les paramètres'}
                </Button>
              </div>
            </form>
          </Panel>
        </div>

        <div className="mt">
          <Panel title="À savoir">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }} className="stack">
              <li>
                Les mentions et l’échéance sont <b>figées à l’émission</b> de chaque
                facture : modifier ce formulaire n’altère ni les factures déjà
                émises, ni leur PDF téléchargé.
              </li>
              <li>
                La numérotation suit <b>AAAA-&lt;seq&gt;</b> sans interruption — la
                remise à zéro annuelle est une décision restante (§6-6 de l’audit
                socle) : non implémentée ici.
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
