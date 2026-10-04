'use client';

import Link from 'next/link';
import { Button, Card } from '@/components/ui';
import { labelFor } from '@/lib/labels';
import type { Search, SearchJob, SearchView } from '@/components/search-types';
import styles from '@/app/searches/searches.module.css';

type Props = { job: SearchJob; returnTo: string; view: SearchView; latestRun?: Search['latestRun']; busy: boolean; t: (es: string, en: string) => string; sourceName: (provider: string) => string; onSave: () => void; onArchive: () => void; onReview: () => void };
const reasonText: Record<string, [string, string]> = {
  ROLE_EXACT: ['Título de puesto coincidente', 'Job title matches'], ROLE_EQUIVALENT: ['Puesto equivalente', 'Equivalent role'], ROLE_RELATED: ['Puesto relacionado', 'Related role'], ROLE_NONE: ['El puesto no coincide claramente', 'Role is not a clear match'],
  COMPANY_MATCH: ['Empresa coincidente', 'Company matches'], COMPANY_MISMATCH: ['La empresa no coincide', 'Company does not match'], WORK_MODE_MATCH: ['Modalidad coincidente', 'Work mode matches'], WORK_MODE_UNKNOWN: ['Modalidad sin confirmar', 'Work mode is unknown'], WORK_MODE_MISMATCH: ['Modalidad distinta', 'Work mode differs'],
  LOCATION_COMPATIBLE: ['Ubicación compatible', 'Location is compatible'], LOCATION_INCOMPATIBLE: ['Ubicación incompatible', 'Location does not match'], LOCATION_UNKNOWN: ['Restricciones de ubicación desconocidas; compruébalas en el anuncio', 'Location restrictions are unknown; check the original listing'], LOCATION_NOT_REQUESTED: ['No filtrada por ubicación', 'Location was not a filter'],
  MATCH_V1_LEGACY: ['Coincide con las reglas originales de búsqueda', 'Matches the original search rules'], NO_MATCH_V1_LEGACY: ['No coincide claramente con la búsqueda', 'Does not clearly match the search'], NO_FILTERS: ['Sin filtros adicionales', 'No additional filters'],
};
function shownReason(reason: string, spanish: boolean) { return reasonText[reason]?.[spanish ? 0 : 1] ?? (spanish ? 'Otra coincidencia con tus criterios' : 'Another search criterion matches'); }
function formatDate(value: string, spanish: boolean) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(spanish ? 'es-ES' : 'en-GB', { dateStyle: 'medium' }).format(date); }
export function SearchResultCard({ job, returnTo, view, busy, t, sourceName, onSave, onArchive, onReview }: Props) {
  const saved = job.shortlistDecision === 'SHORTLISTED'; const archived = job.shortlistDecision === 'ARCHIVED';
  const spanish = t('es', 'en') === 'es';
  const reasons = (job.searchReasons ?? []).map((reason) => shownReason(reason, spanish));
  const published = job.sources.filter((source) => source.postedAt).slice(0, 2);
  const checked = job.sources.filter((source) => source.fetchedAt && Number.isFinite(Date.parse(source.fetchedAt)));
  const applicationHref = job.applicationId ? `/applications?id=${encodeURIComponent(job.applicationId)}&returnTo=${encodeURIComponent(returnTo)}` : null;
  const applicationLabel = ['UNKNOWN','IN_PROGRESS','CONFIRMED','CANCELLED'].includes(job.applicationState ?? '')
    ? t('Ver seguimiento', 'View application status') : t('Ver candidatura', 'View application');
  const unknownLocation = job.locationStatus?.toLowerCase() === 'unknown' || job.unknownLocation;
  return <Card className={styles.resultCard}>
    <div className={styles.resultMain}>
      <h3><Link href={`/jobs/${job.id}?returnTo=${encodeURIComponent(returnTo)}`}>{job.title}</Link></h3>
      <p>{job.company} · {job.location || t('Ubicación sin indicar', 'Location not listed')}</p>
      <ul className={styles.reasonList}>{(reasons.length ? reasons : [t('Coincidencia con tus criterios', 'Matches your criteria')]).slice(0, 2).map((reason, index) => <li key={`${reason}:${index}`}>{reason}</li>)}</ul>
      {reasons.length > 2 && <details className={styles.moreReasons}><summary>{t(`Ver ${reasons.length - 2} razones más`, `Show ${reasons.length - 2} more reasons`)}</summary><ul>{reasons.slice(2).map((reason, index) => <li key={`${reason}:${index}`}>{reason}</li>)}</ul></details>}
      {published.map((source) => <small key={`${source.provider}:${source.url}:${source.postedAt}`} className={styles.searchCardMeta}>{t('Publicada', 'Published')} · {sourceName(source.provider)} · {formatDate(source.postedAt!, spanish)}</small>)}
      {job.matchedAt && <small className={styles.searchCardMeta}>{t('Encontrada por esta búsqueda', 'Found by this search')} · {formatDate(job.matchedAt, spanish)}</small>}
      {checked.map((source) => <small key={`checked:${source.provider}:${source.url}`} className={styles.searchCardMeta}>{t('Comprobada', 'Checked')} · {sourceName(source.provider)} · {formatDate(source.fetchedAt!, spanish)}</small>)}
      {unknownLocation && <p className={styles.warning}>{t('No conocemos todas las restricciones geográficas. Comprueba desde qué países puedes trabajar en el anuncio original.', 'Some geographic restrictions are unknown. Check eligible countries in the original listing.')}</p>}
      {job.duplicateCount && job.duplicateCount > 1 && <p className={styles.searchCardMeta}>{t(`Estas fuentes identifican la misma oferta (${job.duplicateCount} publicaciones).`, `These sources identify the same vacancy (${job.duplicateCount} listings).`)}</p>}
      {job.identityConflict && <p className={styles.warning}>{t('Esta oferta tiene registros con decisiones o candidaturas diferentes. Los conservamos por separado.', 'This job has records with different decisions or applications. We kept them separate.')}</p>}
      {job.autoPrepareError && job.autoPrepareError !== 'EXISTING_APPLICATION' && <p className={styles.warning}>{job.autoPrepareError === 'PREPARING' ? t('Preparando tu candidatura…', 'Preparing your application…') : t('La preparación necesita tu revisión. Abre la oferta para continuar.', 'Preparation needs your review. Open the job to continue.')}</p>}
      {job.applicationId && <div className={styles.applicationStatus}>
        <p>{t('Candidatura existente', 'Existing application')} · {labelFor.applicationState(job.applicationState, spanish ? 'es' : 'en')}{job.documentApprovalStatus ? ` · ${labelFor.documentApproval(job.documentApprovalStatus, spanish ? 'es' : 'en')}` : ''}</p>
      </div>}
      <div className={styles.sources}>{job.sources.map((source) => <a key={`${source.provider}:${source.url}`} href={source.url} target="_blank" rel="noopener noreferrer">{sourceName(source.provider)}</a>)}</div>
    </div>
    <div className={styles.resultActions}>
      <Link className="button" href={applicationHref ?? `/jobs/${job.id}?returnTo=${encodeURIComponent(returnTo)}`}>{applicationHref ? applicationLabel : t('Ver oferta', 'Open job')}</Link>
      <Button variant="secondary" disabled={busy || saved || archived} onClick={onSave}>{saved ? t('Guardada', 'Saved') : t('Guardar', 'Save')}</Button>
      <Button variant="quiet" disabled={busy} onClick={onArchive}>{archived ? t('Restaurar', 'Restore') : t('Archivar', 'Archive')}</Button>
      {view === 'new' && !job.seenAt && <Button variant="quiet" disabled={busy} onClick={onReview}>{t('Marcar revisada', 'Mark reviewed')}</Button>}
      {job.canonicalUrl && <a className="button button-quiet" href={job.canonicalUrl} target="_blank" rel="noopener noreferrer">{t('Anuncio original', 'Original listing')}</a>}
    </div>
  </Card>;
}
