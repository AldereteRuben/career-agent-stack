'use client';

import Link from 'next/link';
import { Button, Card } from '@/components/ui';
import { labelFor } from '@/lib/labels';
import type { SearchJob, SearchView } from '@/components/search-types';
import styles from '@/app/searches/searches.module.css';

type Props = { aiAvailable?: boolean; job: SearchJob; returnTo: string; view: SearchView; busy: boolean; t: (es: string, en: string) => string; sourceName: (provider: string) => string; onSave: () => void; onUnsave: () => void; onArchive: () => void; onReview: () => void };
const reasonText: Record<string, [string, string]> = {
  ROLE_EXACT: ['Título de puesto coincidente', 'Job title matches'], ROLE_EQUIVALENT: ['Puesto equivalente', 'Equivalent role'], ROLE_RELATED: ['Puesto relacionado', 'Related role'], ROLE_NONE: ['El puesto no coincide claramente', 'Role is not a clear match'],
  COMPANY_MATCH: ['Empresa coincidente', 'Company matches'], COMPANY_MISMATCH: ['La empresa no coincide', 'Company does not match'], WORK_MODE_MATCH: ['Modalidad coincidente', 'Work mode matches'], WORK_MODE_UNKNOWN: ['Modalidad sin confirmar', 'Work mode is unknown'], WORK_MODE_MISMATCH: ['Modalidad distinta', 'Work mode differs'],
  LOCATION_COMPATIBLE: ['Ubicación compatible', 'Location is compatible'], LOCATION_INCOMPATIBLE: ['Ubicación incompatible', 'Location does not match'], LOCATION_UNKNOWN: ['Restricciones de ubicación desconocidas', 'Location restrictions are unknown'], LOCATION_NOT_REQUESTED: ['No filtrada por ubicación', 'Location was not a filter'],
  MATCH_V1_LEGACY: ['Coincide con las reglas originales de búsqueda', 'Matches the original search rules'], NO_MATCH_V1_LEGACY: ['No coincide claramente con la búsqueda', 'Does not clearly match the search'], NO_FILTERS: ['Sin filtros adicionales', 'No additional filters'],
};
function shownReason(reason: string, spanish: boolean) { return reasonText[reason]?.[spanish ? 0 : 1] ?? (spanish ? 'Otra coincidencia con tus criterios' : 'Another search criterion matches'); }
function formatDate(value: string, spanish: boolean) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(spanish ? 'es-ES' : 'en-GB', { dateStyle: 'medium' }).format(date); }

