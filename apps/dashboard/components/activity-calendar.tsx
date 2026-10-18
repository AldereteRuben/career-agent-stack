'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/api';
import { Button, Card } from '@/components/ui';
import styles from './activity-calendar.module.css';

export type DailyActivity = { day: string; jobs: number; applications: number };
type ActivityDetails = {
  day: string;
  jobsTotal: number;
  applicationsTotal: number;
  jobs: Array<{ id: string; title: string; company: string }>;
  applications: Array<{ id: string; role: string; company: string; state: string }>;
};

/** The viewer's IANA time zone, so the server groups activity by the same calendar days the grid shows. */
export const viewerTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function ActivityCalendar({ activity }: { activity: DailyActivity[] }) {
  const { locale } = useLocale();
  const c = (es: string, en: string) => locale === 'es' ? es : en;
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [details, setDetails] = useState<ActivityDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const detailRequest = useRef(0);
  const today = new Date();
  const oldest = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const records = new Map(activity.map((item) => [item.day, item]));
  const offset = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<{ key: string; number: number | null; jobs: number; applications: number }> = [];
  for (let index = 0; index < offset; index++) cells.push({ key: `blank-${index}`, number: null, jobs: 0, applications: 0 });
  for (let number = 1; number <= days; number++) {
    const key = dayKey(new Date(month.getFullYear(), month.getMonth(), number));
    const record = records.get(key);
    cells.push({ key, number, jobs: record?.jobs ?? 0, applications: record?.applications ?? 0 });
  }
  const totals = cells.reduce((acc, cell) => ({ jobs: acc.jobs + cell.jobs, applications: acc.applications + cell.applications }), { jobs: 0, applications: 0 });
  const localeTag = locale === 'es' ? 'es-ES' : 'en-GB';
  const rawMonthLabel = new Intl.DateTimeFormat(localeTag, { month: 'long', year: 'numeric' }).format(month);
  const monthLabel = rawMonthLabel.charAt(0).toLocaleUpperCase(localeTag) + rawMonthLabel.slice(1);
  const weekdayLabels = locale === 'es' ? ['L', 'M', 'X', 'J', 'V', 'S', 'D'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const move = (amount: number) => {
    detailRequest.current += 1;
    setMonth((value) => new Date(value.getFullYear(), value.getMonth() + amount, 1));
    setSelectedDay(null); setDetails(null); setDetailsError(''); setDetailsLoading(false);
  };
  const selectDay = async (day: string) => {
    const request = ++detailRequest.current;
    setSelectedDay(day); setDetails(null); setDetailsError(''); setDetailsLoading(true);
    try { const result = await api<ActivityDetails>(`/activity?day=${day}&tz=${encodeURIComponent(viewerTimeZone())}`); if (request === detailRequest.current) setDetails(result); }
    catch (error) { if (request === detailRequest.current) setDetailsError(errorMessage(error)); }
    finally { if (request === detailRequest.current) setDetailsLoading(false); }
  };
  const canBack = month > oldest;
  const canForward = monthKey(month) < monthKey(new Date(today.getFullYear(), today.getMonth(), 1));

  return <Card className={styles.card}>
    <div className={styles.heading}>
      <div><h2>{c('Calendario de actividad', 'Activity calendar')}</h2><p>{c('Tu actividad real en ofertas y candidaturas.', 'Your actual activity across jobs and applications.')}</p></div>
      <div className={styles.monthControls} aria-label={c('Cambiar mes', 'Change month')}>
        <Button variant="secondary" disabled={!canBack} aria-label={c('Mes anterior', 'Previous month')} onClick={() => move(-1)}>‹</Button>
        <span aria-live="polite">{monthLabel}</span>
        <Button variant="secondary" disabled={!canForward} aria-label={c('Mes siguiente', 'Next month')} onClick={() => move(1)}>›</Button>
      </div>
    </div>
    <div className={styles.calendar} role="group" aria-label={c(`Actividad de ${monthLabel}`, `Activity for ${monthLabel}`)}>
      {weekdayLabels.map((label, index) => <span className={styles.weekday} key={`${label}-${index}`}>{label}</span>)}
      {cells.map((cell) => {
        if (cell.number === null) return <span className={styles.blank} key={cell.key} aria-hidden="true"/>;
        const active = cell.jobs + cell.applications > 0;
        const date = new Date(month.getFullYear(), month.getMonth(), cell.number);
        const dayLabel = new Intl.DateTimeFormat(localeTag, { dateStyle: 'full' }).format(date);
        const description = c(`${cell.jobs} ofertas encontradas, ${cell.applications} candidaturas creadas`, `${cell.jobs} jobs found, ${cell.applications} applications created`);
        return <button type="button" key={cell.key} aria-label={`${dayLabel}: ${description}`} aria-pressed={selectedDay === cell.key} aria-current={dayKey(date) === dayKey(today) ? 'date' : undefined}
          onClick={() => void selectDay(cell.key)}
          className={`${styles.day} ${active ? styles.active : ''} ${selectedDay === cell.key ? styles.selected : ''} ${cell.jobs && cell.applications ? styles.both : cell.jobs ? styles.jobs : cell.applications ? styles.applications : ''}`} title={`${dayLabel}: ${description}`}>
          <span>{cell.number}</span>
          {active && <span className={styles.markers} aria-hidden="true">
            {cell.jobs > 0 && <i className={styles.jobMarker}/>}
            {cell.applications > 0 && <i className={styles.applicationMarker}/>}
          </span>}
        </button>;
      })}
    </div>
    <div className={styles.summary} aria-live="polite">
      <span><strong>{totals.jobs}</strong> {c('ofertas encontradas', 'jobs found')}</span>
      <span><strong>{totals.applications}</strong> {c('candidaturas creadas', 'applications created')}</span>
    </div>
    <div className={styles.legend} aria-label={c('Leyenda', 'Legend')}>
      <span><i className={styles.jobsMark}/> {c('Ofertas encontradas', 'Jobs found')}</span>
      <span><i className={styles.applicationsMark}/> {c('Candidaturas', 'Applications')}</span>
      <span><i className={styles.bothMark}/> {c('Ambas', 'Both')}</span>
    </div>
    <p className={styles.hint}><Link href="/timeline">{c('Ver la cronología con entrevistas, recordatorios y cambios de etapa', 'Open the timeline with interviews, follow-ups and stage changes')}</Link></p>
    <section className={styles.dayDetails} aria-live="polite" aria-busy={detailsLoading}>
      {!selectedDay ? <p className={styles.hint}>{c('Selecciona un día para ver qué registraste.', 'Select a day to see what you logged.')}</p>
        : detailsLoading ? <p className={styles.hint}>{c('Cargando actividad…', 'Loading activity…')}</p>
          : detailsError ? <p className={styles.error} role="alert">{detailsError}</p>
            : details && <>
              <h3>{(() => {
                const label = new Intl.DateTimeFormat(localeTag, { dateStyle: 'full' }).format(new Date(`${details.day}T12:00:00`));
                return label.charAt(0).toLocaleUpperCase(localeTag) + label.slice(1);
              })()}</h3>
              {details.jobs.length === 0 && details.applications.length === 0
                ? <p className={styles.hint}>{c('No hay ofertas ni candidaturas registradas ese día.', 'No jobs or applications were logged on this day.')}</p>
                : <>
                  {details.jobs.length > 0 && <div className={styles.detailGroup}><h4>{c(`Ofertas encontradas (${details.jobsTotal})`, `Jobs found (${details.jobsTotal})`)}</h4><ul>{details.jobs.map((job) => <li key={job.id}><Link href={`/jobs/${job.id}`}>{job.title}</Link><span>{job.company}</span></li>)}</ul>{details.jobsTotal > details.jobs.length && <p className={styles.hint}>{c(`Se muestran ${details.jobs.length} de ${details.jobsTotal}.`, `Showing ${details.jobs.length} of ${details.jobsTotal}.`)}</p>}</div>}
                  {details.applications.length > 0 && <div className={styles.detailGroup}><h4>{c(`Candidaturas creadas (${details.applicationsTotal})`, `Applications created (${details.applicationsTotal})`)}</h4><ul>{details.applications.map((application) => <li key={application.id}><Link href={`/applications?id=${application.id}`}>{application.role}</Link><span>{application.company}</span></li>)}</ul>{details.applicationsTotal > details.applications.length && <p className={styles.hint}>{c(`Se muestran ${details.applications.length} de ${details.applicationsTotal}.`, `Showing ${details.applications.length} of ${details.applicationsTotal}.`)}</p>}</div>}
                </>}
            </>}
    </section>
  </Card>;
}
