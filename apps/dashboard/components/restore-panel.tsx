'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

type Summary = { createdAt: string; appVersion: string | null; postgresVersion: string; tableCount: number; rowCount: number; documentCount: number; migrationCount: number; pendingMigrations: number };
type Job = { state: 'idle' | 'awaiting-files' | 'verifying' | 'verified' | 'restoring' | 'restored' | 'opening' | 'opened' | 'failed'; id?: string; summary?: Summary; archiveUploaded?: boolean; keyUploaded?: boolean; openUrl?: string; canRestore?: boolean };

async function upload(id: string, kind: 'archive' | 'key', file: File) {
  const response = await fetch(`/api/v1/backups/restore/${id}/${kind}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    credentials: 'same-origin', cache: 'no-store',
  });
  if (!response.ok) throw new Error('UPLOAD_FAILED');
}

export function RestorePanel() {
  const { locale } = useLocale(); const c = copy(locale);
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const [archive, setArchive] = useState<File | null>(null); const [key, setKey] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setJob(await api<Job>('/backups/restore/current')); }
    catch { setError(locale === 'es' ? 'No se pudo consultar el estado de la restauración.' : 'Could not check restore status.'); }
  }, [locale]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!['verifying', 'restoring', 'opening'].includes(job.state)) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [job.state, refresh]);

  const begin = async () => {
    if (!archive || !key) return;
    setBusy(true); setError('');
    try {
      const created = job.id && job.state === 'awaiting-files' ? job : await api<Job>('/backups/restore', { method: 'POST' });
      if (!created.id) throw new Error('RESTORE_UNAVAILABLE');
      setJob(created);
      if (!created.archiveUploaded) await upload(created.id, 'archive', archive);
      if (!created.keyUploaded) await upload(created.id, 'key', key);
      setJob(await api<Job>(`/backups/restore/current`));
    } catch {
      setError(c('No se pudieron cargar los dos archivos. Comprueba que la copia y la clave sean correctas e inténtalo de nuevo.', 'The two files could not be uploaded. Check that the backup and key are correct, then try again.'));
    } finally { setBusy(false); }
  };

  const verify = async () => {
    if (!job.id) return;
    setBusy(true); setError('');
    try { setJob(await api<Job>(`/backups/restore/${job.id}/verify`, { method: 'POST' })); }
    catch { setError(c('No se pudo verificar la copia con esa clave. La instalación actual sigue intacta.', 'The backup could not be verified with that key. The current installation is unchanged.')); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (!job.id || !confirmed) return;
    setBusy(true); setError('');
    try { setJob(await api<Job>(`/backups/restore/${job.id}/restore`, { method: 'POST', body: JSON.stringify({ confirmed: true }) })); }
    catch { setError(c('No se pudo iniciar la restauración. La instalación actual no se ha sustituido.', 'Could not start the restore. The current installation was not replaced.')); }
    finally { setBusy(false); }
  };

  const open = async () => {
    if (!job.id) return;
    setBusy(true); setError('');
    try { setJob(await api<Job>(`/backups/restore/${job.id}/open`, { method: 'POST' })); }
    catch { setError(c('La copia se restauró, pero no se pudo abrir. Puedes volver a intentarlo desde aquí.', 'The backup was restored, but it could not be opened. You can try again here.')); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!job.id) return;
    setBusy(true); setError('');
    try {
      await api(`/backups/restore/${job.id}`, { method: 'DELETE' });
      setJob({ state: 'idle', canRestore: job.canRestore });
      setArchive(null); setKey(null); setConfirmed(false);
    } catch {
      setError(c('No se pudo cancelar la restauración.', 'Could not cancel the restore.'));
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setArchive(null); setKey(null); setConfirmed(false); setError('');
    await refresh();
    if (job.state === 'failed' || job.state === 'opened') setJob({ state: 'idle', canRestore: job.canRestore });
  };

  return <section className="restore-panel" aria-labelledby="restore-heading">
    <h3 id="restore-heading">{c('Restaurar una copia', 'Restore a backup')}</h3>
    <p>{c('La copia se revisa primero. Después se crea otro espacio privado, sin cambiar este. Necesitas el archivo de copia cifrada y su clave.', 'The backup is checked first. Then a separate private workspace is created without changing this one. You need the encrypted backup file and its key.')}</p>
    {job.canRestore === false && <Notice tone="warning">{c('Falta configurar una conexión local de restauración en el entorno privado antes de poder crear la copia. No se solicita ni se guarda ninguna contraseña aquí.', 'A local restore connection must be configured in the private environment before restoring. This screen never asks for or stores a password.')}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div role="status" aria-live="polite">
      {job.state === 'verifying' && <p>{c('Comprobando la clave, la integridad y la compatibilidad…', 'Checking the key, integrity and compatibility…')}</p>}
      {job.state === 'restoring' && <p>{c('Creando una base de datos y una carpeta nuevas…', 'Creating a new database and folder…')}</p>}
      {job.state === 'opening' && <p>{c('Iniciando el espacio restaurado…', 'Starting the restored workspace…')}</p>}
      {job.state === 'failed' && <Notice tone="error">{c('La operación no terminó. El espacio original no se sustituyó. Vuelve a elegir la copia y la clave para intentarlo de nuevo.', 'The operation did not finish. The original workspace was not replaced. Select the backup and key again to retry.')}</Notice>}
      {job.summary && ['verified', 'restoring', 'restored', 'opening', 'opened'].includes(job.state) && <div className="restore-summary">
        <h4>{c('Copia verificada', 'Backup verified')}</h4>
        <p>{c('Creada:', 'Created:')} <time dateTime={job.summary.createdAt}>{new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(job.summary.createdAt))}</time></p>
        <p>{c('Versión:', 'Version:')} {job.summary.appVersion ?? '—'} · PostgreSQL {job.summary.postgresVersion}</p>
        <p>{job.summary.tableCount} {c('tablas,', 'tables,')} {job.summary.rowCount} {c('filas y', 'rows and')} {job.summary.documentCount} {c('documentos.', 'documents.')}</p>
        {job.summary.pendingMigrations > 0 && <p>{c('Al abrir, se aplicarán', 'On opening,')} {job.summary.pendingMigrations} {c('migraciones compatibles.', 'compatible migrations will be applied.')}</p>}
      </div>}
    </div>
    {job.state === 'idle' || job.state === 'awaiting-files' ? <div className="form-stack">
      <label>{c('Archivo de copia cifrada (.tar.age)', 'Encrypted backup file (.tar.age)')}<input type="file" accept=".age,.tar.age,application/octet-stream" onChange={(event) => setArchive(event.target.files?.[0] ?? null)} /></label>
      <label>{c('Clave de recuperación (.json)', 'Recovery key (.json)')}<input type="file" accept=".json,application/json" onChange={(event) => setKey(event.target.files?.[0] ?? null)} /></label>
      <Button disabled={!archive || !key || busy} onClick={() => void begin()}>{busy ? c('Cargando archivos…', 'Uploading files…') : c('Cargar copia y clave', 'Upload backup and key')}</Button>
      {job.state === 'awaiting-files' && job.archiveUploaded && job.keyUploaded && <Button disabled={busy} onClick={() => void verify()}>{c('Verificar copia', 'Verify backup')}</Button>}
    </div> : null}
    {job.state === 'verified' && <div className="form-stack">
      <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{c('Confirmo que quiero crear una copia aislada. La instalación actual permanecerá intacta.', 'I confirm I want to create an isolated copy. The current installation will remain unchanged.')}</label>
      <Button disabled={!confirmed || busy || job.canRestore === false} onClick={() => void restore()}>{c('Crear espacio restaurado', 'Create restored workspace')}</Button>
    </div>}
    {job.state === 'awaiting-files' || job.state === 'verified' ? <Button variant="quiet" disabled={busy} onClick={() => void cancel()}>{c('Cancelar restauración', 'Cancel restore')}</Button> : null}
    {job.state === 'restored' && <div className="form-stack"><p>{c('La copia está lista y sigue aislada. Se abrirá solo cuando pulses el botón.', 'The copy is ready and remains isolated. It will open only when you press the button.')}</p><Button disabled={busy} onClick={() => void open()}>{c('Abrir copia restaurada', 'Open restored copy')}</Button></div>}
    {job.state === 'opened' && <Notice tone="success">{c('La copia se abrió en otra pestaña. El código de acceso de un solo uso está en el portapapeles.', 'The restored copy opened in another tab. Its one-time sign-in code is on the clipboard.')}{job.openUrl && <> <a href={job.openUrl} target="_blank" rel="noreferrer">{c('Abrir de nuevo', 'Open again')}</a></>}</Notice>}
    {job.state === 'failed' || job.state === 'opened' ? <Button variant="quiet" onClick={() => void reset()}>{c('Empezar otra restauración', 'Start another restore')}</Button> : null}
    <small>{c('La clave se copia temporalmente en una carpeta privada y se elimina al finalizar. Nunca se muestra ni se guarda una contraseña de PostgreSQL en el navegador.', 'The key is copied temporarily into a private folder and deleted when finished. A PostgreSQL password is never shown or stored in the browser.')}</small>
  </section>;
}
