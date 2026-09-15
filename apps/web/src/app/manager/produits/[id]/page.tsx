'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Denied, EmptyState, PageIntro, PageLoading } from '@/components/ui';
import { ProductEditor } from '@/components/admin/product-editor';
import {
  apiError,
  getProduct,
  listCategories,
  listDeploymentModules,
  listPacks,
  type DeploymentModule,
  type PackAdmin,
  type ProductAdmin,
  type ProductCategory,
} from '@/lib/api';
import { IconChevronLeft } from '@/components/icons';

/**
 * Page d'édition d'un produit (route dédiée /manager/produits/[id]).
 * Clic « Modifier » sur le catalogue → redirige ici : titre « Modification de
 * <nom> » bien UX + les 8 onglets (Général·Vitrine·Boutique·Catégories·Options·
 * Add-ons·Sous-domaines·Mise à disposition) du <ProductEditor> ci-dessous.
 */
export default function ManagerProduitsEditPage() {
  const params = useParams(); // sync dans un composant client (Next 15)
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const { phase, me, token } = useAdminSession();
  const toast = useToast();

  const [product, setProduct] = useState<ProductAdmin | null>(null);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [packs, setPacks] = useState<PackAdmin[]>([]);
  const [modules, setModules] = useState<DeploymentModule[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'ready' || !token || !id) return;
    (async () => {
      const [p, c, k, m] = await Promise.all([
        getProduct(token, id),
        listCategories(token),
        listPacks(token),
        listDeploymentModules(token),
      ]);
      if (!p.ok) {
        if (p.status === 404) setNotFound(true);
        else setError(apiError(p, 'Impossible de charger le produit.'));
        return;
      }
      setProduct(p.data as ProductAdmin);
      if (c.ok) setCategories((c.data as ProductCategory[]) ?? []);
      if (k.ok) setPacks((k.data as PackAdmin[]) ?? []);
      if (m.ok) setModules((m.data as DeploymentModule[]) ?? []);
    })();
  }, [phase, token, id]);

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

  if (notFound) {
    return (
      <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
        <div className="wrap-md">
          <EmptyState>
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Produit introuvable</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Ce produit a peut-être été supprimé.
            </div>
            <Link href="/manager/produits" className="btn-secondary" style={{ display: 'inline-flex', marginTop: 16 }}>
              <IconChevronLeft size={15} /> Retour au catalogue
            </Link>
          </EmptyState>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title={`Modification de ${product?.name ?? '…'}`}
          sub={product?.slogan ?? 'Modifiez les caractéristiques et onglets du produit. Le catalogue clients se met à jour immédiatement.'}
        >
          <Link href="/manager/produits" className="btn-secondary" style={{ display: 'inline-flex' }}>
            <IconChevronLeft size={15} /> Retour au catalogue
          </Link>
        </PageIntro>

        {error && <div className="alert error">{error}</div>}

        {!product && !notFound ? (
          <PageLoading />
        ) : (
          <ProductEditor
            key={product?.id}
            product={product!}
            token={token!}
            categories={categories}
            packs={packs}
            modules={modules}
            onUpdated={() => {
              // Recharge le produit afin que le titre reflète un éventuel renommage.
              getProduct(token!, product!.id).then((r) => {
                if (r.ok) setProduct(r.data as ProductAdmin);
              });
            }}
          />
        )}
      </div>
    </AppShell>
  );
}