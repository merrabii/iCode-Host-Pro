'use client';

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          theme?: string;
        },
      ) => string;
      reset?: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

/**
 * Cloudflare Turnstile widget — chargé UNIQUEMENT si une clé site est
 * configurée (NEXT_PUBLIC_TURNSTILE_SITE_KEY, exposé via /public/auth-config).
 * Rend un div placeholder ; l'objet `token` est transmis au callback parent.
 */
export function Turnstile({
  siteKey,
  onChange,
}: {
  siteKey: string;
  onChange: (token: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = 'cf-turnstile-script';
    if (!document.getElementById(id) && siteKey) {
      const s = document.createElement('script');
      s.id = id;
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      document.head.appendChild(s);
    }
    const timer = window.setInterval(() => {
      if (window.turnstile) {
        setReady(true);
        window.clearInterval(timer);
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [siteKey]);

  useEffect(() => {
    if (ready && ref.current) {
      window.turnstile?.render(ref.current, {
        sitekey: siteKey,
        callback: onChange,
        'error-callback': () => onChange(''),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, siteKey]);

  if (!siteKey) return null;
  return <div ref={ref} data-testid="turnstile" />;
}