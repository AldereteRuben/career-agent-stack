'use client';

import { useRouter } from 'next/navigation';
import { AppShell, WorkspaceGate } from '@/components/shell';
import { StatusPage } from '@/components/status-page';
import { Button, ButtonLink } from '@/components/ui';
import { useLocale } from '@/lib/i18n';
import { pick } from '@/lib/labels';
import { statusPageText } from '@/lib/status-pages';

export default function NotFound() {
  const { locale } = useLocale(); const router = useRouter(); const text = statusPageText.notFound;
  // With no earlier page in this tab (a pasted address), going back would leave the app, so go to the searches instead.
  const goBack = () => { if (window.history.length > 1) router.back(); else router.push('/searches'); };
  return <WorkspaceGate><AppShell>
    <StatusPage eyebrow={pick(locale, text.eyebrow)} title={pick(locale, text.title)} detail={pick(locale, text.detail)}>
      <ButtonLink href="/searches">{pick(locale, text.search)}</ButtonLink>
      <Button type="button" variant="secondary" onClick={goBack}>{pick(locale, text.back)}</Button>
    </StatusPage>
  </AppShell></WorkspaceGate>;
}
