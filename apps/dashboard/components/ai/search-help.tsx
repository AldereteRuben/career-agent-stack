'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { useLocalRefresh } from '@/lib/local-refresh';
import { copy } from '@/lib/labels';
import { AiConnectionPanel } from './connection';
import type { AiConnectionResponse } from './types';
import styles from '@/app/searches/searches.module.css';

type Policy = { active: boolean; paused: boolean; searchIds: string[] };
type JobChoice = { id: string; title: string; company: string };

/** Local metadata only. Connecting and opening this guide never authorizes inference. */
export function SearchAiHelp({ searchIds, jobs = [], returnTo = '/searches', inline = false }: { searchIds: string[]; jobs?: JobChoice[]; returnTo?: string; inline?: boolean }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [connection, setConnection] = useState<AiConnectionResponse | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [failed, setFailed] = useState(false); const [policyFailed, setPolicyFailed] = useState(false);
  const [revision, setRevision] = useState(0); const [connectOpen, setConnectOpen] = useState(false);
  const [open, setOpen] = useState(inline);
  useLocalRefresh(async () => { setRevision(value => value + 1); });
  useEffect(() => {
    const controller = new AbortController();
    void api<AiConnectionResponse>('/ai/connections', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setConnection(value); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) { setFailed(true); setConnection(null); } });
    void api<{ policies: Policy[] }>(`/ai/automation?locale=${locale}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setPolicies(value.policies); setPolicyFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setPolicyFailed(true); });
    return () => controller.abort();
  }, [locale, revision]);
  const connected = connection?.enabled && connection.connection?.authorized && connection.connection.sessionState === 'SIGNED_IN';
  const covered = new Set(policies?.filter(policy => policy.active && !policy.paused).flatMap(policy => policy.searchIds) ?? []);
  const activeCount = searchIds.filter(id => covered.has(id)).length;
  const stateLabel = failed ? c('No pudimos comprobar la conexión', 'Could not check the connection') : !connection ? c('Comprobando conexión…', 'Checking connection…') : connected ? c('Conectado', 'Connected') : c('Conectar cuenta', 'Connect account');
  return <details className={styles.aiHelp} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{inline ? c('Cuenta de Codex', 'Codex account') : c('Ayuda de Codex y resúmenes automáticos', 'Codex help and automatic summaries')} · {stateLabel}</summary>
    <div className={styles.form}>
      <p>{c('Codex te ayuda a preparar filtros y entender ofertas. La búsqueda en los portales continúa sin IA.', 'Codex helps prepare filters and explain jobs. Portal searches continue without AI.')}</p>
      {failed && <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{c('Reintentar conexión', 'Retry connection')}</Button>}
      {!failed && connection && !connected && !connectOpen && <Button variant="secondary" onClick={() => setConnectOpen(true)}>{c('Conectar Codex aquí', 'Connect Codex here')}</Button>}
      {connectOpen && <AiConnectionPanel visible={open} onConnectionChange={value => { setConnection(value); setFailed(false); setRevision(value => value + 1); }}/>}
      {connected && <p role="status">{inline ? c('Cuenta lista. Continúa con tu petición debajo; revisarás los datos antes de compartirlos.', 'Account ready. Continue with your request below; you will review the data before sharing it.') : policyFailed ? c('No pudimos consultar los resúmenes automáticos. La ayuda manual sigue disponible en cada oferta.', 'Could not check automatic summaries. Manual help is still available on each job.') : policies ? activeCount ? c(`Resúmenes automáticos en ${activeCount} de ${searchIds.length} búsquedas. Cada oferta indica si tiene un resumen guardado.`, `Automatic summaries on ${activeCount} of ${searchIds.length} searches. Each job shows whether it has a saved summary.`) : c('Resúmenes automáticos desactivados. Puedes activarlos después de probar y revisar un resumen.', 'Automatic summaries are off. You can enable them after trying and reviewing one summary.') : c('Comprobando resúmenes automáticos…', 'Checking automatic summaries…')}</p>}
      {connected && policyFailed && <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{c('Reintentar estado de resúmenes', 'Retry summary status')}</Button>}
      {!inline && connected && <details className={styles.moreOptions}><summary>{c('Activar resúmenes automáticos', 'Enable automatic summaries')}</summary>
        <ol><li>{c('Elige una oferta debajo y pide un resumen. Revisarás qué se comparte y autorizarás esa tarea.', 'Choose a job below and request a summary. You will review what is shared and authorize that task.')}</li><li>{c('Lee el resultado. En el mismo lugar podrás elegir búsquedas y un límite diario antes de permitir los próximos resúmenes.', 'Read the result. In the same place, choose searches and a daily limit before allowing future summaries.')}</li></ol>
        {jobs.length ? <ul>{jobs.map(job => <li key={job.id}><Link href={`/jobs/${job.id}?returnTo=${encodeURIComponent(returnTo)}&aiSetup=automatic#job-ai-assistance`}>{job.title} · {job.company}</Link></li>)}</ul> : <p>{c('Cuando encuentres una oferta, verás aquí el acceso para empezar.', 'When you find a job, the starting link will appear here.')}</p>}
      </details>}
    </div>
  </details>;
}
