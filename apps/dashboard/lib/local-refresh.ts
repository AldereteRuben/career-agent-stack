'use client';

import { useEffect, useRef } from 'react';

/** Refresh local records, never trigger a new provider request. Keep focus and drafts where they are. */
export function useLocalRefresh(refresh: () => Promise<unknown>, { paused = false, interval = 30000 }: { paused?: boolean; interval?: number } = {}) {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => {
    if (paused) return;
    let pending = false;
    const run = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try { await latest.current(); } finally { pending = false; }
    };
    const refreshVisible = () => { void run(); };
    const timer = setInterval(refreshVisible, interval);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); window.removeEventListener('focus', refreshVisible); };
  }, [paused, interval]);
}
