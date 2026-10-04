'use client';

import { Card, Empty } from '@/components/ui';
import type { Search } from '@/components/search-types';
import { nextCheckLabel, searchHealth, searchName, summarize, type EmptyKind } from '@/components/lib/search-status';
import styles from '@/app/searches/searches.module.css';

type T = (es: string, en: string) => string;
type StatusProps = { scope: Search[]; single: boolean; locale: 'es' | 'en'; t: T; sourceName: (provider: string) => string; dateTime: (value: string) => string; busy: boolean; onRetry?: (search: Search) => void };

/**
 * One compact automatic-search status: what happens next, plus genuine failures or limited coverage.
 * Per-portal technical detail stays in a closed disclosure.
 */
export function SearchStatus({ scope, single, locale, t, sourceName, dateTime, busy, onRetry }: StatusProps) {
  if (!scope.length) return null;
  const summary = summarize(scope);
  const next = nextCheckLabel(summary.nextRunAt, locale);
  const anyRole = t('Cualquier puesto', 'Any role');
  const names = (items: Search[]) => items.map((search) => searchName(search, anyRole)).join(', ');
  const providers = (items: string[]) => [...new Set(items)].map(sourceName).join(', ');
  const headline = summary.active.length
    ? t('Consultando los portales ahora. Las ofertas aparecerán aquí en cuanto respondan.', 'Checking job portals now. Jobs will appear here as soon as they respond.')
    : summary.allPaused
      ? t(single ? 'Búsqueda en pausa: no buscaremos ofertas nuevas hasta que la reanudes.' : 'Búsquedas en pausa: no buscaremos ofertas nuevas hasta que reanudes alguna.', single ? 'Search paused: we will not look for new jobs until you resume it.' : 'Searches paused: we will not look for new jobs until you resume one.')
      : next ? t(`Búsqueda automática activa · próxima consulta ${next}`, `Automatic search on · next check ${next}`) : t('Búsqueda automática activa', 'Automatic search on');
  const failedRetry = single && summary.failed.length === 1 && onRetry ? summary.failed[0] : undefined;
  const partialFailures = scope.flatMap((search) => { const health = searchHealth(search); return health.state === 'limited' ? health.failedProviders : []; });
  const limitedCoverage = summary.limited.some((search) => { const health = searchHealth(search); return health.limitedProviders.length > 0 || !health.failedProviders.length; });
  const failedSources = providers(summary.failed.flatMap((search) => searchHealth(search).failedProviders));
  const withDetails = scope.filter((search) => search.latestRun?.sources?.length || search.latestRun?.error || search.lastError);
  return <section className={styles.statusBar} aria-label={t('Estado de la búsqueda automática', 'Automatic search status')}>
    <p className={styles.statusHeadline} role="status">{headline}</p>
    {!summary.allPaused && <p className={styles.statusHint}>{t('Puedes cerrar la pestaña. Deja Career Stack funcionando en tu equipo.', 'You can close this tab. Keep Career Stack running on your computer.')}</p>}
    {summary.failed.length > 0 && <p className={styles.statusProblem}>
      {single ? t('La última consulta no se pudo completar.', 'The latest check could not be completed.') : t(`No se pudo completar la última consulta de: ${names(summary.failed)}.`, `The latest check could not be completed for: ${names(summary.failed)}.`)}
      {failedSources && <>{' '}{t(`Sin respuesta de: ${failedSources}.`, `No response from: ${failedSources}.`)}</>}
      {' '}{next ? t(`Lo intentaremos de nuevo ${next}. Las ofertas ya encontradas se conservan.`, `We will try again ${next}. Jobs already found are kept.`) : t('Las ofertas ya encontradas se conservan.', 'Jobs already found are kept.')}
      {failedRetry && <>{' '}<button type="button" className={styles.inlineAction} disabled={busy} onClick={() => onRetry?.(failedRetry)}>{t('Reintentar ahora', 'Try again now')}</button></>}
    </p>}
    {partialFailures.length > 0 && <p className={styles.statusProblem}>{t(`Sin respuesta en la última consulta de: ${providers(partialFailures)}. Mostramos lo que encontraron los demás portales.`, `No response in the latest check from: ${providers(partialFailures)}. Showing what the other portals found.`)}</p>}
    {limitedCoverage && <p className={styles.statusHint}>{t('Algunos portales devolvieron solo parte de sus ofertas o datos de una consulta anterior.', 'Some portals returned only part of their jobs or data from an earlier check.')}</p>}
    {withDetails.length > 0 && <details className={styles.statusDetails}>
      <summary>{t('Detalles por portal', 'Details by portal')}</summary>
      {withDetails.map((search) => <SearchProgress key={search.id} search={search} heading={single ? undefined : searchName(search, anyRole)} t={t} sourceName={sourceName} dateTime={dateTime} />)}
    </details>}
  </section>;
}

