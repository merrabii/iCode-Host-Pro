'use client';

import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';

const KEY = 'ihp-theme';

/** Bascule dark/light — le thème est porté par `data-theme` sur <html>
 *  (posé d'abord par le script anti-FOUC de layout.tsx, défaut dark). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const cur = document.documentElement.getAttribute('data-theme');
    setTheme(cur === 'light' ? 'light' : 'dark');
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* stockage indisponible — le thème vit sur l'attribut */
    }
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Basculer le thème">
      {theme === 'dark' ? <IconMoon /> : <IconSun />}
      <span>{theme === 'dark' ? 'Thème sombre' : 'Thème clair'}</span>
    </button>
  );
}
