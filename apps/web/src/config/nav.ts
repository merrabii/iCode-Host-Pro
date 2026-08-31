import type { NavSection } from '@/components/app-shell';
import {
  IconBoxes,
  IconFileText,
  IconGlobe,
  IconGrid,
  IconMail,
  IconServer,
  IconUsers,
} from '@/components/icons';

/** Navigation de la console d'administration. */
export const ADMIN_NAV: NavSection[] = [
  {
    section: 'Administration',
    items: [
      { label: 'Tableau de bord', href: '/manager', icon: IconGrid },
      { label: 'Utilisateurs', href: '/manager/utilisateurs', icon: IconUsers },
      { label: "Journal d'audit", href: '/manager/journal', icon: IconFileText },
      { label: 'Invitations', href: '/manager/invitations', icon: IconMail },
      { label: 'Configuration mail', href: '/manager/mail', icon: IconMail },
      { label: 'Souscriptions & services', href: '/manager/subscriptions', icon: IconBoxes },
    ],
  },
  {
    section: 'Espace client',
    items: [{ label: 'Espace client', href: '/client', icon: IconGlobe }],
  },
];

/** Navigation de l'espace client. */
export const CLIENT_NAV: NavSection[] = [
  {
    section: 'Espace client',
    items: [{ label: 'Mes services', href: '/client', icon: IconServer }],
  },
  {
    section: 'Administration',
    items: [{ label: 'Console admin', href: '/manager', icon: IconGrid }],
  },
];