function SearchProgress({ search, heading, t, sourceName, dateTime }: { search: Search; heading?: string; t: T; sourceName: (provider: string) => string; dateTime: (value: string) => string }) {
  const run = search.latestRun;
  const errorCopy = t('No se pudo consultar este portal. Conservamos los resultados anteriores.', 'This portal could not be checked. Previous results are kept.');
  return <div className={styles.progressBlock}>
    {heading && <h3>{heading}</h3>}
    <p className={styles.statusHint}>{run?.finishedAt ? `${t('Última consulta', 'Last check')}: ${dateTime(run.finishedAt)} · ${label(run.status, t)}` : run ? label(run.status, t) : search.lastRunAt ? `${t('Última consulta', 'Last check')}: ${dateTime(search.lastRunAt)}` : t('Sin consultas todavía', 'No checks yet')}</p>
    {(run?.error || search.lastError) && <p className={styles.warning}>{t('La consulta terminó con un error.', 'The check ended with an error.')}</p>}
    {(run?.sources?.length ?? 0) > 0 && <ul className={styles.sourceProgress}>{run!.sources.map((source) => <li key={source.provider}>
      <span><strong>{sourceName(source.provider)}</strong> · {label(source.status, t)}</span>
      <span>{source.coverage ? label(source.coverage, t) : t('Cobertura aún desconocida', 'Coverage not known yet')}{source.fetchedAt ? ` · ${dateTime(source.fetchedAt)}` : ''}</span>
      {source.error && <span className={styles.warning}>{errorCopy}</span>}
      {source.nextFetchAt && <span>{t('Puede volver a consultarse: ', 'Can be checked again: ')}{dateTime(source.nextFetchAt)}</span>}
    </li>)}</ul>}
  </div>;
}

function label(value: string, t: T) {
  const labels: Record<string, [string, string]> = {
    QUEUED: ['En cola', 'Queued'], RUNNING: ['Consultando', 'Checking'], SUCCEEDED: ['Completada', 'Complete'], PARTIAL: ['Completada con cobertura limitada', 'Completed with limited coverage'], FAILED: ['Error', 'Failed'], ERROR: ['Error', 'Error'], CANCELLED: ['Cancelada', 'Cancelled'], FRESH: ['Datos recién consultados', 'Fresh results'], CACHED: ['Resultados recientes guardados', 'Recent saved results'],
    COMPLETE: ['Respuesta completa', 'Complete response'], BOUNDED: ['Solo una parte de las ofertas', 'Only part of the jobs'], STALE: ['Datos de una consulta anterior', 'Results from an earlier check'], PENDING: ['Pendiente', 'Pending'], SKIPPED: ['No consultado', 'Not checked'], NOT_STARTED: ['Pendiente', 'Pending'], RATE_LIMITED: ['Límite temporal de consultas', 'Temporary request limit'],
  };
  const pair = labels[value.toUpperCase()];
  return pair ? t(pair[0], pair[1]) : t('Estado disponible', 'Status available');
}

type EmptyProps = {
  kind: EmptyKind; matchesTotal: number | null; nextCheck: string; busy: boolean; t: T;
  onRetry: () => void; onShowAll: () => void; onResume?: () => void; onRefresh?: () => void;
  edit?: { label: string; onClick: () => void };
};

