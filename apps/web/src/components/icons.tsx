/**
 * Icônes svg inline, style dupliqué de la référence (trait 2px, extrémités arrondies).
 * Aucune dépendance externe — petites icônes utilitaires partagées.
 */
type IconProps = { size?: number; className?: string };

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

export const IconGrid = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="grid">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconUsers = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="users">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const IconFileText = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="file-text">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
    <path d="M10 9H8" />
  </svg>
);

export const IconMail = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="mail">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </svg>
);

export const IconServer = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="server">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <path d="M6 6h.01" />
    <path d="M6 18h.01" />
  </svg>
);

export const IconBoxes = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="boxes">
    <path d="m7.5 4.27 9 5.15" />
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
);

export const IconGlobe = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="globe">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </svg>
);

export const IconDatabase = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="database">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />
  </svg>
);

export const IconShield = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="shield">
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const IconLogOut = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="logout">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

export const IconRefresh = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="refresh">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

export const IconChevronDown = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="chevron-down">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconChevronRight = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="chevron-right">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconSun = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="sun">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

export const IconMoon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="moon">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

export const IconCheck = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="check">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const IconX = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="x">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const IconAlert = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="alert">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </svg>
);

export const IconInfo = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="info">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const IconPlus = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="plus">
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);

export const IconUser = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="user">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export const IconBox = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="box">
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
);

export const IconKey = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="key">
    <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

export const IconCopy = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="copy">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

/* Rework UX (2026-09-01) : recherche + actions de liste modernes. */
export const IconSearch = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="search">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const IconPencil = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="pencil">
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </svg>
);

export const IconTrash = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="trash">
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

export const IconBook = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="book">
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
  </svg>
);

export const IconLifeBuoy = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="life-buoy">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="4" />
    <path d="m4.93 4.93 4.24 4.24" />
    <path d="m14.83 14.83 4.24 4.24" />
    <path d="m19.07 4.93-4.24 4.24" />
    <path d="m9.17 14.83-4.24 4.24" />
  </svg>
);

export const IconLayers = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} data-icon="layers">
    <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
    <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
    <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
  </svg>
);
