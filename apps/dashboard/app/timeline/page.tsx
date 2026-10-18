'use client';

import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { ActivityTimeline } from '@/components/activity-timeline';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';

function TimelineContent() {
  const { locale } = useLocale(); const c = copy(locale);
  return <>
    <PageHeader eyebrow={c('ACTIVIDAD CON FECHA', 'DATED ACTIVITY')} title={c('Cronología', 'Timeline')} description={c('Lo que ya registraste, día a día: ofertas encontradas y guardadas, candidaturas, cambios de estado y etapa, entrevistas y recordatorios. Nada se añade por estimación.', 'What you have recorded, day by day: jobs found and saved, applications, status and stage changes, interviews and follow-ups. Nothing is estimated.')}/>
    <ActivityTimeline/>
  </>;
}

export default function TimelinePage() {
  return <WorkspaceGate><AppShell><TimelineContent/></AppShell></WorkspaceGate>;
}
