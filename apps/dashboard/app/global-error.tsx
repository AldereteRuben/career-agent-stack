'use client';

import { useEffect, useState } from 'react';
import type { Locale } from '@/lib/locale';
import { pick } from '@/lib/labels';
import { localeWithoutProvider, statusPageText } from '@/lib/status-pages';
import './globals.css';

/**
 * Last resort for a failure of the root layout, which replaces the whole document: it brings its own <html lang> and has no
 * language provider, app shell or router, so it uses plain elements and the language cookie. Shows no error details.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Start in English so the server and first client render agree, then switch to the saved or browser language.
  const [locale, setLocale] = useState<Locale>('en');
  const text = statusPageText.error;
  useEffect(() => { setLocale(localeWithoutProvider(document.cookie, navigator.language)); }, []);
  useEffect(() => { console.error(error); }, [error]);
  useEffect(() => { document.title = `${pick(locale, text.title)} · Career Stack`; }, [locale, text.title]);
  return <html lang={locale}><body>
    <main id="main-content" className="status-screen">
      <section className="card status-page">
        <div className="eyebrow">{pick(locale, text.eyebrow)}</div>
        <h1>{pick(locale, text.title)}</h1>
        <p>{pick(locale, text.detail)}</p>
        <div className="status-actions">
          <button type="button" className="button button-primary" onClick={reset}>{pick(locale, text.retry)}</button>
          {/* A plain link on purpose: a full page load recovers even when the router is what failed. */}
          <a className="button button-secondary" href="/">{pick(locale, text.home)}</a>
        </div>
      </section>
    </main>
  </body></html>;
}
