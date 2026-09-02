'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Badge, Button, EmptyState, PageIntro } from '@/components/ui';
import { useToast } from '@/components/toast';
import { brand } from '@/config/brand';
import {
  apiError,
  createCheckoutIntent,
  listPublicProducts,
  type PublicProduct,
} from '@/lib/api';

export default function OffresPage() {
  const router = useRouter();
  const toast = useToast();
  const [products, setProducts] = useState<PublicProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await listPublicProducts();
      if (!res.ok) {
        setError(apiError(res, 'Impossible de charger le catalogue.'));
        return;
      }
      setProducts((res.data as PublicProduct[]) ?? []);
    })();
  }, []);

  async function commander(p: PublicProduct) {
    setError(null);
    const res = await createCheckoutIntent(p.id);
    if (!res.ok) {
      toast.error(apiError(res, 'Commande indisponible pour ce produit.'));
      return;
    }
    toast.ok('Catalogue validé — choisissez comment créer votre compte.');
    const q = new URLSearchParams({ register: '1', product: p.name });
    router.push(`/auth?${q.toString()}`);
  }

  return (
    <AppShell me={null} nav={[]} bare>
      <div className="auth-card">
        <PageIntro
          eyebrow="Catalogue public"
          title={`Offres ${brand.name}`}
          sub="Consultez nos services et passez votre commande. Votre compte est créé à ce moment-là — via Google, GitHub ou email et mot de passe."
        />
        {error && (
          <div className="alert error" style={{ fontSize: 13.5 }}>
            {error}
          </div>
        )}
        {!products && !error && (
          <div className="mt">
            <EmptyState title="Chargement du catalogue…" />
          </div>
        )}
        {products && products.length === 0 && (
          <div className="mt">
            <EmptyState title="Aucune offre disponible pour le moment." />
          </div>
        )}
        <div className="grid" style={{ marginTop: 16 }}>
          {products?.map((p) => (
            <div key={p.id} className="panel">
              <div className="panel-head">
                <div className="flex-1">
                  <div className="panel-title">{p.name}</div>
                  <div className="panel-sub">{p.kind}</div>
                </div>
                <Badge tone={p.status === 'ACTIVE' ? 'ok' : p.status === 'PENDING' ? 'warn' : 'neutral'}>
                  {p.status}
                </Badge>
              </div>
              <div className="panel-body row" style={{ justifyContent: 'space-between' }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  Souscription mensuelle
                </span>
                <Button onClick={() => commander(p)} disabled={p.status !== 'ACTIVE'}>
                  Commander
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="auth-meta">
          <Button variant="secondary" onClick={() => router.push('/auth')}>
            J’ai déjà un compte — se connecter
          </Button>
        </div>
      </div>
    </AppShell>
  );
}