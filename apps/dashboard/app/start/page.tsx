'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Field, Notice } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { stringDraft, useSessionDraft } from '@/lib/session-draft';

type Profile = {
  revision: number;
  locale?: string;
  profile: { identity?: { fullName?: string; email?: string; [key: string]: unknown }; [key: string]: unknown };
  facts: Array<{ approvalStatus: string }>;
};
type Resume = { id: string; approvalStatus: string; assistReady: boolean; reviewReady: boolean };
const emptyDraft = { name: '', email: '', edited: '' };

export default function StartPage() {
  const { locale } = useLocale(); const c = copy(locale);
  const draft = useSessionDraft('getting-started', emptyDraft, (value): value is typeof emptyDraft => stringDraft(value) && ['name', 'email', 'edited'].every((key) => typeof value[key] === 'string'));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextProfile, nextResumes] = await Promise.all([api<Profile>('/profile'), api<Resume[]>('/documents')]);
      setProfile(nextProfile); setResumes(nextResumes);
    } catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const identityReady = Boolean(profile?.profile.identity?.fullName?.trim() && profile.profile.identity.email?.trim());
  const experienceReady = Boolean(profile?.facts.some((fact) => fact.approvalStatus === 'USER_APPROVED'));
  const resumeReady = resumes.some((resume) => resume.approvalStatus === 'USER_APPROVED' && resume.assistReady);
  const pendingResume = resumes.find((resume) => resume.reviewReady);
  const pending = profile?.facts.filter((fact) => fact.approvalStatus === 'SUGGESTED').length ?? 0;
  const step = draft.value.edited === 'yes' || !identityReady ? 0 : !experienceReady ? 1 : !resumeReady ? 2 : 3;
  const value = draft.value.edited ? draft.value : { name: profile?.profile.identity?.fullName ?? '', email: profile?.profile.identity?.email ?? '', edited: '' };
  const update = (key: 'name' | 'email', text: string) => draft.update({ ...value, [key]: text, edited: 'yes' });
  useEffect(() => {
    if (!loading && moveFocus.current) { moveFocus.current = false; stepHeading.current?.focus(); }
  }, [loading, step]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!profile || busy) return;
    setBusy(true); setError('');
    try {
      await api('/profile', { method: 'PUT', body: JSON.stringify({ expectedRevision: profile.revision, locale: profile.locale ?? locale, profile: { ...profile.profile, identity: { ...profile.profile.identity, fullName: value.name.trim(), email: value.email.trim() } } }) });
      draft.update(emptyDraft); moveFocus.current = true; await load();
    } catch (err) {
      setError(errorMessage(err));
      // Refresh the revision for a deliberate retry; retain the user's draft and other profile fields.
      try { setProfile(await api<Profile>('/profile')); } catch { /* The original error remains actionable. */ }
    } finally { setBusy(false); }
  };
  const titles = [c('Tus datos', 'Your details'), c('Una experiencia', 'One experience'), c('Tu primer CV', 'Your first resume')];
  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('PRIMEROS PASOS', 'GETTING STARTED')} title={c('Prepara tu primer CV, paso a paso', 'Prepare your first resume, step by step')} description={c('Empieza con lo esencial. Puedes volver a esta guía desde Inicio cuando quieras.', 'Start with the essentials. You can return to this guide from Home whenever you want.')}/>
    <div className="onboarding-layout">
      <ol className="onboarding-progress" aria-label={c('Tu progreso', 'Your progress')}>
        {titles.map((title, index) => <li key={index} aria-current={index === step ? 'step' : undefined}><span className="step-badge" aria-hidden="true">{index < step ? '✓' : index + 1}</span><span>{title}<small>{index < step ? c('Listo', 'Done') : index === step ? c('Ahora', 'Now') : c('Después', 'Next')}</small></span></li>)}
      </ol>
      {error && <Notice tone="error" actions={<Button variant="quiet" disabled={busy || loading} onClick={() => void load()}>{c('Reintentar', 'Try again')}</Button>}>{error}</Notice>}
      {loading ? <Notice>{c('Preparando tu guía…', 'Preparing your guide…')}</Notice> : profile && <Card className="form-card onboarding-card">
        <h2 ref={stepHeading} tabIndex={-1} className="focus-heading">{step === 0 ? c('¿Cómo quieres aparecer en tu CV?', 'How should you appear on your resume?') : step === 1 ? c('Cuéntanos una experiencia', 'Tell us about one experience') : step === 2 ? pendingResume ? c('Tu CV está pendiente de revisión', 'Your resume is waiting for review') : c('Ya puedes preparar tu PDF', 'You are ready to prepare your PDF') : c('Tu primer CV está listo', 'Your first resume is ready')}</h2>
        {step === 0 ? <>
          <p>{c('Solo necesitamos tu nombre y correo. Podrás añadir tus preferencias de empleo después.', 'We only need your name and email. You can add job preferences later.')}</p>
          <form className="form-stack" onSubmit={(event) => void save(event)} aria-busy={busy}>
            <fieldset className="entry-fields" disabled={busy || !draft.ready}>
              <div className="form-grid"><Field label={c('Nombre', 'Name')} value={value.name} onChange={(event) => update('name', event.target.value)} autoComplete="name" required maxLength={200}/><Field label={c('Correo', 'Email')} value={value.email} onChange={(event) => update('email', event.target.value)} type="email" autoComplete="email" required maxLength={320}/></div>
              {draft.storageFailed && <Notice tone="warning">{c('Guarda antes de salir: no pudimos conservar el borrador en esta pestaña.', 'Save before leaving: we could not keep the draft in this tab.')}</Notice>}
              <Button type="submit" disabled={!value.name.trim() || !value.email.trim()}>{busy ? c('Guardando…', 'Saving…') : c('Guardar y continuar', 'Save and continue')}</Button>
            </fieldset>
          </form>
        </> : step === 1 ? <>
          <p>{pending ? c('Ya tienes contenido por revisar. Confirma que es correcto para poder usarlo en tu CV.', 'You already have content to review. Confirm it is accurate so you can use it on your resume.') : c('Puede ser un empleo, unos estudios, un proyecto o un logro. Añade uno y confirma que sus datos son correctos.', 'It can be a job, education, a project, or an achievement. Add one and confirm that its details are accurate.')}</p>
          <Link className="button button-primary" href={pending ? '/profile#saved-experience-heading' : '/profile#experience'}>{pending ? c('Revisar mi experiencia', 'Review my experience') : c('Añadir mi primera experiencia', 'Add my first experience')}</Link>
        </> : step === 2 ? <>
          <p>{pendingResume ? c('Ya tienes una versión guardada. Léela y confirma que está correcta para terminar.', 'You already have a saved version. Read it and confirm it is accurate to finish.') : c('Elige qué experiencia incluir, genera el PDF y léelo antes de confirmar que está listo.', 'Choose the experience to include, generate the PDF, and read it before confirming it is ready.')}</p>
          <Link className="button button-primary" href={pendingResume ? `/documents?view=review&document=${pendingResume.id}&from=saved` : '/documents'}>{pendingResume ? c('Continuar revisando mi CV', 'Continue reviewing my resume') : c('Preparar mi CV', 'Prepare my resume')}</Link>
        </> : <>
          <p>{c('Puedes descargarlo o elegir una oferta para preparar una solicitud. Tú decides cuándo enviarla.', 'You can download it or choose a job to prepare an application. You decide when to submit it.')}</p>
          <div className="detail-actions"><Link className="button button-primary" href="/documents?view=saved">{c('Ver mis CV', 'View my resumes')}</Link><Link className="button button-secondary" href="/jobs">{c('Elegir una oferta', 'Choose a job')}</Link></div>
        </>}
      </Card>}
      <p className="muted-label">{c('Las empresas que sigues y las respuestas guardadas son opcionales. No necesitas configurarlas para crear tu CV.', 'Followed companies and saved answers are optional. You do not need to set them up to create your resume.')}</p>
      <Link href="/">{c('Volver a Inicio', 'Back to Home')}</Link>
    </div>
  </AppShell></WorkspaceGate>;
}
