'use client';

import { useRouter } from 'next/navigation';
import { AppShell, WorkspaceGate } from '@/components/shell';
import { StatusPage } from '@/components/status-page';
import { Button, ButtonLink } from '@/components/ui';
import { useLocale } from '@/lib/i18n';
import { pick } from '@/lib/labels';
import { canGoBackInApp, statusPageText } from '@/lib/status-pages';

export default function NotFound() {
  const { locale } = useLocale(); const router = useRouter(); const text = statusPageText.notFound;
  // Going back would leave the app when the earlier page is another site (or there is none), so go to the searches instead.
  const goBack = () => {
    const navigation = (window as { navigation?: { entries(): { url: string | null }[]; currentEntry: { index: number } | null } }).navigation;
    const previous = navigation?.currentEntry ? (navigation.entries()[navigation.currentEntry.index - 1]?.url ?? null) : undefined;
    if (canGoBackInApp({ origin: window.location.origin, historyLength: window.history.length, referrer: document.referrer, previousEntryUrl: previous })) router.back();
    else router.push('/searches');
  };
  return <WorkspaceGate><AppShell>
    <StatusPage eyebrow={pick(locale, text.eyebrow)} title={pick(locale, text.title)} detail={pick(locale, text.detail)} ownTitle={false}>
      <ButtonLink href="/searches">{pick(locale, text.search)}</ButtonLink>
      <Button type="button" variant="secondary" onClick={goBack}>{pick(locale, text.back)}</Button>
    </StatusPage>
  </AppShell></WorkspaceGate>;
}
