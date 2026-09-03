import type { NavSection } from '@/components/app-shell';
import {
  IconBook,
  IconBox,
  IconBoxes,
  IconFileText,
  IconGlobe,
  IconGrid,
  IconKey,
  IconLifeBuoy,
  IconMail,
  IconServer,
  IconShield,
  IconUsers,
} from '@/components/icons';

/** Navigation de la console d'administration (Phase 10 : + Sécurité + Support). */
export const ADMIN_NAV: NavSection[] = [
  {
    section: 'Administration',
    items: [
      { label: 'Tableau de bord', href: '/manager', icon: IconGrid },
      { label: 'Serveurs', href: '/manager/serveurs', icon: IconServer },
      { label: 'Produits', href: '/manager/produits', icon: IconBox },
      { label: 'Utilisateurs', href: '/manager/utilisateurs', icon: IconUsers },
      { label: 'Souscriptions & services', href: '/manager/subscriptions', icon: IconBoxes },
      { label: 'Invitations', href: '/manager/invitations', icon: IconMail },
      { label: 'Configuration mail', href: '/manager/mail', icon: IconMail },
      { label: "Journal d'audit", href: '/manager/journal', icon: IconFileText },
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

/** Navigation de l'espace client. */
export const CLIENT_NAV: NavSection[] = [
  {
    section: 'Espace client',
    items: [
      { label: 'Mes services', href: '/client', icon: IconServer },
      { label: 'Mon profil', href: '/profil', icon: IconKey },
      { label: 'Centre d’aide', href: '/aide', icon: IconLifeBuoy },
    ],
  },
  {
    section: 'Administration',
    items: [{ label: 'Console admin', href: '/manager', icon: IconGrid }],
  },
];
