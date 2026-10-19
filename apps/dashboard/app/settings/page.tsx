'use client';

import { BackupPanel } from '@/components/backup-panel';
import { RestorePanel } from '@/components/restore-panel';
import { DeleteAllDataPanel } from '@/components/delete-all-data-panel';
import { AiConnectionPanel } from '@/components/ai/connection';
import { OllamaConnectionPanel } from '@/components/ai/ollama-connection';
import { AiAutomationPanel } from '@/components/ai/automation';
import { AiHistoryPanel } from '@/components/ai/history';
import { RELEASE_VERSION } from '@career/domain';


import { localizedError, useLocale } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Icon, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { copy } from '@/lib/labels';

type Capabilities = { release: string; available: string[]; unavailable: string[]; externalWrites: boolean; automaticSubmission: boolean };
type DesktopNotificationSettings = { enabled: boolean; language: 'en' | 'es'; status: 'NOT_TESTED' | 'ACCEPTED' | 'UNAVAILABLE' | 'FAILED'; available: boolean };
type AiPermission = { id: string; operation: string; dataCategories: string[]; searchIds: string[] | null; remembered: boolean; grantedAt: string };
function notificationSettingsError(err: unknown, locale: 'en' | 'es'): string {
  if (err instanceof ApiError && err.code === 'INVALID_NOTIFICATION_SETTINGS') return locale === 'es'
    ? 'Los ajustes de notificaciones no son válidos. Recarga la página e inténtalo de nuevo.'
    : 'The notification settings are invalid. Reload the page and try again.';
  return errorMessage(err);
}
function DesktopNotificationsPanel() {
  const { locale } = useLocale(); const c = copy(locale);
  const [settings, setSettings] = useState<DesktopNotificationSettings | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { const controller = new AbortController(); void api<DesktopNotificationSettings>('/notifications', { signal: controller.signal }).then(setSettings).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }); return () => controller.abort(); }, []);
  useEffect(() => {
    if (!settings || settings.language === locale || busy) return;
    setBusy(true); void api<DesktopNotificationSettings>('/notifications', { method: 'PUT', body: JSON.stringify({ enabled: settings.enabled, language: locale }) })
      .then(setSettings).catch(err => setError(notificationSettingsError(err, locale))).finally(() => setBusy(false));
  }, [locale, settings, busy]);
  const save = async (enabled: boolean) => {
    if (!settings || busy) return;
    setBusy(true); setError(''); setMessage('');
    try { setSettings(await api<DesktopNotificationSettings>('/notifications', { method: 'PUT', body: JSON.stringify({ enabled, language: locale }) })); }
    catch (err) { setError(notificationSettingsError(err, locale)); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError(''); setMessage('');
    try { await api<{ status: string }>('/notifications/test', { method: 'POST' }); setMessage(c('La notificación de prueba se entregó al sistema. Si no aparece, revisa los permisos de notificaciones del sistema operativo.', 'The test notification was handed to the operating system. If it does not appear, check your operating system notification settings.')); setSettings(current => current ? { ...current, status: 'ACCEPTED' } : current); }
    catch (err) {
      const failed = err instanceof ApiError && err.code === 'NATIVE_NOTIFICATIONS_UNAVAILABLE'
        ? c('No hay un proveedor de notificaciones disponible en este equipo.', 'No native notification provider is available on this device.')
        : err instanceof ApiError && err.code === 'NATIVE_NOTIFICATION_FAILED'
          ? c('El sistema no aceptó la notificación. Revisa sus ajustes e inténtalo de nuevo.', 'The system did not accept the notification. Check its settings and try again.')
          : errorMessage(err);
      setError(failed); setSettings(current => current ? { ...current, status: err instanceof ApiError && err.code === 'NATIVE_NOTIFICATIONS_UNAVAILABLE' ? 'UNAVAILABLE' : 'FAILED' } : current);
    }
    finally { setBusy(false); }
  };
  const statusText = settings?.status === 'ACCEPTED' ? c('El sistema aceptó la última notificación; la visibilidad también depende de sus ajustes.', 'The system accepted the last notification; visibility also depends on its settings.')
    : settings?.status === 'UNAVAILABLE' ? c('No hay un proveedor de notificaciones del sistema disponible en este equipo.', 'A native notification provider is unavailable on this device.')
      : settings?.status === 'FAILED' ? c('Falló el último intento. Revisa la configuración de notificaciones del sistema.', 'The last attempt failed. Check the operating system notification settings.')
        : c('Prueba la notificación para comprobar que el sistema la puede mostrar.', 'Send a test notification to check whether the system can display it.');
  return <section aria-labelledby="desktop-notifications-heading"><Card className="form-card"><h2 id="desktop-notifications-heading">{c('Avisos de ofertas nuevas', 'New job notifications')}</h2>
    <p>{c('Recibe un aviso del sistema después de una búsqueda automática completada con ofertas nuevas. No se incluyen puestos, empresas ni salarios.', 'Get a system notification after a completed automatic search finds new jobs. Job titles, companies, and salaries are not included.')}</p>
    <label className="settings-notification-toggle"><input type="checkbox" checked={settings?.enabled ?? false} disabled={!settings || busy || !settings.available} onChange={event => void save(event.target.checked)}/><span>{c('Activar notificaciones del sistema', 'Enable system notifications')}</span></label>
    <p role="status" aria-live="polite">{settings ? statusText : c('Cargando estado…', 'Loading status…')}</p>
    <p>{c('El sistema operativo controla el permiso final y puede no permitir consultar su estado desde la app. El botón de prueba puede activar el aviso de permiso.', 'The operating system controls final permission and may not let the app query it. The test button may trigger a permission prompt.')}</p>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <Button type="button" variant="secondary" disabled={!settings?.available || busy} onClick={() => void test()}>{busy ? c('Guardando…', 'Saving…') : c('Probar notificación', 'Test notification')}</Button>
  </Card></section>;
}
function AiPermissionsPanel({ connectionRevision, onChanged }: { connectionRevision: number; onChanged: () => void }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [open, setOpen] = useState(false);
  const [permissions, setPermissions] = useState<AiPermission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<{ consents: AiPermission[] }>('/ai/consents', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setPermissions(result.consents.filter(permission => permission.remembered || !!permission.searchIds?.length));
    }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, revision, connectionRevision]);
  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(id); setError(''); setRemoved(false);
    try {
      await api(`/ai/consents/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
      setPermissions(current => current.filter(permission => permission.id !== id)); setRemoved(true);
      onChanged();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };
  const names: Record<string, string> = { SEARCH_DRAFT: c('Preparar búsquedas', 'Prepare searches'), JOB_ANALYSIS: c('Entender ofertas', 'Understand jobs'), RESUME_DRAFT: c('Sugerir textos para mi CV', 'Suggest resume wording'), ANSWER_DRAFT: c('Preparar respuestas', 'Prepare answers') };
  const categories: Record<string, string> = { SEARCH_REQUEST: c('lo que buscas', 'your search request'), JOB_POSTING: c('texto de la oferta', 'job posting text'), APPROVED_FACTS: c('datos confirmados del perfil', 'confirmed profile details'), APPLICATION_QUESTION: c('pregunta de la solicitud', 'application question') };
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{c('Permisos de IA que guardaste', 'Saved AI permissions')}</summary><div className="form-stack">
    <p>{c('Puedes retirar un permiso cuando quieras. Para usar esa ayuda de nuevo tendrás que autorizarla otra vez.', 'You can withdraw permission whenever you want. You will need to allow that help again before using it.')}</p>
    {loading && <p role="status">{c('Consultando permisos…', 'Checking permissions…')}</p>}
    {error && <Notice tone="error" actions={<Button type="button" variant="secondary" onClick={() => setRevision(value => value + 1)}>{c('Reintentar', 'Try again')}</Button>}>{error}</Notice>}
    {removed && <Notice tone="success">{c('Permiso retirado.', 'Permission withdrawn.')}</Notice>}
    {!loading && !error && permissions.length === 0 && <p>{c('No tienes permisos guardados para futuras tareas de IA.', 'You have no saved permissions for future AI tasks.')}</p>}
    {permissions.map(permission => <div className="form-stack" key={permission.id}><h3>{names[permission.operation] ?? c('Ayuda con IA', 'AI assistance')}</h3><p>{permission.dataCategories.map(category => categories[category] ?? c('datos de la tarea', 'task details')).join(' · ')}</p>{!!permission.searchIds?.length && <p>{c(`Análisis automático autorizado para ${permission.searchIds.length} búsquedas.`, `Automatic analysis allowed for ${permission.searchIds.length} searches.`)}</p>}<div><Button type="button" variant="secondary" disabled={busy !== null || loading} onClick={() => void revoke(permission.id)}>{busy === permission.id ? c('Retirando permiso…', 'Withdrawing permission…') : c('Retirar permiso', 'Withdraw permission')}</Button></div></div>)}
  </div></details>;
}
const labels: Record<string, string> = { 'saved-job-searches': 'Búsquedas automáticas por puesto o empresa', 'automatic-preparation': 'Preparación automática de solicitudes', 'supported-submission': 'Envío experimental autorizado en Lever', 'scheduled-discovery': 'Consulta periódica de empresas', 'new-jobs-inbox': 'Ofertas nuevas por revisar', 'manual-profile': 'Perfil y datos que confirmaste', 'fact-approval': 'Aprobación manual', 'answer-bank': 'Banco de respuestas', 'manual-job-import': 'Importación manual', 'approved-board-discovery': 'Descubrimiento por tableros aprobados', 'rule-based-matching': 'Encaje explicable', 'application-ledger': 'Seguimiento de solicitudes', 'reviewed-pdf-drafts': 'Borradores PDF revisables', 'json-export': 'Exportación JSON', 'local-backup-restore': 'Copia local y recuperación', 'ai-processing': 'Procesamiento con IA', 'browser-autofill': 'Autorrelleno en navegador', 'external-submission': 'Envío a empresas', 'email-oauth': 'Acceso al correo', 'interview-coach': 'Preparación de entrevistas', 'hosted-multi-tenancy': 'Alojamiento multiusuario' };
export default function SettingsPage() {
  const { t, locale } = useLocale();
  const c = copy(locale);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const downloadExport = async () => {
    setExporting(true); setError(''); setExportMessage('');
    try {
      const response = await fetch('/api/v1/export', { credentials: 'same-origin' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new ApiError(localizedError(result.error ?? 'INTERNAL_ERROR', locale), response.status, result.error ?? 'INTERNAL_ERROR');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `career-workspace-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportMessage(c('Exportación preparada. Comprueba la descarga y guárdala en una ubicación privada.', 'Export prepared. Check your download and keep it in a private location.'));
    } catch (err) { setError(errorMessage(err)); }
    finally { setExporting(false); }
  };
  const [caps, setCaps] = useState<Capabilities | null>(null); const [error, setError] = useState('');
  const [aiConnectionRevision, setAiConnectionRevision] = useState(0);
  useEffect(() => { api<Capabilities>('/capabilities').then(setCaps).catch((err) => setError(errorMessage(err))); }, []);
  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('TU ESPACIO', 'YOUR WORKSPACE')} title={c('Ajustes y privacidad', 'Settings and privacy')} description={c('Elige la ayuda que quieres usar, guarda una copia y controla tus datos.', 'Choose the help you want to use, keep a backup, and control your data.')}/>
    {error && <Notice tone="error">{error}</Notice>}
    {exportMessage && <Notice tone="success">{exportMessage}</Notice>}
    <div className="settings-grid"><div className="settings-main">
      <DesktopNotificationsPanel/>
      <section id="assistant" aria-label={c('Conexión y permisos de IA', 'AI connection and permissions')}><Card className="form-card">
        <AiConnectionPanel onConnectionChange={() => setAiConnectionRevision(value => value + 1)}/>
        <OllamaConnectionPanel/>
        <AiPermissionsPanel connectionRevision={aiConnectionRevision} onChanged={() => setAiConnectionRevision(value => value + 1)}/>
        <AiAutomationPanel connectionRevision={aiConnectionRevision} onChanged={() => setAiConnectionRevision(value => value + 1)}/>
        <AiHistoryPanel/>
      </Card></section>
      <Card className="form-card"><h2>{c('Copia de seguridad para recuperar tu espacio', 'Back up your workspace for recovery')}</h2>
        <BackupPanel/>
        <RestorePanel/>
        <details><summary>{c('Recuperar una copia y otras opciones', 'Restore a backup and other options')}</summary>
          <p><strong>macOS:</strong> {c('también puedes crear la copia abriendo Backup Career Agent Stack.command desde la carpeta de instalación.', 'you can also create a backup by opening Backup Career Agent Stack.command in the installation folder.')}</p>
          <p>{c('El asistente de arriba verifica la copia y restaura en un espacio independiente que puedes abrir cuando quieras. Para la recuperación manual avanzada, consulta docs/operations/backup-restore.md.', 'The assistant above verifies the backup and restores it into a separate workspace that you can open when ready. For advanced manual recovery, see docs/operations/backup-restore.md.')}</p>
          <p>{c('La copia está cifrada con tu clave de recuperación: guarda la clave aparte, porque quien tenga las dos puede leer tus datos. Las copias anteriores al cifrado no están protegidas: haz una nueva y borra las antiguas.', 'The backup is encrypted with your recovery key: keep the key apart, because anyone with both can read your data. Backups made before encryption are not protected: make a new one and delete the old ones.')}</p>
        </details>
      </Card>
      <details className="optional-section"><summary>{c('Exportar a otra herramienta · avanzado', 'Export to another tool · advanced')}</summary><Card className="settings-export"><div className="export-art"><Icon name="download" size={20}/></div><div>
        <h2>{c('Descargar mis datos', 'Download my data')}</h2>
        <p>{c('Obtén tus datos y PDF en un archivo JSON para consultarlos o trasladarlos a otra herramienta. Para recuperar Career Stack, utiliza la copia de seguridad de arriba.', 'Get your data and PDFs in a JSON file to inspect them or move them to another tool. To recover Career Stack, use the backup above.')}</p>
        <small>{c('La descarga no cambia tus empresas conectadas ni tus datos. Contiene información personal: guárdala en privado.', 'Downloading does not change your connected companies or data. It contains personal information: keep it private.')}</small>
      </div><Button variant="secondary" disabled={exporting} onClick={() => void downloadExport()}>{exporting ? c('Preparando archivo…', 'Preparing file…') : c('Descargar mis datos', 'Download my data')} <Icon name="download" size={15}/></Button></Card></details>
      <DeleteAllDataPanel/>
      <Card className="capability-card"><details><summary>{c('Funciones incluidas y límites de esta versión', 'Included features and limitations')}</summary>
        <div className="capability-columns"><div><h3>{c('Disponible', 'Available')}</h3>{caps?.available.map((item) => <div className="capability-row" key={item}><Icon name="check" size={15}/><span>{t(labels[item] ?? item)}</span></div>)}</div>
        <div><h3>{c('Todavía no incluido', 'Not included yet')}</h3>{caps?.unavailable.map((item) => <div className="capability-row capability-unavailable" key={item}><span>{t(labels[item] ?? item)}</span></div>)}</div></div>
      </details></Card>
    </div><aside className="settings-side" aria-labelledby="settings-side-heading"><Card className="settings-side-card"><h2 id="settings-side-heading">{c('Solo en este equipo', 'Only on this device')}</h2><p>{c('Este espacio es para una persona. Tus datos no se sincronizan con otros equipos.', 'This workspace is for one person. Your data is not synced to other devices.')}</p><p>{c('Revisa el CV y autoriza cada envío. Los formularios compatibles de Lever pueden enviarse desde la app; los demás requieren continuar en la página de la empresa.', 'Review the resume and authorize each submission. Supported Lever forms can be submitted from the app; other forms require continuing on the company website.')}</p><Tag tone="green">{caps?.release ?? RELEASE_VERSION}</Tag></Card>
    <Card className="settings-side-card"><details><summary>{c('Detalles de privacidad', 'Privacy details')}</summary><p>{t('Esta versión no implementa usuarios remotos ni sincronización en nube. No compartas el puerto local con tu red.')}</p><p>{t('Los registros de eventos y las exportaciones pueden contener notas sensibles. Elimina las copias antiguas cuando ya no las necesites.')}</p></details></Card></aside></div>
  </AppShell></WorkspaceGate>;
}
