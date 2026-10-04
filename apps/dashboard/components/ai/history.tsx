'use client';

import { useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { localizedError, useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import styles from './draft-action.module.css';

type Counts = { runs: number; artifacts: number; usageRecords: number };
type Preview = { previewId: string; expiresAt: string; removable: Counts; preserved: { activeRuns: number; referencedArtifacts: number; retainedDependencies: number }; retentionDays: number };

export function AiHistoryPanel() {
  const { locale } = useLocale(); const c = copy(locale);
  const [preview, setPreview] = useState<Preview | null>(null); const [deleted, setDeleted] = useState<Counts | null>(null);
  const [busy, setBusy] = useState<'preview' | 'clear' | null>(null); const [error, setError] = useState(''); const working = useRef(false);
  const perform = async (kind: 'preview' | 'clear') => {
    if (working.current || (kind === 'clear' && !preview)) return;
    working.current = true; setBusy(kind); setError('');
    try {
      if (kind === 'preview') {
        setDeleted(null); setPreview(await api<Preview>('/ai/history/clear-preview'));
      } else {
        const result = await api<{ deleted: Counts }>('/ai/history/clear', { method: 'POST', body: JSON.stringify({ previewId: preview!.previewId }) });
        setDeleted(result.deleted); setPreview(null);
      }
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : 'NETWORK_UNAVAILABLE';
      setError(code === 'AI_PREVIEW_EXPIRED' ? c('La vista previa caducó. Revisa de nuevo qué se puede borrar.', 'The preview expired. Review what can be deleted again.') : localizedError(code, locale));
      if (kind === 'clear') setPreview(null);
    } finally { working.current = false; setBusy(null); }
  };
  const hasRemovable = preview && Object.values(preview.removable).some(value => value > 0);
  return <details className={styles.preview}>
    <summary>{c('Historial local de ayuda con IA', 'Local AI assistance history')}</summary>
    <div className={styles.section}>
      <p>{c('Puedes borrar las tareas terminadas y propuestas que ya no estén vinculadas a tus documentos o respuestas.', 'You can delete finished tasks and suggestions that are no longer linked to your documents or answers.')}</p>
      <p className={styles.hint}>{c('Se conservan los CV, las respuestas vinculadas, las tareas activas y los datos necesarios para respetar los límites de uso. El borrado local no cambia tus copias de seguridad ni los registros del proveedor.', 'Resumes, linked answers, active tasks and the data needed to enforce usage limits are kept. Local deletion does not change your backups or the provider’s records.')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {deleted && <Notice tone="success">{c(`Historial borrado: ${deleted.runs} tareas, ${deleted.artifacts} propuestas y ${deleted.usageRecords} registros de consumo.`, `History deleted: ${deleted.runs} tasks, ${deleted.artifacts} suggestions and ${deleted.usageRecords} usage records.`)}</Notice>}
      {preview && <section className={styles.panel} aria-label={c('Revisión del historial que se borrará', 'Review history to delete')}>
        <h3>{c('Esto se puede borrar', 'This can be deleted')}</h3>
        <ul className={styles.list}><li>{c(`${preview.removable.runs} tareas terminadas`, `${preview.removable.runs} finished tasks`)}</li><li>{c(`${preview.removable.artifacts} propuestas sin vincular`, `${preview.removable.artifacts} unlinked suggestions`)}</li><li>{c(`${preview.removable.usageRecords} registros de consumo`, `${preview.removable.usageRecords} usage records`)}</li></ul>
        <p className={styles.hint}>{c(`Se conservarán ${preview.preserved.activeRuns} tareas activas, ${preview.preserved.referencedArtifacts} propuestas vinculadas y ${preview.preserved.retainedDependencies} registros necesarios para ellas.`, `${preview.preserved.activeRuns} active tasks, ${preview.preserved.referencedArtifacts} linked suggestions and ${preview.preserved.retainedDependencies} supporting records will be kept.`)}</p>
        <p className={styles.hint}>{c(`La limpieza automática elimina los registros de consumo de más de ${preview.retentionDays} días. Aquí puedes borrar los indicados en esta vista previa.`, `Automatic cleanup removes usage records older than ${preview.retentionDays} days. Here you can delete the records listed in this preview.`)}</p>
        {hasRemovable ? <><p>{c('Esta acción no se puede deshacer desde la app.', 'This action cannot be undone in the app.')}</p><div className={styles.actions}><Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void perform('clear')}>{busy === 'clear' ? c('Borrando…', 'Deleting…') : c('Borrar este historial local', 'Delete this local history')}</Button></div></> : <p>{c('No hay historial que se pueda borrar ahora.', 'There is no history that can be deleted right now.')}</p>}
      </section>}
      <div className={styles.actions}><Button type="button" variant="quiet" disabled={busy !== null} onClick={() => void perform('preview')}>{busy === 'preview' ? c('Revisando historial…', 'Checking history…') : preview ? c('Actualizar vista previa', 'Refresh preview') : c('Revisar qué se puede borrar', 'Review what can be deleted')}</Button></div>
    </div>
  </details>;
}
