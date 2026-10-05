'use client';

import { BackupPanel } from '@/components/backup-panel';
import { AiConnectionPanel } from '@/components/ai/connection';
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
type AiPermission = { id: string; operation: string; dataCategories: string[]; searchIds: string[] | null; remembered: boolean; grantedAt: string };
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
const labels: Record<string, string> = { 'saved-job-searches': 'Búsquedas automáticas por puesto o empresa', 'automatic-preparation': 'Preparación automática de candidaturas', 'supported-submission': 'Envío experimental autorizado en Lever', 'scheduled-discovery': 'Consulta periódica de empresas', 'new-jobs-inbox': 'Ofertas nuevas por revisar', 'manual-profile': 'Perfil y datos que confirmaste', 'fact-approval': 'Aprobación manual', 'answer-bank': 'Banco de respuestas', 'manual-job-import': 'Importación manual', 'approved-board-discovery': 'Descubrimiento por tableros aprobados', 'rule-based-matching': 'Encaje explicable', 'application-ledger': 'Seguimiento de solicitudes', 'reviewed-pdf-drafts': 'Borradores PDF revisables', 'json-export': 'Exportación JSON', 'local-backup-restore': 'Copia local y recuperación', 'ai-processing': 'Procesamiento con IA', 'browser-autofill': 'Autorrelleno en navegador', 'external-submission': 'Envío a empresas', 'email-oauth': 'Acceso al correo', 'interview-coach': 'Preparación de entrevistas', 'hosted-multi-tenancy': 'Alojamiento multiusuario' };
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
      <section id="assistant" aria-label={c('Conexión y permisos de IA', 'AI connection and permissions')}><Card className="form-card">
        <AiConnectionPanel onConnectionChange={() => setAiConnectionRevision(value => value + 1)}/>
        <AiPermissionsPanel connectionRevision={aiConnectionRevision} onChanged={() => setAiConnectionRevision(value => value + 1)}/>
        <AiAutomationPanel connectionRevision={aiConnectionRevision} onChanged={() => setAiConnectionRevision(value => value + 1)}/>
        <AiHistoryPanel/>
      </Card></section>
      <Card className="form-card"><h2>{c('Copia de seguridad para recuperar tu espacio', 'Back up your workspace for recovery')}</h2>
        <BackupPanel/>
        <details><summary>{c('Recuperar una copia y otras opciones', 'Restore a backup and other options')}</summary>
          <p><strong>macOS:</strong> {c('también puedes crear la copia abriendo Backup Career Agent Stack.command desde la carpeta de instalación.', 'you can also create a backup by opening Backup Career Agent Stack.command in the installation folder.')}</p>
          <p>{c('Desde la carpeta del proyecto, ejecuta pnpm run backup para crear una copia. Para restaurar, sigue docs/operations/backup-restore.md. La recuperación crea un espacio independiente que puedes revisar antes de usar.', 'From the project folder, run pnpm run backup to create a backup. To restore it, follow docs/operations/backup-restore.md. Recovery creates a separate workspace you can review before using.')}</p>
          <p>{c('La recuperación todavía requiere la terminal. La copia contiene datos personales y no está cifrada: guárdala en un disco cifrado o con acceso restringido.', 'Recovery still requires a terminal. The backup contains personal data and is not encrypted: keep it on an encrypted drive or in a restricted location.')}</p>
        </details>
      </Card>
      <details className="optional-section"><summary>{c('Exportar a otra herramienta · avanzado', 'Export to another tool · advanced')}</summary><Card className="settings-export"><div className="export-art"><Icon name="download" size={20}/></div><div>
        <h2>{c('Descargar mis datos', 'Download my data')}</h2>
        <p>{c('Obtén tus datos y PDF en un archivo JSON para consultarlos o trasladarlos a otra herramienta. Para recuperar Career Stack, utiliza la copia de seguridad de arriba.', 'Get your data and PDFs in a JSON file to inspect them or move them to another tool. To recover Career Stack, use the backup above.')}</p>
        <small>{c('La descarga no cambia tus empresas conectadas ni tus datos. Contiene información personal: guárdala en privado.', 'Downloading does not change your connected companies or data. It contains personal information: keep it private.')}</small>
      </div><Button variant="secondary" disabled={exporting} onClick={() => void downloadExport()}>{exporting ? c('Preparando archivo…', 'Preparing file…') : c('Descargar mis datos', 'Download my data')} <Icon name="download" size={15}/></Button></Card></details>
      <Card className="capability-card"><details><summary>{c('Funciones incluidas y límites de esta versión', 'Included features and limitations')}</summary>
        <div className="capability-columns"><div><h3>{c('Disponible', 'Available')}</h3>{caps?.available.map((item) => <div className="capability-row" key={item}><Icon name="check" size={15}/><span>{t(labels[item] ?? item)}</span></div>)}</div>
        <div><h3>{c('Todavía no incluido', 'Not included yet')}</h3>{caps?.unavailable.map((item) => <div className="capability-row capability-unavailable" key={item}><span>{t(labels[item] ?? item)}</span></div>)}</div></div>
      </details></Card>
    </div><aside className="settings-side"><Card className="settings-side-card"><h2>{c('Solo en este equipo', 'Only on this device')}</h2><p>{c('Este espacio es para una persona. Tus datos no se sincronizan con otros equipos.', 'This workspace is for one person. Your data is not synced to other devices.')}</p><p>{c('Revisa el CV y autoriza cada envío. Los formularios compatibles de Lever pueden enviarse desde la app; los demás requieren continuar en la página de la empresa.', 'Review the resume and authorize each submission. Supported Lever forms can be submitted from the app; other forms require continuing on the company website.')}</p><Tag tone="green">{caps?.release ?? RELEASE_VERSION}</Tag></Card>
    <Card className="settings-side-card"><details><summary>{c('Detalles de privacidad', 'Privacy details')}</summary><p>{t('Esta versión no implementa usuarios remotos ni sincronización en nube. No compartas el puerto local con tu red.')}</p><p>{t('Los registros de eventos y las exportaciones pueden contener notas sensibles. Elimina las copias antiguas cuando ya no las necesites.')}</p></details></Card></aside></div>
  </AppShell></WorkspaceGate>;
}
