'use client';

import { useEffect } from 'react';
import { BrandMark } from '@/components/brand';
import { StatusPage } from '@/components/status-page';
import { Button, ButtonLink } from '@/components/ui';
import { useLocale } from '@/lib/i18n';
import { pick } from '@/lib/labels';
import { statusPageText } from '@/lib/status-pages';

/** Not wrapped in the app shell: if the shell is what failed, rendering it again would fail again. No error details are shown. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { locale } = useLocale(); const text = statusPageText.error;
  useEffect(() => { console.error(error); }, [error]);
  return <main id="main-content" className="status-screen">
    <BrandMark/>
    <StatusPage eyebrow={pick(locale, text.eyebrow)} title={pick(locale, text.title)} detail={pick(locale, text.detail)}>
      <Button type="button" onClick={reset}>{pick(locale, text.retry)}</Button>
      <ButtonLink href="/" variant="secondary">{pick(locale, text.home)}</ButtonLink>
    </StatusPage>
  </main>;
}
