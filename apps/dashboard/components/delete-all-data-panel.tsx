'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Notice } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

/**
 * "Delete all my data" (ADR 020). The person types a phrase in their language; the API stops all running work,
 * deletes every record and file of the workspace, and signs out every browser. The installation keeps working,
 * empty, with a new sign-in code.
 */
export function DeleteAllDataPanel() {
  const { locale } = useLocale(); const c = copy(locale);
  const phrase = c('BORRAR TODOS MIS DATOS', 'DELETE ALL MY DATA');
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<'idle' | 'deleting' | 'deleted' | 'files-pending'>('idle');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim() !== phrase || state === 'deleting') return;
    setState('deleting'); setError('');
    try {
      await api<{ deleted: true }>('/workspace/delete-all', { method: 'POST', body: JSON.stringify({ confirmation: typed.trim() }) });
      setState('deleted');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DELETION_FILES_PENDING') { setState('files-pending'); return; }
      setState('idle'); setError(errorMessage(err));
    }
  };
  const after = <><p>{c('Para volver a entrar en el espacio vacío, ejecuta pnpm start --copy-token en la carpeta del proyecto y pega el código nuevo en la pantalla de acceso.', 'To sign in to the empty workspace, run pnpm start --copy-token in the project folder and paste the new code on the sign-in screen.')}</p>
    <p><a className="button button-secondary" href="/login">{c('Ir a la pantalla de acceso', 'Go to sign in')}</a></p></>;
  if (state === 'deleted') return <div role="status" aria-live="polite"><Notice tone="success">{c('Se borraron todos tus datos de esta instalación y se cerró la sesión en todos los navegadores.', 'All your data in this installation was deleted and every browser was signed out.')}</Notice>{after}</div>;
  if (state === 'files-pending') return <div role="status" aria-live="polite"><Notice tone="error">{c('Se borraron todos los registros y se cerró la sesión, pero algunos archivos no se pudieron borrar. Se volverá a intentar al reiniciar la app (pnpm run stop y pnpm start).', 'Every record was deleted and every browser was signed out, but some files could not be deleted. It is retried when the app restarts (pnpm run stop, then pnpm start).')}</Notice>{after}</div>;
  return <details className="optional-section"><summary>{c('Borrar todos mis datos', 'Delete all my data')}</summary>
    <div className="form-stack">
      <p>{c('Borra de esta instalación tu perfil, CV, ofertas, búsquedas, solicitudes, documentos, el historial y la conexión de la IA, y las copias guardadas en data/backups. La app sigue instalada y vacía, como el primer día, y se cierra la sesión en todos los navegadores.', 'Deletes from this installation your profile, resumes, jobs, searches, applications, documents, the AI history and connection, and the backups kept in data/backups. The app stays installed and empty, as on the first day, and every browser is signed out.')}</p>
      <p>{c('No se puede deshacer. Si quizá quieras recuperar algo, crea antes una copia de seguridad y descárgala con su clave.', 'It cannot be undone. If you might want anything back, create a backup first and download it with its key.')}</p>
      <p className="muted-label">{c('No se borra lo que está fuera de la app: las copias que ya descargaste, lo que enviaste a empresas y el historial que guarde tu proveedor de IA. Para quitar también la app, usa pnpm run uninstall (docs/operations/uninstall.md).', 'What is outside the app is not deleted: backups you already downloaded, what you sent to employers, and the history your AI provider keeps. To remove the app as well, use pnpm run uninstall (docs/operations/uninstall.md).')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <Field label={c(`Para confirmar, escribe ${phrase}`, `To confirm, type ${phrase}`)} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={state === 'deleting'}
          hint={c('Se detienen las búsquedas, la IA y el navegador asistido antes de borrar. No se hace ninguna copia automática antes.', 'Searches, the AI and the assisted browser are stopped before deleting. No backup is made automatically first.')}/>
        <div><Button type="submit" variant="danger" disabled={typed.trim() !== phrase || state === 'deleting'}>{state === 'deleting' ? c('Borrando…', 'Deleting…') : c('Borrar todos mis datos', 'Delete all my data')}</Button></div>
      </form>
    </div>
  </details>;
}
