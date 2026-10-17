'use client';

import { Suspense } from 'react';
import { ResumeImport } from '@/components/resume-import';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

function ImportView() {
  const { locale } = useLocale(); const c = copy(locale);
  return <AppShell>
    <PageHeader eyebrow={c('PREPARA TU INFORMACIÓN', 'PREPARE YOUR DETAILS')} title={c('Importar un CV', 'Import a resume')} description={c('Usa tu CV como punto de partida. Te proponemos entradas para tu perfil y tú decides cuáles guardar y confirmar.', 'Use your resume as a starting point. We propose entries for your profile and you decide which to save and confirm.')}/>
    <ResumeImport/>
  </AppShell>;
}

export default function ResumeImportPage() { return <WorkspaceGate><Suspense><ImportView/></Suspense></WorkspaceGate>; }
