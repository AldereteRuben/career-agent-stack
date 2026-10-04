'use client';

import { Button, Tag } from '@/components/ui';
import type { Search } from '@/components/search-types';
import { nextCheckLabel, searchHealth, searchName, type SearchState } from '@/components/lib/search-status';
import styles from '@/app/searches/searches.module.css';

type Props = { search: Search; selected: boolean; disabled: boolean; locale: 'es' | 'en'; onSelect: () => void; onEdit: () => void; onToggle: () => void; onRefresh: () => void; t: (es: string, en: string) => string; modeLabel: (mode: Search['workMode']) => string };

const tones: Record<SearchState, 'neutral' | 'green' | 'amber' | 'red' | 'blue'> = { queued: 'blue', running: 'blue', paused: 'neutral', failed: 'red', limited: 'amber', pending: 'blue', ready: 'green' };

/** Compact management row: one state, unread count and the actions to show, edit, pause/resume or check now. */
export function SearchCard({ search, selected, disabled, locale, onSelect, onEdit, onToggle, onRefresh, t, modeLabel }: Props) {
  const health = searchHealth(search);
  const name = searchName(search, t('Cualquier puesto', 'Any role'));
  const nameId = `search-name-${search.id}`;
  const next = nextCheckLabel(search.nextRunAt, locale);
  const stateText: Record<SearchState, string> = {
    queued: t('En cola', 'Queued'), running: t('Buscando ahora', 'Searching now'), paused: t('En pausa', 'Paused'),
    failed: t('Última consulta fallida', 'Last check failed'), limited: t('Resultados parciales', 'Partial results'),
    pending: t('Primera consulta pendiente', 'First check pending'), ready: t('Activa', 'Active'),
  };
  return <li className={`${styles.manageRow} ${selected ? styles.manageRowSelected : ''}`}>
    <div className={styles.manageMain}>
      <h3 id={nameId}>{name}</h3>
      <p>{[search.location, modeLabel(search.workMode), t(`cada ${search.frequencyHours} h`, `every ${search.frequencyHours} h`)].filter(Boolean).join(' · ')}</p>
      <p className={styles.manageMeta}><Tag tone={tones[health.state]}>{stateText[health.state]}</Tag>
        <span>{search.lastNewCount > 0 ? t(`${search.lastNewCount} ${search.lastNewCount === 1 ? 'nueva' : 'nuevas'}`, `${search.lastNewCount} new`) : t('Sin ofertas nuevas', 'No new jobs')}</span>
        {search.enabled && next && !['queued', 'running'].includes(health.state) && <span>{t(`Próxima: ${next}`, `Next: ${next}`)}</span>}
      </p>
    </div>
    <div className={styles.cardActions}>
      {!selected && <Button variant="quiet" disabled={disabled} aria-describedby={nameId} onClick={onSelect}>{t('Ver ofertas', 'Show jobs')}</Button>}
      <Button variant="quiet" disabled={disabled} aria-describedby={nameId} onClick={onEdit}>{t('Editar', 'Edit')}</Button>
      <Button variant="quiet" disabled={disabled} aria-describedby={nameId} onClick={onToggle}>{search.enabled ? t('Pausar', 'Pause') : t('Reanudar', 'Resume')}</Button>
      <Button variant="quiet" disabled={disabled || health.state === 'queued' || health.state === 'running'} aria-describedby={nameId} onClick={onRefresh}>{t('Buscar ahora', 'Check now')}</Button>
    </div>
  </li>;
}
