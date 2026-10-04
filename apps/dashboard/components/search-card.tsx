'use client';

import { Button, Card, Tag } from '@/components/ui';
import type { Search } from '@/components/search-types';
import { searchInFlight } from '@/components/search-types';
import styles from '@/app/searches/searches.module.css';

type Props = { search: Search; selected: boolean; disabled: boolean; onSelect: () => void; onEdit: () => void; onToggle: () => void; onRefresh: () => void; t: (es: string, en: string) => string; modeLabel: (mode: Search['workMode']) => string; dateTime: (value: string) => string };
export function SearchCard({ search, selected, disabled, onSelect, onEdit, onToggle, onRefresh, t, modeLabel, dateTime }: Props) {
  const status = search.latestRun?.status ?? search.lastRunStatus;
  const inFlight = searchInFlight(search);
  const sourceFailed = search.latestRun?.sources.some((source) => ['FAILED', 'ERROR'].includes(source.status.toUpperCase())) ?? false;
  const displayName = [search.role, search.company].filter(Boolean).join(' · ') || t('Cualquier puesto', 'Any role');
  return <Card className={styles.searchCard}>
    <div className={styles.cardHead}><div><h3><button type="button" className={styles.searchTitleButton} aria-pressed={selected} aria-controls="search-results" onClick={onSelect}>{displayName}</button></h3><p>{[search.location, modeLabel(search.workMode), `${search.frequencyHours} h`].filter(Boolean).join(' · ')}</p></div><Tag tone={search.enabled ? 'green' : 'neutral'}>{search.enabled ? t('ACTIVA', 'ACTIVE') : t('PAUSADA', 'PAUSED')}</Tag></div>
    <p className={styles.searchCardMeta}>{search.lastNewCount > 0 ? t(`${search.lastNewCount} ${search.lastNewCount === 1 ? 'nueva' : 'nuevas'}`, `${search.lastNewCount} new`) : t('Sin novedades pendientes', 'No unread arrivals')} · {search.lastResultCount} {search.lastResultCount === 1 ? t('oferta', 'job') : t('ofertas', 'jobs')}</p>
    <p className={styles.searchCardMeta}>{inFlight ? t('Consulta en curso', 'Search in progress') : !search.enabled ? t('Búsqueda en pausa; no habrá consultas automáticas', 'Search paused; automatic checks are off') : status === 'FAILED' || sourceFailed ? t('Una fuente falló; conservamos los resultados anteriores', 'A source failed; previous results are preserved') : status === 'PARTIAL' ? t('Consulta parcial; revisa la cobertura', 'Partial check; review source coverage') : search.latestRun?.finishedAt ? `${t('Última consulta', 'Last checked')}: ${dateTime(search.latestRun.finishedAt)}` : t('Primera consulta pendiente', 'First search pending')}</p>
    {search.enabled && search.nextRunAt && <p className={styles.schedule}>{t('Próxima consulta: ', 'Next check: ')}{dateTime(search.nextRunAt)}</p>}
    <div className={styles.cardActions}><Button variant="quiet" disabled={disabled || inFlight} onClick={onRefresh}>{t('Actualizar resultados', 'Refresh results')}</Button><Button variant="quiet" disabled={disabled} onClick={onToggle}>{search.enabled ? t('Pausar', 'Pause') : t('Reanudar', 'Resume')}</Button><Button variant="quiet" disabled={disabled} onClick={onEdit}>{t('Editar', 'Edit')}</Button></div>
  </Card>;
}
