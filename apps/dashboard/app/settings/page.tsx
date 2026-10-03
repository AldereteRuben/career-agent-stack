'use client';

import { RELEASE_VERSION } from '@career/domain';


import { localizedError, useLocale } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Icon, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { copy } from '@/lib/labels';

type Capabilities = { release: string; available: string[]; unavailable: string[]; externalWrites: boolean; automaticSubmission: boolean };
const labels: Record<string, string> = { 'manual-profile': 'Perfil y datos que confirmaste', 'fact-approval': 'Aprobación manual', 'answer-bank': 'Banco de respuestas', 'manual-job-import': 'Importación manual', 'approved-board-discovery': 'Descubrimiento por tableros aprobados', 'rule-based-matching': 'Encaje explicable', 'application-ledger': 'Seguimiento de solicitudes', 'reviewed-pdf-drafts': 'Borradores PDF revisables', 'json-export': 'Exportación JSON', 'local-backup-restore': 'Copia local y recuperación', 'ai-processing': 'Procesamiento con IA', 'browser-autofill': 'Autorrelleno en navegador', 'external-submission': 'Envío a empresas', 'email-oauth': 'Acceso al correo', 'interview-coach': 'Preparación de entrevistas', 'hosted-multi-tenancy': 'Alojamiento multiusuario' };
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
  useEffect(() => { api<Capabilities>('/capabilities').then(setCaps).catch((err) => setError(errorMessage(err))); }, []);
  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('TU ESPACIO', 'YOUR WORKSPACE')} title={c('Ajustes y privacidad', 'Settings and privacy')} description={c('Guarda una copia de tus datos y consulta cómo funciona tu espacio local.', 'Keep a copy of your data and see how your local workspace works.')}/>
    {error && <Notice tone="error">{error}</Notice>}
    {exportMessage && <Notice tone="success">{exportMessage}</Notice>}
    <div className="settings-grid"><div className="settings-main">
      <Card className="form-card"><h2>{c('Copia de seguridad para recuperar tu espacio', 'Back up your workspace for recovery')}</h2>
        <p>{c('Conserva tus datos, documentos y configuración para recuperar esta instalación.', 'Keep your data, documents, and settings so you can recover this installation.')}</p>
        <ol className="help-steps">
          <li>{c('Abre una terminal en la carpeta donde instalaste Career Stack.', 'Open a terminal in the folder where you installed Career Stack.')}</li>
          <li>{c('Ejecuta', 'Run')} <code>pnpm run backup</code>.</li>
          <li>{c('Espera el mensaje de éxito. Guarda la copia y su archivo de clave en ubicaciones privadas separadas; necesitas ambos para recuperar los datos.', 'Wait for the success message. Keep the backup and its key file in separate private locations; you need both to recover your data.')}</li>
        </ol>
        <details><summary>{c('Recuperar una copia y otras opciones', 'Restore a backup and other options')}</summary>
          <p><strong>macOS:</strong> {c('también puedes crear la copia abriendo Backup Career Agent Stack.command desde la carpeta de instalación.', 'you can also create a backup by opening Backup Career Agent Stack.command in the installation folder.')}</p>
          <p>{c('Desde la carpeta del proyecto, ejecuta pnpm run backup para crear una copia. Para restaurar, sigue docs/operations/backup-restore.md. La recuperación crea un espacio independiente que puedes revisar antes de usar.', 'From the project folder, run pnpm run backup to create a backup. To restore it, follow docs/operations/backup-restore.md. Recovery creates a separate workspace you can review before using.')}</p>
          <p>{c('La recuperación todavía requiere la terminal. La copia contiene datos personales y no está cifrada: guárdala en un disco cifrado o con acceso restringido.', 'Recovery still requires a terminal. The backup contains personal data and is not encrypted: keep it on an encrypted drive or in a restricted location.')}</p>
        </details>
      </Card>
      <Card className="settings-export"><div className="export-art"><Icon name="download" size={20}/></div><div>
        <h2>{c('Descargar mis datos', 'Download my data')}</h2>
        <p>{c('Obtén tus datos y PDF en un archivo JSON para consultarlos o trasladarlos a otra herramienta. Para recuperar Career Stack, utiliza la copia de seguridad de arriba.', 'Get your data and PDFs in a JSON file to inspect them or move them to another tool. To recover Career Stack, use the backup above.')}</p>
        <small>{c('La descarga no cambia tus empresas conectadas ni tus datos. Contiene información personal: guárdala en privado.', 'Downloading does not change your connected companies or data. It contains personal information: keep it private.')}</small>
      </div><Button variant="secondary" disabled={exporting} onClick={() => void downloadExport()}>{exporting ? c('Preparando archivo…', 'Preparing file…') : c('Descargar mis datos', 'Download my data')} <Icon name="download" size={15}/></Button></Card>
      <Card className="capability-card"><details><summary>{c('Funciones incluidas y límites de esta versión', 'Included features and limitations')}</summary>
        <div className="capability-columns"><div><h3>{c('Disponible', 'Available')}</h3>{caps?.available.map((item) => <div className="capability-row" key={item}><Icon name="check" size={15}/><span>{t(labels[item] ?? item)}</span></div>)}</div>
        <div><h3>{c('Todavía no incluido', 'Not included yet')}</h3>{caps?.unavailable.map((item) => <div className="capability-row capability-unavailable" key={item}><span>{t(labels[item] ?? item)}</span></div>)}</div></div>
      </details></Card>
    </div><aside className="settings-side"><Card className="settings-side-card"><h2>{c('Solo en este equipo', 'Only on this device')}</h2><p>{c('Este espacio es para una persona. Tus datos no se sincronizan con otros equipos.', 'This workspace is for one person. Your data is not synced to other devices.')}</p><p>{c('Tú revisas y envías las solicitudes desde la página de cada empresa.', 'You review and submit applications on each employer’s website.')}</p><Tag tone="green">{caps?.release ?? RELEASE_VERSION}</Tag></Card>
    <Card className="settings-side-card"><details><summary>{c('Detalles de privacidad', 'Privacy details')}</summary><p>{t('Esta versión no implementa usuarios remotos ni sincronización en nube. No compartas el puerto local con tu red.')}</p><p>{t('Los registros de eventos y las exportaciones pueden contener notas sensibles. Elimina las copias antiguas cuando ya no las necesites.')}</p></details></Card></aside></div>
  </AppShell></WorkspaceGate>;
}
