'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, PageIntro, Panel } from '@/components/ui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Health {
  status: string;
  database: string;
  timestamp: string;
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => setHealth(data as Health))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <AppShell me={null} nav={[]} bare>
      <div className="wrap-sm">
        <PageIntro
          eyebrow="Diagnostic"
          title="Socle iCode Host Pro"
          sub="Contrôle de connectivité Frontend ↔ API (Phase 0). URL de l’API :"
        />
        <code className="muted">{API_URL}</code>

        <Panel title="Santé de l’API" sub="Réponse de /api/health">
          {health ? (
            <div className="stack">
              <div className="row">
                <Badge tone={health.status === 'ok' ? 'ok' : 'danger'}>API {health.status}</Badge>
                <Badge tone={health.database === 'up' ? 'ok' : 'danger'}>DB {health.database}</Badge>
              </div>
              <pre>{JSON.stringify(health, null, 2)}</pre>
            </div>
          ) : error ? (
            <Alert tone="error" title="API injoignable">
              {error}
            </Alert>
          ) : (
            <div className="page-loading">
              <span className="spinner" />
              Vérification…
            </div>
          )}
        </Panel>

        <div className="row mt">
          <a className="btn-primary" href="/auth">Connexion</a>
          <a className="btn-secondary" href="/manager">Console admin</a>
          <a className="btn-secondary" href="/client">Espace client</a>
        </div>
      </div>
    </AppShell>
  );
}
