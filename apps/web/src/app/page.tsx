'use client';

import { useEffect, useState } from 'react';

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
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>iCode Host Pro — diagnostic</h1>
      <p>
        <a href="/auth">→ Authentication (Phase 1)</a>
        {' · '}
        <a href="/manager">→ Manager (Phase 2)</a>
      </p>
      <p className="muted">
        Frontend ↔ API connectivity check (Phase 0 socle).
      </p>
      <p className="muted">
        API URL: <code>{API_URL}</code>
      </p>

      {health ? (
        <pre>{JSON.stringify(health, null, 2)}</pre>
      ) : error ? (
        <p style={{ color: 'var(--danger)' }}>API unreachable: {error}</p>
      ) : (
        <p className="muted">Checking…</p>
      )}
    </main>
  );
}