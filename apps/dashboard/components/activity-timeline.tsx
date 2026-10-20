'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/api';
import { copy } from '@/lib/labels';
import { describeItem, followUpLabel, formatDay, formatItemTime, formatMonth, groupByDay, monthRange, timelineTypes, typeLabel, typesParam, type Timeline, type TimelineItem, type TimelineType } from '@/lib/timeline';
import { viewerTimeZone } from '@/components/activity-calendar';
import { Button, Card, Empty, Notice, Tag } from '@/components/ui';
import styles from './activity-timeline.module.css';

const typeTone: Record<TimelineType, 'neutral' | 'green' | 'amber' | 'red' | 'blue'> = {
  JOB_FOUND: 'neutral', JOB_SAVED: 'neutral', APPLICATION_CREATED: 'blue', APPLICATION_STATUS_CHANGED: 'green', STAGE_CHANGED: 'green', INTERVIEW: 'blue', FOLLOW_UP: 'amber',
};

function TimelineEntry({ item, timeZone }: { item: TimelineItem; timeZone: string }) {
  const { locale } = useLocale();
  const text = describeItem(item, locale);
  return <li className={styles.entry}>
    <span className={styles.time}>{formatItemTime(item, timeZone, locale)}</span>
    <span className={styles.body}>
      <span className={styles.tags}>
        <Tag tone={typeTone[item.type]}>{text.label}</Tag>
        {item.followUpStatus && <Tag tone={item.followUpStatus === 'overdue' ? 'red' : item.followUpStatus === 'due-today' ? 'amber' : 'neutral'}>{followUpLabel(item.followUpStatus, locale)}</Tag>}
      </span>
      <Link href={text.href}>{text.title}</Link>
      <small>{text.detail}</small>
    </span>
  </li>;
}

