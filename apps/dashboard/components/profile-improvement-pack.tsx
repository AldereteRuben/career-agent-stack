'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ProfileEntry } from '@/components/profile-entry-form';
import { Button, Card, Notice } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { buildProfileImprovement, formatImprovementCopy } from '@/lib/profile-improvement';
import styles from './profile-improvement-pack.module.css';

type Fact = ProfileEntry & { approvalStatus: string };
type SkillGapReport = {
  savedJobCount: number;
  groups: Array<{ skill: string; profileEvidence: 'PENDING_REVIEW' | 'NOT_IN_APPROVED_PROFILE'; jobs: Array<{ id: string; company: string; title: string }> }>;
};

export function ProfileImprovementPack({ facts }: { facts: Fact[] }) {
  const { locale } = useLocale();
  const c = (es: string, en: string) => locale === 'es' ? es : en;
  const pack = useMemo(() => buildProfileImprovement(facts, locale), [facts, locale]);
  const [gaps, setGaps] = useState<SkillGapReport | null>(null);
  const [gapError, setGapError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    let active = true;
    void api<SkillGapReport>('/skill-gap-report').then((report) => { if (active) setGaps(report); })
      .catch((error: unknown) => { if (active) setGapError(errorMessage(error)); });
    return () => { active = false; };
  }, []);

  const copyText = async (text: string, evidence: string[], evidenceLabel = c('Evidencia aprobada', 'Approved evidence')) => {
    try {
      await navigator.clipboard.writeText(formatImprovementCopy(text, evidence, evidenceLabel));
      setCopyMessage(c('Texto y evidencia copiados.', 'Text and evidence copied.'));
    } catch {
      setCopyMessage(c('No se pudo copiar. Selecciona y copia el texto manualmente.', 'Could not copy. Select and copy the text manually.'));
    }
  };

  return <Card className={styles.panel} aria-labelledby="profile-improvement-heading" data-testid="profile-improvement-pack">
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}>{c('PAQUETE MANUAL', 'MANUAL PACK')}</p><h2 id="profile-improvement-heading">{c('Mejora tu perfil profesional', 'Improve your professional profile')}</h2></div>
      <Link href="/profile/import">{c('Revisar hechos aprobados', 'Review approved facts')}</Link>
    </div>
    <p>{c('Prepara textos para copiar tú mismo. No conectamos con LinkedIn ni publicamos cambios.', 'Prepare text for you to copy yourself. We do not connect to LinkedIn or publish changes.')}</p>
    {copyMessage && <p role="status">{copyMessage}</p>}

    <section aria-labelledby="profile-headlines-heading">
      <h3 id="profile-headlines-heading">{c('Titulares basados en tu experiencia', 'Headlines grounded in your experience')}</h3>
      {pack.headlineVariants.length ? <ul className={styles.items}>{pack.headlineVariants.map((item, index) => <li key={`${item.text}-${index}`}>
        <p>{item.text}</p><p className={styles.evidence}><strong>{c('Hecho aprobado', 'Approved fact')}:</strong> {item.evidence.join(' · ')}</p>
        <Button type="button" variant="secondary" onClick={() => void copyText(item.text, item.evidence)}>{c('Copiar con evidencia', 'Copy with evidence')}</Button>
      </li>)}</ul> : <p>{c('Confirma una experiencia con puesto para preparar titulares sin inventar credenciales.', 'Approve an experience with a role to prepare headlines without inventing credentials.')}</p>}
    </section>

    <section aria-labelledby="profile-about-heading">
      <h3 id="profile-about-heading">{c('Borrador de «Acerca de»', 'About draft')}</h3>
      {pack.aboutDraft.length ? pack.aboutDraft.map((item, index) => <div key={index}>
        <p>{item.text}</p><p className={styles.evidence}><strong>{c('Hechos aprobados', 'Approved facts')}:</strong> {item.evidence.join(' · ')}</p>
        <Button type="button" variant="secondary" onClick={() => void copyText(item.text, item.evidence)}>{c('Copiar con evidencia', 'Copy with evidence')}</Button>
      </div>) : <p>{c('Añade y aprueba una experiencia estructurada o un resumen para preparar este borrador.', 'Add and approve a structured experience or summary to prepare this draft.')}</p>}
    </section>

    <section aria-labelledby="profile-bullets-heading">
      <h3 id="profile-bullets-heading">{c('Viñetas de experiencia', 'Experience bullets')}</h3>
      {pack.experienceBullets.length ? <ul className={styles.items}>{pack.experienceBullets.map((item, index) => <li key={`${item.text}-${index}`}>
        <p>{item.text}</p><p className={styles.evidence}><strong>{c('Hecho aprobado', 'Approved fact')}:</strong> {item.evidence[0]}</p>
        <Button type="button" variant="secondary" onClick={() => void copyText(item.text, item.evidence)}>{c('Copiar con evidencia', 'Copy with evidence')}</Button>
      </li>)}</ul> : <p>{c('Tus experiencias confirmadas aparecerán aquí.', 'Your approved experiences will appear here.')}</p>}
    </section>

    <section aria-labelledby="profile-skills-heading">
      <h3 id="profile-skills-heading">{c('Habilidades que aparecen en tus ofertas guardadas', 'Skills appearing in your saved jobs')}</h3>
      {gapError ? <Notice tone="warning">{c('No se pudo cargar este apartado.', 'This section could not be loaded.')} {gapError}</Notice>
        : !gaps ? <p role="status">{c('Cargando requisitos guardados…', 'Loading saved requirements…')}</p>
          : gaps.savedJobCount === 0 ? <p>{c('Guarda ofertas con descripciones para detectar habilidades recurrentes.', 'Save jobs with descriptions to identify recurring skills.')}</p>
            : gaps.groups.length ? <><p>{c('Que no aparezca en tus hechos aprobados no significa que te falte esa habilidad. Revisa las ofertas y añade evidencia real si la tienes.', 'Not finding a skill in your approved facts does not mean you lack it. Review the jobs and add real evidence if you have it.')}</p>
              <ul className={styles.items}>{gaps.groups.map((group) => {
                const evidence = group.jobs.map((job) => `${job.title} · ${job.company}`);
                const idea = c(`Idea para el portafolio, no experiencia: crea una muestra pequeña relacionada con ${group.skill}.`, `Portfolio idea, not experience: create a small sample related to ${group.skill}.`);
                return <li key={group.skill}><p><strong>{group.skill}</strong> · {group.profileEvidence === 'PENDING_REVIEW' ? c('hay datos por revisar', 'profile details need review') : c('sin evidencia aprobada', 'no approved evidence')}</p>
                  <p className={styles.evidence}><strong>{c('Ofertas de referencia', 'Reference jobs')}:</strong> {evidence.join(' · ')}</p>
                  <p>{idea}</p>
                  {group.jobs.map((job) => <Link key={job.id} href={`/jobs/${job.id}`}>{job.title} · {job.company}</Link>)}
                  <Button type="button" variant="secondary" onClick={() => void copyText(idea, evidence, c('Ofertas de referencia', 'Reference jobs'))}>{c('Copiar idea y referencias', 'Copy idea and references')}</Button>
                </li>;
              })}</ul></>
              : <p>{c('No encontramos requisitos conocidos sin evidencia aprobada; eso no garantiza que cubras todos los requisitos.', 'No known requirements without approved evidence were found; this does not guarantee you meet every requirement.')}</p>}
    </section>
    <p className={styles.note}>{c('La primera versión no usa IA. Cada texto incluye la evidencia para que puedas revisarlo antes de copiarlo.', 'This first version does not use AI. Each text includes its evidence so you can review it before copying.')}</p>
  </Card>;
}
