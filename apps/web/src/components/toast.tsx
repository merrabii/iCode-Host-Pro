'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconAlert, IconCheck, IconInfo } from './icons';

export type ToastTone = 'ok' | 'error' | 'info' | 'warn';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  ok(message: string): void;
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/* Auto-dismiss après 5 s (demande propriétaire) ; le bouton OK referme
   immédiatement. Le provider est monté dans layout.tsx → disponible sur
   toutes les pages (y compris /auth en mode bare). */
const DURATION_MS = 5000;

const TONE_ICON: Record<ToastTone, ReactNode> = {
  ok: <IconCheck size={17} />,
  error: <IconAlert size={17} />,
  info: <IconInfo size={17} />,
  warn: <IconAlert size={17} />,
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((cur) => [...cur, { id, tone, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION_MS),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      ok: (m) => push('ok', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
      warn: (m) => push('warn', m),
    }),
    [push],
  );

  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-host">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.tone}`}
            role={t.tone === 'error' ? 'alert' : 'status'}
            aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
          >
            <span aria-hidden="true">{TONE_ICON[t.tone]}</span>
            <span className="toast-msg">{t.message}</span>
            <button type="button" className="toast-btn" onClick={() => dismiss(t.id)}>
              OK
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast doit être utilisé sous <ToastProvider>.');
  return ctx;
}
