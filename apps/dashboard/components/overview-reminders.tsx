'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { describeItem, formatDay, formatItemTime, type Timeline, type TimelineItem } from '@/lib/timeline';
import { viewerTimeZone } from '@/components/activity-calendar';
import { useLocalRefresh } from '@/lib/local-refresh';
import { Button, Card } from '@/components/ui';
import styles from './overview-reminders.module.css';

// The API range includes both endpoints: today plus 29 days is 30 local calendar days.
const horizonDays = 29;

function dayRange(timeZone: string): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: 'year' | 'month' | 'day') => parts.find((value) => value.type === type)?.value ?? '';
  const from = `${part('year')}-${part('month')}-${part('day')}`;
  const lastDay = new Date(`${from}T00:00:00.000Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() + horizonDays);
  return { from, to: lastDay.toISOString().slice(0, 10) };
}

function ReminderItem({ item, timeZone }: { item: TimelineItem; timeZone: string }) {
  const { locale } = useLocale();
  const description = describeItem(item, locale);
  return <li className={styles.item}>
    <time className={styles.date} dateTime={item.day}>
      {formatDay(item.day, locale, 'medium')}{item.at ? ` · ${formatItemTime(item, timeZone, locale)}` : ''}
    </time>
    <span className={styles.body}>
      <Link href={description.href}>{description.title}</Link>
      <small>{description.label}{description.detail ? ` · ${description.detail}` : ''}</small>
    </span>
  </li>;
}

export function OverviewReminders() {
  const { locale } = useLocale();
  const c = copy(locale);
  const timeZone = viewerTimeZone();
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState('');
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setError('');
    const { from, to } = dayRange(timeZone);
    try {
      const result = await api<Timeline>(`/timeline?from=${from}&to=${to}&tz=${encodeURIComponent(timeZone)}&types=INTERVIEW,FOLLOW_UP`);
      if (current === request.current) setTimeline(result);
    } catch (reason) {
      if (current === request.current) setError(errorMessage(reason));
    }
  }, [timeZone]);

  useEffect(() => { void load(); }, [load]);
  useLocalRefresh(load);

  const overdue = timeline?.overdue.items.slice(0, 3) ?? [];
  const upcoming = timeline?.items
    .filter((item) => item.type === 'INTERVIEW' || (item.type === 'FOLLOW_UP' && item.followUpStatus !== 'overdue'))
    .slice(0, 3) ?? [];

  if (!timeline && !error) return null;
  if (error) return <Card className={styles.card} aria-labelledby="overview-reminders-heading">
    <div className={styles.heading}>
      <h2 id="overview-reminders-heading">{c('Tu seguimiento', 'Your follow-up')}</h2>
      <Link href="/timeline" className="text-link">{c('Ver calendario', 'Open timeline')}</Link>
    </div>
    <div role="status" className={styles.footer}>
      <p className={styles.muted}>{c('No pudimos actualizar tus próximos eventos.', 'We could not refresh your upcoming events.')}</p>
      <Button variant="secondary" onClick={() => void load()}>{c('Reintentar', 'Try again')}</Button>
    </div>
  </Card>;
  if (!timeline || (overdue.length === 0 && upcoming.length === 0)) return null;

  return <Card className={styles.card} aria-labelledby="overview-reminders-heading">
    <div className={styles.heading}>
      <h2 id="overview-reminders-heading">{c('Tu seguimiento', 'Your follow-up')}</h2>
      <Link href="/timeline" className="text-link">{c('Ver calendario', 'Open timeline')}</Link>
    </div>

    <div className={styles.groups}>
      {overdue.length > 0 && <section className={styles.group} aria-labelledby="overview-overdue-heading">
        <h3 id="overview-overdue-heading">{c('Seguimientos vencidos', 'Overdue follow-ups')}</h3>
        <ul className={styles.list}>{overdue.map((item) => <ReminderItem key={item.id} item={item} timeZone={timeZone}/>)}</ul>
        {timeline.overdue.total > overdue.length && <p className={styles.muted}>{c(`Se muestran ${overdue.length} de ${timeline.overdue.total}.`, `Showing ${overdue.length} of ${timeline.overdue.total}.`)}</p>}
      </section>}
      {upcoming.length > 0 && <section className={styles.group} aria-labelledby="overview-upcoming-heading">
        <h3 id="overview-upcoming-heading">{c('Próximos 30 días', 'Next 30 days')}</h3>
        <ul className={styles.list}>{upcoming.map((item) => <ReminderItem key={item.id} item={item} timeZone={timeZone}/>)}</ul>
        {timeline.items.filter((item) => item.type === 'INTERVIEW' || (item.type === 'FOLLOW_UP' && item.followUpStatus !== 'overdue')).length > upcoming.length && <p className={styles.muted}>{c('Hay más eventos en el calendario.', 'More events are on the timeline.')}</p>}
      </section>}
    </div>
  </Card>;
}
