'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { Button, Card, Notice, Tag } from './ui';

type DiscoveryBoard = { id: string; companyName: string; eligible: boolean; lastRunAt: string | null; lastRunStatus: string | null; lastNewCount: number; nextRunAt: string | null };
type Discovery = { enabled: boolean; unreadCount: number; boards: DiscoveryBoard[] };
export function DiscoveryPanel({ compact = false, revision = '', onAddCompany }: { compact?: boolean; revision?: string; onAddCompany?: () => void }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [data, setData] = useState<Discovery | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false; let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { const result = await api<Discovery>('/discovery'); if (!disposed) { setData(result); setError(''); } }
      catch (err) { if (!disposed) setError(errorMessage(err)); }
      finally { pending = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 15_000);
    const visible = () => void load(); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [revision, refresh]);
  const eligible = data?.boards.filter((board) => board.eligible) ?? [];
  const incomplete = eligible.filter((board) => ['FAILED', 'PARTIAL', 'INTERRUPTED'].includes(board.lastRunStatus ?? '')).length;
  const toggle = async () => {
    if (!data) return;
    setBusy(true); setError('');
    try { await api('/discovery', { method: 'PUT', body: JSON.stringify({ enabled: !data.enabled }) }); setData((current) => current ? { ...current, enabled: !data.enabled } : current); setRefresh((value) => value + 1); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const date = (value: string) => new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const next = data?.boards.map((board) => board.nextRunAt).filter((value): value is string => !!value).sort()[0];
  const status = (board: DiscoveryBoard) => {
    if (board.lastRunStatus === 'RUNNING') return c('Consultando…', 'Checking…');
    if (board.lastRunStatus === 'FAILED') return c('La última consulta falló. Reintentaremos automáticamente si la búsqueda está activa.', 'The last check failed. We will retry automatically if search is active.');
    if (board.lastRunStatus === 'INTERRUPTED') return c('La consulta se interrumpió. Reintentaremos en el próximo horario.', 'The check was interrupted. We will retry at the next scheduled time.');
    if (board.lastRunStatus === 'PARTIAL') return c(`${board.lastNewCount} nuevas. Lectura incompleta: revisa también la web de la empresa.`, `${board.lastNewCount} new. Incomplete results: also check the company website.`);
    if (board.lastRunStatus === 'COMPLETE') return c(`${board.lastNewCount} ofertas nuevas en la última consulta.`, `${board.lastNewCount} new jobs in the last check.`);
    return c('Todavía no se ha consultado.', 'Not checked yet.');
  };
  return <Card className="discovery-panel">
    <div className="panel-heading"><h2>{c('Búsqueda automática', 'Automatic job search')}</h2>{data && <Tag tone={data.enabled && eligible.length ? 'green' : 'neutral'}>{data.enabled ? eligible.length ? c('ACTIVA', 'ON') : c('SIN EMPRESAS LISTAS', 'NO READY COMPANIES') : c('PAUSADA', 'PAUSED')}</Tag>}</div>
    {error && <Notice tone="error" actions={<Button variant="quiet" onClick={() => setRefresh((value) => value + 1)}>{c('Reintentar', 'Try again')}</Button>}>{error}</Notice>}
    {!data ? <p>{c('Cargando búsqueda…', 'Loading search…')}</p> : <>
      <p>{c('Consulta las empresas que confirmes aproximadamente cada 6 horas, mientras el servicio local esté encendido. Puedes cerrar esta pestaña.', 'Checks companies you confirm about every 6 hours while the local service is running. You can close this tab.')}</p>
      {!eligible.length && <p>{c('Añade y confirma al menos una empresa para empezar.', 'Add and confirm at least one company to get started.')} {data.boards.length ? <Link href="/boards#saved-companies">{c('Ver empresas por confirmar', 'Review your companies')}</Link> : onAddCompany ? <button type="button" className="discovery-add-link" onClick={onAddCompany}>{c('Añadir una empresa', 'Add a company')}</button> : <Link href="/boards?add=1">{c('Añadir una empresa', 'Add a company')}</Link>}</p>}
      {data.enabled && next && <p><strong>{c('Próxima consulta:', 'Next check:')}</strong> {new Date(next).getTime() <= Date.now() + 30_000 ? c('En breve', 'Shortly') : date(next)}</p>}
      {!!incomplete && <Notice tone="warning">{c(`La última consulta quedó incompleta en ${incomplete} empresas. Tus ofertas guardadas se conservan.`, `The last check was incomplete for ${incomplete} companies. Your saved jobs are kept.`)}{compact && <> <Link href="/boards">{c('Ver actividad', 'View activity')}</Link></>}</Notice>}
      <div className="discovery-actions">
        <Link href="/jobs?scope=new" className="button button-secondary">{c(`Revisar ofertas nuevas (${data.unreadCount})`, `Review new jobs (${data.unreadCount})`)}</Link>
        {compact ? <Link href="/boards">{c('Configurar búsqueda', 'Manage search')}</Link> : <Button onClick={() => void toggle()} disabled={busy || (!data.enabled && !eligible.length)}>{busy ? c('Guardando…', 'Saving…') : data.enabled ? c('Pausar búsqueda', 'Pause search') : c('Activar búsqueda automática', 'Turn on automatic search')}</Button>}
      </div>
      {!compact && <>
        <p className="muted-label">{c('Si apagas el servicio, retomará las consultas pendientes al volver a iniciarlo. Al pausar, la consulta que ya esté en curso puede terminar. No envía solicitudes ni tu CV.', 'If you stop the service, it catches up when you start it again. Pausing lets a check already in progress finish. It does not send applications or your resume.')}</p>
        <p><Link href="/profile">{c('Ajustar los puestos y preferencias para ordenar el encaje', 'Adjust target roles and preferences to rank job fit')}</Link></p>
        {!!data.boards.length && <details className="discovery-details"><summary>{c('Actividad por empresa', 'Activity by company')}</summary><ul>{data.boards.map((board) => <li key={board.id}><strong>{board.companyName}</strong><p>{status(board)}</p><small>{board.lastRunAt ? c(`Última consulta: ${date(board.lastRunAt)}`, `Last check: ${date(board.lastRunAt)}`) : ''}</small><p>{!board.eligible ? c('Confirma o reactiva esta empresa en la lista de abajo.', 'Confirm or turn this company back on in the list below.') : !data.enabled ? c('Programación pausada.', 'Schedule paused.') : board.nextRunAt ? c(`Próxima consulta: ${date(board.nextRunAt)}`, `Next check: ${date(board.nextRunAt)}`) : ''}</p></li>)}</ul></details>}
      </>}
    </>}
  </Card>;
}
