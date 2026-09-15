'use client';

import { useEffect, useState } from 'react';
import type { ProductAdmin } from '@/lib/api';
import { useToast } from '@/components/toast';
import { IconCopy, IconGlobe } from '@/components/icons';

/**
 * Onglet « Liens Public » — 3 liens d'accès public auto-générés pour chaque
 * produit (sans exception), prêts à être copiés (campagnes email, docs… ) :
 *   1. Fiche produit (détails)  → /shop/<slug>
 *   2. Ajouter au panier direct → /shop/<slug>?action=panier
 *   3. Checkout direct          → /shop/<slug>?action=checkout
 * La fiche /shop/[slug] gère `?action=panier|checkout` : elle pré-remplit le
 * panier (contenu par défaut) puis redirige vers /cart ou /checkout/payment.
 */
export function ProductPublicLinksTab({ product }: { product: ProductAdmin }) {
  const toast = useToast();
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const slug = product.slug ?? null;
  const hasSlug = !!slug && slug.trim().length > 0;

  const links: { key: string; label: string; hint: string; href: string }[] = [
    {
      key: 'details',
      label: 'Fiche produit',
      hint: 'Page de détails publique du produit.',
      href: hasSlug ? `${origin}/shop/${slug}` : '',
    },
    {
      key: 'panier',
      label: 'Ajouter au panier',
      hint: 'Pré-remplit le panier du produit (config par défaut) puis ouvre le panier.',
      href: hasSlug ? `${origin}/shop/${slug}?action=panier` : '',
    },
    {
      key: 'checkout',
      label: 'Checkout direct',
      hint: 'Pré-remplit le panier du produit et ouvre directement le paiement.',
      href: hasSlug ? `${origin}/shop/${slug}?action=checkout` : '',
    },
  ];

  async function copy(key: string, href: string) {
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(key);
      toast.ok('Lien copié.');
    } catch {
      toast.error('Copie impossible — sélectionnez le lien à la main.');
    }
  }

  if (!hasSlug) {
    return (
      <div className="alert warn">
        Définissez un <b>slug</b> dans l&apos;onglet <b>Vitrine</b> pour générer les liens publics
        de ce produit.
      </div>
    );
  }

  return (
    <div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Liens d&apos;accès public générés automatiquement pour « {product.name} ».
        Le slug est défini dans l&apos;onglet Vitrine.
      </div>

      <div className="row" style={{ flexDirection: 'column', gap: 10, alignItems: 'stretch' }}>
        {links.map((l) => (
          <div
            key={l.key}
            className="card cell"
            style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', padding: '10px 14px' }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: 'var(--text-primary)' }}>
                <IconGlobe size={14} />
                {l.label}
              </div>
              <div className="muted mono" style={{ fontSize: 12.5, marginTop: 2 }}>{l.href}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{l.hint}</div>
            </div>
            <button
              type="button"
              className={`btn-secondary btn-sm${copied === l.key ? ' btn-primary' : ''}`}
              onClick={() => void copy(l.key, l.href)}
            >
              {copied === l.key ? (
                'Copié ✓'
              ) : (
                <>
                  <IconCopy size={13} /> Copier
                </>
              )}
            </button>
          </div>
        ))}
      </div>

      <div className="alert info" style={{ marginTop: 14 }}>
        <b>Comportement des liens directs :</b> le lien « Checkout direct » pré-remplit le panier
        avec la configuration par défaut (première option requise choisie, aucun supplément) puis
        ouvre le paiement. Pour un produit <b>Plan Gratuit</b> (sans panier), le lien direct ouvre
        l&apos;inscription. Pour un produit <b>exigeant un sous-domaine</b>, l&apos;acheteur choisit son
        sous-domaine sur la fiche avant de valider.
      </div>
    </div>
  );
}

export default ProductPublicLinksTab;