export function ActivityTimeline() {
  const { locale } = useLocale();
  const c = copy(locale);
  const [month, setMonth] = useState(() => { const now = new Date(); return { year: now.getFullYear(), monthIndex: now.getMonth() }; });
  const [selected, setSelected] = useState<TimelineType[]>([...timelineTypes]);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const request = useRef(0);
  const timeZone = viewerTimeZone();

  const load = useCallback(async () => {
    const current = ++request.current;
    if (!selected.length) { setTimeline(null); setState('ready'); setError(''); return; }
    setState('loading'); setError('');
    const { from, to } = monthRange(month.year, month.monthIndex);
    try {
      const result = await api<Timeline>(`/timeline?from=${from}&to=${to}&tz=${encodeURIComponent(timeZone)}&types=${typesParam(selected)}`);
      if (current === request.current) { setTimeline(result); setState('ready'); }
    } catch (err) { if (current === request.current) { setError(errorMessage(err)); setState('error'); } }
  }, [month, selected, timeZone]);
  useEffect(() => { void load(); }, [load]);

  const move = (amount: number) => setMonth(({ year, monthIndex }) => { const next = new Date(year, monthIndex + amount, 1); return { year: next.getFullYear(), monthIndex: next.getMonth() }; });
  const toToday = () => { const now = new Date(); setMonth({ year: now.getFullYear(), monthIndex: now.getMonth() }); };
  const toggle = (type: TimelineType) => setSelected((value) => value.includes(type) ? value.filter((entry) => entry !== type) : timelineTypes.filter((entry) => entry === type || value.includes(entry)));
  const monthLabel = formatMonth(month.year, month.monthIndex, locale);
  const groups = groupByDay(timeline?.items ?? []);
  const overdue = timeline?.overdue;

  return <div className={styles.timeline}>
    {overdue && overdue.total > 0 && <Card className={styles.overdue} aria-labelledby="overdue-heading">
      <h2 id="overdue-heading">{c(`Recordatorios vencidos (${overdue.total})`, `Overdue follow-ups (${overdue.total})`)}</h2>
      <p>{c('Solicitudes abiertas cuya fecha de seguimiento ya pasó. Cambia o quita la fecha en la solicitud cuando lo resuelvas.', 'Open applications whose follow-up date has passed. Change or clear the date on the application once it is handled.')}</p>
      <ul>{overdue.items.map((item) => { const text = describeItem(item, locale); return <li key={item.id}><span className={styles.time}>{formatDay(item.day, locale, 'medium')}</span><span className={styles.body}><Link href={text.href}>{text.title}</Link><small>{text.detail}</small></span></li>; })}</ul>
      {overdue.total > overdue.items.length && <p className={styles.hint}>{c(`Se muestran ${overdue.items.length} de ${overdue.total}.`, `Showing ${overdue.items.length} of ${overdue.total}.`)}</p>}
    </Card>}

    <Card className={styles.card}>
      <div className={styles.toolbar}>
        <div className={styles.monthControls} role="group" aria-label={c('Cambiar mes', 'Change month')}>
          <Button variant="secondary" aria-label={c('Mes anterior', 'Previous month')} onClick={() => move(-1)}>‹</Button>
          <h2 aria-live="polite">{monthLabel}</h2>
          <Button variant="secondary" aria-label={c('Mes siguiente', 'Next month')} onClick={() => move(1)}>›</Button>
          <Button variant="quiet" onClick={toToday}>{c('Este mes', 'This month')}</Button>
        </div>
        <fieldset className={styles.filters}>
          <legend>{c('Mostrar', 'Show')}</legend>
          {timelineTypes.map((type) => <label key={type} className={styles.filter}>
            <input type="checkbox" checked={selected.includes(type)} onChange={() => toggle(type)}/>
            <span>{typeLabel(type, locale)}</span>
          </label>)}
        </fieldset>
      </div>

      <section aria-live="polite" aria-busy={state === 'loading'} aria-label={c(`Actividad de ${monthLabel}`, `Activity for ${monthLabel}`)}>
        {!selected.length ? <Empty title={c('Ningún tipo seleccionado', 'No type selected')} detail={c('Elige al menos un tipo de actividad para verla.', 'Choose at least one kind of activity to see it.')}/>
          : state === 'error' ? <Notice tone="error" role="alert" actions={<Button variant="secondary" onClick={() => void load()}>{c('Reintentar', 'Try again')}</Button>}>{error}</Notice>
            : state === 'loading' && !timeline ? <p className={styles.hint}>{c('Cargando actividad…', 'Loading activity…')}</p>
              : !groups.length ? <Empty title={c('Sin actividad este mes', 'No activity this month')} detail={c('Aquí aparecen las ofertas que encuentras y guardas, tus solicitudes, sus cambios, entrevistas y recordatorios con fecha.', 'Jobs you find and save, your applications and their changes, interviews and dated follow-ups appear here.')}/>
                : <ol className={styles.days}>
                  {groups.map((group) => <li key={group.day} className={styles.day}>
                    <h3>{formatDay(group.day, locale)}{group.day === timeline?.today && <> <Tag tone="blue">{c('Hoy', 'Today')}</Tag></>}</h3>
                    <ul>{group.items.map((item) => <TimelineEntry key={item.id} item={item} timeZone={timeZone}/>)}</ul>
                  </li>)}
                </ol>}
        {timeline?.truncated && <p className={styles.hint}>{c('Hay más actividad este mes de la que se muestra. Filtra por tipo para verla.', 'There is more activity this month than shown. Filter by type to see it.')}</p>}
      </section>
      <details className={styles.dataNotes}>
        <summary>{c('Sobre las fechas y la zona horaria', 'About dates and time zones')}</summary>
        <p className={styles.hint}>{c(`Las horas se muestran en tu zona horaria (${timeZone}). Los recordatorios usan la fecha que elegiste.`, `Times are shown in your time zone (${timeZone}). Follow-ups use the date you chose.`)}</p>
        <p className={styles.hint}>{c('Las ofertas guardadas antes de esta versión no tienen fecha de guardado y no aparecen aquí.', 'Jobs saved before this version have no saved date and do not appear here.')}</p>
      </details>
    </Card>
  </div>;
}