/** Distinct, truthful copy for each empty result state (U01/U04). */
export function SearchEmptyState({ kind, matchesTotal, nextCheck, busy, t, onRetry, onShowAll, onResume, onRefresh, edit }: EmptyProps) {
  const next = (es: string, en: string) => nextCheck ? t(`${es} ${nextCheck}.`, `${en} ${nextCheck}.`) : '';
  const copy: Record<EmptyKind, [string, string]> = {
    loadError: [t('No pudimos cargar los resultados', 'Could not load results'), t('Vuelve a intentarlo. Esto no inicia otra consulta a los portales.', 'Try again. This does not start a new portal check.')],
    noSaved: [t('Aún no has guardado ofertas', 'No saved jobs yet'), t('Pulsa Guardar en las ofertas que te interesen y las encontrarás aquí.', 'Select Save on jobs that interest you and you will find them here.')],
    noArchived: [t('No hay ofertas archivadas', 'No archived jobs'), t('Las ofertas que archives aparecerán aquí y podrás recuperarlas.', 'Jobs you archive appear here so you can restore them.')],
    searching: [t('Estamos buscando ofertas', 'Searching for jobs'), t('Las ofertas aparecerán aquí en cuanto respondan los portales. Puedes cerrar esta pestaña mientras tanto.', 'Jobs will appear here as soon as the portals respond. You can close this tab meanwhile.')],
    paused: [t('Búsqueda en pausa', 'Search paused'), t('No buscaremos ofertas nuevas hasta que la reanudes.', 'We will not look for new jobs until you resume it.')],
    failed: [t('No pudimos completar la última consulta', 'Could not complete the latest check'), [next('Lo intentaremos de nuevo', 'We will try again'), matchesTotal ? t(`Las ${matchesTotal} ofertas ya encontradas siguen en Todas.`, `The ${matchesTotal} jobs already found are still in All.`) : ''].filter(Boolean).join(' ') || t('Puedes reintentarlo ahora.', 'You can try again now.')],
    pending: [t('Tu primera consulta está a punto de empezar', 'Your first check is about to start'), t('Las ofertas aparecerán aquí en cuanto respondan los portales.', 'Jobs will appear here as soon as the portals respond.')],
    noMatches: [t('Todavía no hay coincidencias', 'No matches yet'), [t('Todavía no encontramos ofertas con estos criterios.', 'We have not found jobs matching these criteria yet.'), next('Volveremos a buscar', 'We will check again'), t('Para ver más, prueba a quitar la ubicación o incluir puestos relacionados.', 'To see more, try removing the location or including related roles.')].filter(Boolean).join(' ')],
    caughtUp: [t('No hay ofertas nuevas por revisar', 'No new jobs to review'), [t(`Ya viste ${matchesTotal === 1 ? 'la oferta encontrada; sigue' : `las ${matchesTotal} ofertas encontradas; siguen`} en Todas.`, `You have seen ${matchesTotal === 1 ? 'the job found; it is' : `the ${matchesTotal} jobs found; they are`} still in All.`), next('Próxima consulta', 'Next check')].filter(Boolean).join(' ')],
    unknown: [t('No hay ofertas que mostrar', 'No jobs to show'), t('Prueba con otro filtro o vuelve más tarde.', 'Try another filter or come back later.')],
  };
  const [title, detail] = copy[kind];
  const action = kind === 'loadError' ? <button className="button button-secondary" type="button" onClick={onRetry}>{t('Reintentar', 'Try again')}</button>
    : kind === 'paused' && onResume ? <button className="button button-secondary" type="button" disabled={busy} onClick={onResume}>{t('Reanudar búsqueda', 'Resume search')}</button>
    : kind === 'failed' && onRefresh ? <button className="button button-secondary" type="button" disabled={busy} onClick={onRefresh}>{t('Reintentar ahora', 'Try again now')}</button>
    : kind === 'caughtUp' ? <button className="button button-secondary" type="button" onClick={onShowAll}>{t('Ver las ofertas ya vistas', 'Show jobs already seen')}</button>
    : kind === 'noMatches' && edit ? <button className="button button-secondary" type="button" disabled={busy} onClick={edit.onClick}>{edit.label}</button>
    : null;
  return <Card className={styles.emptyResults}><Empty title={title} detail={detail} action={action ? <div className={styles.actions}>{action}</div> : undefined} /></Card>;
}
