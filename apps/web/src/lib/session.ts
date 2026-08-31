'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchMe, getAccessToken, Me } from '@/lib/api';

export type SessionPhase = 'loading' | 'denied' | 'ready';

/**
 * Bootstrap de session des pages protégées de la console admin.
 * Comportement identique au code répété des pages d'origine :
 *  — pas de jeton de rafraîchissement → redirection /auth ;
 *  — jeton mais non administrateur → phase 'denied' ;
 *  — sinon phase 'ready' avec `token` + `me`.
 */
export function useAdminSession() {
  const router = useRouter();
  const [phase, setPhase] = useState<SessionPhase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');

  useEffect(() => {
    (async () => {
      const t = await getAccessToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m || m.role !== 'ADMIN') {
        setPhase('denied');
        return;
      }
      setToken(t);
      setMe(m);
      setPhase('ready');
    })();
  }, [router]);

  return { phase, me, token };
}
