'use client';

import { Card, Empty, Notice } from '@/components/ui';
import type { Search } from '@/components/search-types';
import { searchInFlight } from '@/components/search-types';
import styles from '@/app/searches/searches.module.css';

type Props = { search: Search; t: (es: string, en: string) => string; sourceName: (provider: string) => string; dateTime: (value: string) => string };
export function SearchProgress({ search, t, sourceName, dateTime }: Props) {
  const run = search.latestRun;
  const waiting = searchInFlight(search);
  const errorCopy = t('No se pudo consultar esta fuente. Conservamos los resultados anteriores.', 'A source could not be checked. Previous results are preserved.');
  if (!run?.sources?.length && !waiting && !run?.error && !search.lastError) return null;
  return <Card className={styles.progressCard} aria-label={t('Progreso de fuentes', 'Source progress')}>
    <h3>{waiting ? t('Buscando en tus fuentes', 'Checking your sources') : t('Resultado de la última consulta', 'Latest search status')}</h3>
    {waiting && <Notice>{t('Tu búsqueda está guardada. Mostraremos cada oferta cuando las fuentes respondan; todavía no significa que no haya coincidencias.', 'Your search is saved. We will show jobs as sources respond; this does not mean there are no matches yet.')}</Notice>}
    {run?.error && <p className={styles.warning}>{errorCopy}</p>}
    <ul className={styles.sourceProgress}>{(run?.sources ?? []).map((source) => <li key={source.provider}>
      <span><strong>{sourceName(source.provider)}</strong> · {label(source.status, t)}</span>
      <span>{source.coverage ? label(source.coverage, t) : t('Cobertura aún desconocida', 'Coverage not known yet')}{source.fetchedAt ? ` · ${dateTime(source.fetchedAt)}` : ''}{source.error ? ` · ${errorCopy}` : ''}</span>
      {source.nextFetchAt && <span>{t('Puede volver a consultarse: ', 'Can be checked again: ')}{dateTime(source.nextFetchAt)}</span>}
    </li>)}</ul>
    {search.lastError && <p className={styles.warning}>{errorCopy}</p>}
  </Card>;
}

function label(value: string, t: (es: string, en: string) => string) {
  const labels: Record<string, [string, string]> = {
    QUEUED: ['En cola', 'Queued'], RUNNING: ['Consultando', 'Checking'], SUCCEEDED: ['Completada', 'Complete'], PARTIAL: ['Parcial', 'Partial'], FAILED: ['Error', 'Failed'], ERROR: ['Error', 'Error'], CANCELLED: ['Cancelada', 'Cancelled'], FRESH: ['Datos recién consultados', 'Fresh results'], CACHED: ['Resultados guardados', 'Saved results'],
    COMPLETE: ['Respuesta de la fuente completa', 'Source response complete'], BOUNDED: ['Cobertura parcial', 'Partial coverage'], STALE: ['Datos de una consulta anterior', 'Results from an earlier check'], PENDING: ['Pendiente', 'Pending'], SKIPPED: ['No consultada', 'Not checked'], NOT_STARTED: ['Pendiente', 'Pending'], RATE_LIMITED: ['Límite temporal de consultas', 'Temporary request limit'],
  };
  const pair = labels[value.toUpperCase()];
  return pair ? t(pair[0], pair[1]) : t('Estado de la fuente actualizado', 'Source status available');
}

export function SearchEmptyState({ search, view, caughtUp = false, error, inProgress = false, paused = false, sourceError = false, onRetry, onEdit, onResume, t }: { search?: Search; view: 'new' | 'all' | 'saved' | 'archived'; caughtUp?: boolean; error: boolean; inProgress?: boolean; paused?: boolean; sourceError?: boolean; onRetry: () => void; onEdit?: () => void; onResume?: () => void; t: (es: string, en: string) => string }) {
  const inFlight = inProgress || searchInFlight(search);
  if (!error && (view === 'saved' || view === 'archived')) return <Card className={styles.emptyResults}><Empty
    title={view === 'saved' ? t('Aún no has guardado ofertas de estas búsquedas', 'No saved jobs from these searches yet') : t('No hay ofertas archivadas', 'No archived jobs')}
    detail={view === 'saved' ? t('En Todas, pulsa Guardar en las ofertas que te interesen.', 'In All, save the jobs that interest you.') : t('Las ofertas que archives aparecerán aquí y podrás restaurarlas.', 'Archived jobs will appear here so you can restore them.')} /></Card>;
  if (inFlight) return <Card className={styles.emptyResults}><Empty title={t('Estamos buscando ofertas', 'Searching for jobs')} detail={t('Tu búsqueda está guardada. Los resultados aparecerán aquí cuando respondan las fuentes.', 'Your search is saved. Results will appear here as sources respond.')} /></Card>;
  const upToDate = view === 'new' && caughtUp && !error && !paused && !sourceError && !inFlight;
  return <Card className={styles.emptyResults}><Empty title={error ? t('No pudimos cargar los resultados', 'Could not load results') : paused ? t('Esta búsqueda está en pausa', 'This search is paused') : sourceError ? t('Una fuente no respondió', 'A source did not respond') : upToDate ? t('Estás al día', 'You are up to date') : search && !search.latestRun?.finishedAt && !search.lastRunAt ? t('Tu primera consulta está pendiente', 'Your first search is pending') : search?.latestRun?.status === 'FAILED' ? t('No pudimos completar la búsqueda', 'Could not complete the search') : t('No encontramos coincidencias en las fuentes consultadas', 'No matches in the checked sources')} detail={error ? t('Vuelve a cargar la lista. Esto no inicia otra consulta a las fuentes.', 'Reload the list. This does not start a new source request.') : paused ? t('No habrá consultas automáticas hasta que reanudes esta búsqueda.', 'Automatic checks will stay off until you resume this search.') : sourceError || search?.latestRun?.status === 'FAILED' ? t('Conservamos las ofertas anteriores. Revisa el estado y la cobertura de cada fuente.', 'Previous jobs are preserved. Check each source status and its coverage.') : upToDate ? t('Has revisado todas las novedades disponibles. La próxima consulta se mostrará en la tarjeta de búsqueda.', 'You have reviewed all available new jobs. The next check appears on the search card.') : t('Puedes ampliar o cambiar tus criterios. Las fuentes pueden no cubrir todos los portales o ubicaciones.', 'You can broaden or change your criteria. Sources may not cover every job board or location.')} />
    {!error && <div className={styles.actions}>{paused && onResume ? <button className="button button-secondary" type="button" onClick={onResume}>{t('Reanudar búsqueda', 'Resume search')}</button> : onEdit && <button className="button button-secondary" type="button" onClick={onEdit}>{t('Editar búsqueda', 'Edit search')}</button>}</div>}
    {error && <div className={styles.actions}><button className="button button-secondary" type="button" onClick={onRetry}>{t('Reintentar', 'Try again')}</button></div>}
  </Card>;
}
