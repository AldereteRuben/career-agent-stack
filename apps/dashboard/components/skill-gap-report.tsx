'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Notice, Tag } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import styles from './skill-gap-report.module.css';

type SkillGapReportData = {
  savedJobCount: number;
  analyzedJobCount: number;
  jobsWithoutDescription: number;
  jobsWithoutRequirements: number;
  groups: Array<{
    skill: string;
    profileEvidence: 'PENDING_REVIEW' | 'NOT_IN_APPROVED_PROFILE';
    requiredJobCount: number;
    preferredJobCount: number;
    unspecifiedJobCount: number;
    jobs: Array<{ id: string; company: string; title: string; level: 'REQUIRED' | 'PREFERRED' | 'UNSPECIFIED'; excerpt: string | null }>;
  }>;
};

export function SkillGapReportPanel() {
  const { locale } = useLocale();
  const c = (es: string, en: string) => locale === 'es' ? es : en;
  const [report, setReport] = useState<SkillGapReportData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setReport(await api<SkillGapReportData>('/skill-gap-report')); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <Card className={styles.panel} aria-labelledby="skill-gap-heading" data-testid="skill-gap-report">
    <div className={styles.heading}><div><p className={styles.eyebrow}>{c('PATRONES EN OFERTAS GUARDADAS', 'SAVED JOB PATTERNS')}</p><h2 id="skill-gap-heading">{c('Habilidades que piden con frecuencia', 'Skills frequently requested')}</h2></div><Link href="/profile">{c('Revisar perfil', 'Review profile')}</Link></div>
    {loading ? <p role="status">{c('Analizando ofertas guardadas…', 'Analyzing saved jobs…')}</p>
      : error ? <Notice tone="error" actions={<Button variant="quiet" onClick={() => void load()}>{c('Reintentar', 'Try again')}</Button>}>{c('No se pudo cargar el informe.', 'Could not load the report.')} {error}</Notice>
        : !report || report.savedJobCount === 0 ? <p>{c('Guarda ofertas con descripciones para ver qué requisitos se repiten.', 'Save jobs with descriptions to see which requirements recur.')}</p>
          : <>
            <p className={styles.summary}>{c(`Ofertas únicas guardadas: ${report.savedJobCount}. Con requisitos reconocidos: ${report.analyzedJobCount}.`, `Unique saved jobs: ${report.savedJobCount}. With recognized requirements: ${report.analyzedJobCount}.`)} {report.jobsWithoutDescription > 0 && c(`${report.jobsWithoutDescription} sin descripción.`, `${report.jobsWithoutDescription} without a description.`)} {report.jobsWithoutRequirements > 0 && c(`${report.jobsWithoutRequirements} sin requisitos reconocibles.`, `${report.jobsWithoutRequirements} without recognized requirements.`)}</p>
            {report.analyzedJobCount === 0 ? <p>{c('No pudimos identificar requisitos conocidos en las ofertas disponibles; esto no permite concluir si encajan con tu perfil.', 'We could not identify known requirements in the available jobs, so this report cannot determine how they fit your profile.')}</p>
              : report.groups.length === 0 ? <p>{c('No encontramos requisitos conocidos sin evidencia aprobada. Esto no garantiza que cumplas todos los requisitos.', 'No known requirements without approved profile evidence were found. This does not guarantee that every requirement is met.')}</p>
              : <ul className={styles.groups}>{report.groups.map((group) => <li key={group.skill}><details>
                <summary><span className={styles.skill}>{group.skill}</span><span className={styles.counts}>{group.requiredJobCount > 0 && <Tag tone="amber">{c(`Obligatoria en ${group.requiredJobCount}`, `Required in ${group.requiredJobCount}`)}</Tag>}{group.preferredJobCount > 0 && <Tag>{c(`Preferida en ${group.preferredJobCount}`, `Preferred in ${group.preferredJobCount}`)}</Tag>}{group.unspecifiedJobCount > 0 && <Tag>{c(`Sin clasificar en ${group.unspecifiedJobCount}`, `Unclassified in ${group.unspecifiedJobCount}`)}</Tag>}</span></summary>
                <p className={styles.evidence}>{group.profileEvidence === 'PENDING_REVIEW' ? c('Hay información sugerida en tu perfil que conviene revisar.', 'There is suggested profile information to review.') : c('No encontramos evidencia aprobada en tu perfil. Eso no significa necesariamente que te falte esa experiencia.', 'No approved profile evidence was found. That does not necessarily mean you lack this experience.')}</p>
                <ul className={styles.jobs}>{group.jobs.map((job) => <li key={job.id}><Link href={`/jobs/${job.id}`}>{job.title} · {job.company}</Link>{job.excerpt && <p>{job.excerpt}</p>}</li>)}</ul>
              </details></li>)}</ul>}
          </>}
  </Card>;
}