/** Role, company, location and the main reason first; the three main decisions; everything else on demand. */
export function SearchResultCard({ aiAvailable = false, job, returnTo, view, busy, t, sourceName, onSave, onUnsave, onArchive, onReview }: Props) {
  const saved = job.shortlistDecision === 'SHORTLISTED'; const archived = job.shortlistDecision === 'ARCHIVED';
  const spanish = t('es', 'en') === 'es';
  const reasons = (job.searchReasons ?? []).map((reason) => shownReason(reason, spanish));
  const jobHref = `/jobs/${job.id}?returnTo=${encodeURIComponent(returnTo)}`;
  const applicationHref = job.applicationId ? `/applications?id=${encodeURIComponent(job.applicationId)}&returnTo=${encodeURIComponent(returnTo)}` : null;
  const applicationLabel = ['UNKNOWN', 'IN_PROGRESS', 'CONFIRMED', 'CANCELLED'].includes(job.applicationState ?? '') ? t('Ver seguimiento', 'View application status') : t('Ver candidatura', 'View application');
  const unknownLocation = job.locationStatus?.toLowerCase() === 'unknown' || job.unknownLocation;
  const portals = [...new Map(job.sources.map((source) => [source.provider, source])).values()];
  const published = job.sources.filter((source) => source.postedAt).slice(0, 2);
  const checked = job.sources.filter((source) => source.fetchedAt && Number.isFinite(Date.parse(source.fetchedAt)));
  const canReview = view === 'new' && !job.seenAt;
  const titleId = `result-title-${job.id}`;
  return <Card className={styles.resultCard}>
    <div className={styles.resultMain}>
      <h3 id={titleId}><Link href={jobHref} data-result-id={job.id}>{job.title}</Link></h3>
      <p className={styles.resultMeta}>{job.company} · {job.location || t('Ubicación sin indicar', 'Location not listed')}</p>
      <p className={styles.resultReason}>{reasons[0] ?? t('Coincide con tus criterios', 'Matches your criteria')}</p>
      {unknownLocation && <p className={styles.warning}>{t('Comprueba en el anuncio desde qué países se puede trabajar.', 'Check eligible countries in the original listing.')}</p>}
      {job.identityConflict && <p className={styles.warning}>{t('Esta oferta tiene registros con decisiones o candidaturas diferentes. Los conservamos por separado.', 'This job has records with different decisions or applications. We kept them separate.')}</p>}
      {job.autoPrepareError && job.autoPrepareError !== 'EXISTING_APPLICATION' && <p className={styles.warning}>{job.autoPrepareError === 'PREPARING' ? t('Preparando tu candidatura…', 'Preparing your application…') : t('La preparación necesita tu revisión. Abre la oferta para continuar.', 'Preparation needs your review. Open the job to continue.')}</p>}
      {job.applicationId && <p className={styles.applicationStatus}>{t('Candidatura existente', 'Existing application')} · {labelFor.applicationState(job.applicationState, spanish ? 'es' : 'en')}{job.documentApprovalStatus ? ` · ${labelFor.documentApproval(job.documentApprovalStatus, spanish ? 'es' : 'en')}` : ''}</p>}
    </div>
    <div className={styles.resultActions}>
      <Link className="button" href={applicationHref ?? jobHref} aria-describedby={titleId}>{applicationHref ? applicationLabel : t('Ver oferta', 'View job')}</Link>
      {aiAvailable && <Link className="button button-secondary" href={`${jobHref}#job-ai-assistance`} aria-describedby={titleId}>{['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(job.aiSummaryStates?.[spanish ? 'es' : 'en'] ?? '') ? t('Resumen en preparación', 'Summary in progress') : job.aiSummaryStates?.[spanish ? 'es' : 'en'] === 'SAVED' ? t('Ver resumen guardado', 'View saved summary') : t('Resumir esta oferta', 'Summarize this job')}</Link>}
      {!archived && <Button variant="secondary" disabled={busy} aria-pressed={saved} aria-describedby={titleId} onClick={saved ? onUnsave : onSave}>{saved ? t('Quitar de guardadas', 'Unsave job') : t('Guardar oferta', 'Save job')}</Button>}
      <Button variant="quiet" disabled={busy} aria-describedby={titleId} onClick={onArchive}>{archived ? t('Recuperar', 'Restore') : t('Archivar', 'Archive')}</Button>
    </div>
    <details className={styles.moreReasons}>
      <summary aria-describedby={titleId}>{t('Más detalles', 'More details')}</summary>
      <div className={styles.resultDetails}>
        {portals.length > 0 && <p className={styles.sources}>{t('Publicada en', 'Listed on')} {portals.map((source, index) => <span key={source.provider}>{index > 0 && ', '}<a href={source.url} target="_blank" rel="noopener noreferrer">{sourceName(source.provider)}</a></span>)}</p>}
        {reasons.length > 1 && <ul>{reasons.slice(1).map((reason, index) => <li key={`${reason}:${index}`}>{reason}</li>)}</ul>}
        {published.map((source) => <small key={`${source.provider}:${source.url}:${source.postedAt}`}>{t('Publicada', 'Published')} · {sourceName(source.provider)} · {formatDate(source.postedAt!, spanish)}</small>)}
        {job.matchedAt && <small>{t('Encontrada', 'Found')} · {formatDate(job.matchedAt, spanish)}</small>}
        {checked.map((source) => <small key={`checked:${source.provider}:${source.url}`}>{t('Comprobada', 'Checked')} · {sourceName(source.provider)} · {formatDate(source.fetchedAt!, spanish)}</small>)}
        {(job.duplicateCount ?? 0) > 1 && <small>{t(`Publicada en ${job.duplicateCount} sitios; la mostramos una vez.`, `Listed in ${job.duplicateCount} places; shown once.`)}</small>}
        <div className={styles.actions}>
          {canReview && <Button variant="quiet" disabled={busy} aria-describedby={titleId} onClick={onReview}>{t('Marcar como revisada', 'Mark as reviewed')}</Button>}
          {job.canonicalUrl && <a className="button button-quiet" href={job.canonicalUrl} target="_blank" rel="noopener noreferrer">{t('Anuncio original', 'Original listing')}</a>}
        </div>
      </div>
    </details>
  </Card>;
}
