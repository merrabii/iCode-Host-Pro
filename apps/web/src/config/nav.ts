import type { NavSection } from '@/components/app-shell';
import {
  IconBook,
  IconBox,
  IconBoxes,
  IconBrush,
  IconChartBar,
  IconDatabase,
  IconFileText,
  IconGlobe,
  IconGrid,
  IconKey,
  IconLayers,
  IconLifeBuoy,
  IconMail,
  IconRefresh,
  IconServer,
  IconShield,
  IconUsers,
  IconWallet,
} from '@/components/icons';
import { isAdminRole, isSupportRole } from '@/lib/session';

/** Navigation de la console d'administration (Phase 10 : + Sécurité + Support). */
export const ADMIN_NAV: NavSection[] = [
  {
    section: 'Administration',
    items: [
      { label: 'Tableau de bord', href: '/manager', icon: IconGrid },
      { label: 'Serveurs', href: '/manager/serveurs', icon: IconServer },
      { label: 'Produits', href: '/manager/produits', icon: IconBox },
      { label: 'Catégories', href: '/manager/categories', icon: IconDatabase },
      { label: 'Packs', href: '/manager/packs', icon: IconLayers },
      { label: 'Utilisateurs', href: '/manager/utilisateurs', icon: IconUsers },
      { label: 'Commandes', href: '/manager/commandes', icon: IconBox },
      { label: 'Factures', href: '/manager/factures', icon: IconFileText },
      { label: 'Taux de taxe', href: '/manager/taxe', icon: IconChartBar },
      { label: 'Recharges', href: '/manager/recharges', icon: IconWallet },
      { label: 'Souscriptions & services', href: '/manager/subscriptions', icon: IconBoxes },
      { label: 'Invitations', href: '/manager/invitations', icon: IconMail },
      { label: 'Configuration mail', href: '/manager/mail', icon: IconMail },
      { label: 'DNS & Cloudflare', href: '/manager/dns', icon: IconGlobe },
      { label: "Journal d'audit", href: '/manager/journal', icon: IconFileText },
      { label: 'Monitoring projets', href: '/manager/monitoring', icon: IconChartBar },
      { label: 'Réconciliation', href: '/manager/reconciliation', icon: IconRefresh },
      { label: 'Apparence', href: '/manager/apparence', icon: IconBrush },
    ],
  },
  {
    section: 'Sécurité & support',
    items: [
      { label: 'Sécurité', href: '/manager/securite', icon: IconShield },
      { label: 'Support', href: '/manager/support', icon: IconUsers },
      { label: 'Base de connaissance', href: '/manager/connaissance', icon: IconBook },
    ],
  },
  {
    section: 'Espaces',
    items: [
      { label: 'Espace client', href: '/client', icon: IconGlobe },
      { label: 'Mon profil', href: '/profil', icon: IconKey },
    ],
  },
];

/** Navigation du support (L1/L2/L3) — file de tickets + espace client en lecture. */
export const SUPPORT_NAV: NavSection[] = [
  {
    section: 'Support',
    items: [{ label: 'File de tickets', href: '/manager/support', icon: IconUsers }],
  },
  {
    section: 'Espaces',
    items: [
      { label: 'Espace client (lecture)', href: '/client', icon: IconGlobe },
      { label: 'Mon profil', href: '/profil', icon: IconKey },
    ],
  },
];

/** Navigation de l'espace client — rubriques directes (liens vers /client?rub=…)
 *  + pages : fonctionnent depuis /client, /profil et /aide. */
export const CLIENT_NAV: NavSection[] = [
  {
    section: 'Espace client',
    items: [
      { label: 'Mes applications', href: '/client?rub=apps', icon: IconServer },
      { label: 'Mes commandes', href: '/client/commandes', icon: IconBox },
      { label: 'Mes factures', href: '/client/factures', icon: IconFileText },
      { label: 'Portefeuille', href: '/client/portefeuille', icon: IconWallet },
      { label: 'Hébergement', href: '/client?rub=host', icon: IconBoxes },
      { label: 'Assistance', href: '/client?rub=help', icon: IconLifeBuoy },
      { label: 'Mon profil', href: '/profil', icon: IconKey },
      { label: 'Centre d’aide', href: '/aide', icon: IconBook },
    ],
  },
];

/** Navigation de l'espace courant selon le rôle (pages partagées : /profil, /aide). */
export function spaceNavFor(role?: string | null): NavSection[] {
  if (role && isAdminRole(role)) return ADMIN_NAV;
  if (role && isSupportRole(role)) return SUPPORT_NAV;
  return CLIENT_NAV;
}
