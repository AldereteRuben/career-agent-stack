'use client';

import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useLocale } from './i18n';

const prefix = 'career:draft:v1:';

export function clearSessionDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch { /* Storage may be unavailable in private browsing. */ }
}

export function stringDraft(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** Per-tab drafts survive route changes and reloads; logout clears them. No credentials are stored. */
export function useSessionDraft<T extends Record<string, string>>(key: string, initial: T, valid: (value: unknown) => value is T) {
  const { locale } = useLocale();
  const leaveMessage = locale === 'es' ? 'No se pudo conservar el borrador. ¿Salir y perder los cambios sin guardar?' : 'The draft could not be preserved. Leave and lose unsaved changes?';
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const ready = loadedKey === key;
  const currentKey = useRef<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const initialRef = useRef(initial); const validateRef = useRef(valid);
  useEffect(() => {
    let next = initialRef.current;
    setStorageFailed(false);
    try {
      const stored = sessionStorage.getItem(prefix + key);
      const parsed: unknown = stored ? JSON.parse(stored) : initialRef.current;
      if (validateRef.current(parsed)) next = parsed;
    } catch { setStorageFailed(true); }
    current.current = next; currentKey.current = key; setValue(next); setLoadedKey(key);
  }, [key]);
  const update = (action: SetStateAction<T>) => {
    if (currentKey.current !== key) return;
    const next = typeof action === 'function' ? (action as (previous: T) => T)(current.current) : action;
    current.current = next; setValue(next);
    try { sessionStorage.setItem(prefix + key, JSON.stringify(next)); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  };
  useEffect(() => {
    if (!storageFailed || !Object.values(value).some(Boolean)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const guard = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      if (window.confirm(leaveMessage)) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('beforeunload', warn); document.addEventListener('click', guard, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', guard, true); };
  }, [storageFailed, value, leaveMessage]);
  return { value: ready ? value : initialRef.current, update, ready, storageFailed };
}
