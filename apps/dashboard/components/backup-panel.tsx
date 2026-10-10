'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

type Job = { state: 'idle' | 'running' | 'ready' | 'failed'; id?: string; createdAt?: string };
export function BackupPanel() {
  const { locale } = useLocale(); const c = copy(locale);
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const [loading, setLoading] = useState(true); const [starting, setStarting] = useState(false); const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setJob(await api<Job>('/backups/current')); setError(''); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (job.state !== 'running') return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [job.state, refresh]);
  const create = async () => {
    setStarting(true); setError('');
    try { setJob(await api<Job>('/backups', { method: 'POST' })); }
    catch (err) { await refresh(); setError(errorMessage(err)); }
    finally { setStarting(false); }
  };
  return <div className="form-stack backup-panel">
    <p>{c('Crea una copia de tus datos y PDF sin abrir la terminal. Puedes seguir usando tu espacio mientras se prepara.', 'Back up your data and PDFs without opening a terminal. You can keep using your workspace while it is prepared.')}</p>
    {error && <Notice tone="error" actions={<Button variant="quiet" onClick={() => void refresh()}>{c('Reintentar', 'Try again')}</Button>}>{error}</Notice>}
    <div role="status" aria-live="polite">
      {job.state === 'running' && <p>{c('Preparando y comprobando la copia… Puedes volver a esta página en unos momentos.', 'Preparing and verifying your backup… You can return to this page in a few moments.')}</p>}
      {job.state === 'failed' && <Notice tone="error">{c('No se pudo crear la copia. Tus datos siguen intactos. Inténtalo otra vez; si se repite, consulta las opciones de terminal de abajo y comprueba PostgreSQL y el espacio disponible.', 'The backup could not be created. Your data is unchanged. Try again; if it keeps failing, use the terminal options below and check PostgreSQL and available disk space.')}</Notice>}
      {job.state === 'ready' && <p>{c('Copia verificada. Descarga estos dos archivos:', 'Backup verified. Download these two files:')}</p>}
    </div>
    {job.state === 'ready' && <>
      {job.createdAt && <p className="muted-label">{c('Copia creada:', 'Backup created:')} <time dateTime={job.createdAt}>{new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(job.createdAt))}</time></p>}
      <ol className="help-steps backup-downloads">
        <li><a className="button button-secondary" href={`/api/v1/backups/${job.id}/archive`} download>{c('Descargar copia', 'Download backup')}</a></li>
        <li><a className="button button-secondary" href={`/api/v1/backups/${job.id}/key`} download>{c('Descargar clave de recuperación', 'Download recovery key')}</a></li>
      </ol>
      <p>{c('Necesitas ambos para recuperar tu espacio: la copia está cifrada y solo se puede abrir con su clave. Guarda la clave en una ubicación privada separada de la copia. Descargarla no confirma que ya la hayas guardado.', 'You need both to recover your workspace: the backup is encrypted and only its key can open it. Keep the key in a separate private location from the backup. Downloading it does not confirm that you have stored it safely.')}</p>
      <a href={`/api/v1/backups/${job.id}/checksum`} download>{c('Descargar archivo de comprobación (opcional)', 'Download checksum file (optional)')}</a>
      <small>{c('Descarga los archivos antes de crear otra copia o reiniciar la app. También se conservan en data/backups, dentro de la carpeta de instalación.', 'Download the files before creating another backup or restarting the app. They are also kept in data/backups inside the installation folder.')}</small>
    </>}
    <div><Button disabled={loading || starting || job.state === 'running'} onClick={() => void create()}>{loading ? c('Consultando copias…', 'Checking backups…') : starting || job.state === 'running' ? c('Preparando copia…', 'Preparing backup…') : job.state === 'ready' ? c('Crear otra copia', 'Create another backup') : c('Crear copia de seguridad', 'Create backup')}</Button></div>
    <small>{c('La copia está cifrada: sin su clave nadie puede leerla. Quien tenga la copia y la clave puede leer tus datos, así que guárdalas por separado. La restauración aún requiere la terminal.', 'The backup is encrypted: without its key nobody can read it. Anyone with both the backup and the key can read your data, so keep them apart. Restoring it still requires a terminal.')}</small>
  </div>;
}
