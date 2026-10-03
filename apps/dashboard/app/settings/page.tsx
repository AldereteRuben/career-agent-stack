'use client';

import { localizedError, useLocale } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Icon, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { copy } from '@/lib/labels';

type Capabilities = { release: string; available: string[]; unavailable: string[]; externalWrites: boolean; automaticSubmission: boolean };
const labels: Record<string, string> = { 'manual-profile': 'Perfil y datos que confirmaste', 'fact-approval': 'Aprobación manual', 'answer-bank': 'Banco de respuestas', 'manual-job-import': 'Importación manual', 'approved-board-discovery': 'Descubrimiento por tableros aprobados', 'rule-based-matching': 'Encaje explicable', 'application-ledger': 'Seguimiento de candidaturas', 'reviewed-pdf-drafts': 'Borradores PDF revisables', 'json-export': 'Exportación JSON', 'local-backup-restore': 'Copia local y recuperación', 'ai-processing': 'Procesamiento con IA', 'browser-autofill': 'Autorrelleno en navegador', 'external-submission': 'Envío a empresas', 'email-oauth': 'Acceso al correo', 'interview-coach': 'Preparación de entrevistas', 'hosted-multi-tenancy': 'Alojamiento multiusuario' };
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
    <PageHeader eyebrow={t("CONTROL Y TRANSPARENCIA")} title={t("La privacidad se puede ver.")} description={t("Conoce qué está disponible, qué permanece en tu equipo y qué aún no hace esta versión.")}/>
    {error && <Notice tone="error">{error}</Notice>}
    {exportMessage && <Notice tone="success">{exportMessage}</Notice>}
    <div className="settings-grid"><div className="settings-main">
      <Card className="settings-hero"><span className="card-icon mint"><Icon name="shield" size={19}/></span><div><Tag tone="green">{t("INSTALACIÓN LOCAL")}</Tag><h2>{t("Tu búsqueda vive aquí.")}</h2><p>{t("Tus datos se guardan en este equipo. El acceso inicial utiliza un código de un solo uso y tu sesión permanece privada.")}</p></div><div className="settings-hero-foot"><span>{t("RELEASE")}</span><strong>{caps?.release ?? 'v0.3.1'}</strong><span>{t("·")}</span><span>{t("ENVÍOS EXTERNOS")}</span><strong>{c('SOLO CON TU CONTROL', 'ONLY UNDER YOUR CONTROL')}</strong></div></Card>
      <Card className="capability-card"><div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {t("ESTADO REAL DEL PRODUCTO")}</div><h2>{t("Lo que puedes hacer")}</h2></div></div><div className="capability-columns"><div><div className="capability-label"><span className="status-dot status-ready"/> {t("DISPONIBLE")}</div>{caps?.available.map((item) => <div className="capability-row" key={item}><Icon name="check" size={15}/><span>{t(labels[item] ?? item)}</span></div>)}</div><div><div className="capability-label"><span className="status-dot status-paused"/> {t("AÚN NO DISPONIBLE")}</div>{caps?.unavailable.map((item) => <div className="capability-row capability-unavailable" key={item}><span className="capability-dash">{t("—")}</span><span>{t(labels[item] ?? item)}</span><Tag tone="neutral">{t("DESACTIVADO")}</Tag></div>)}</div></div></Card>
      <Card className="settings-export"><div className="export-art"><Icon name="download" size={20}/></div><div><h3>{t("Tu copia de trabajo")}</h3><p>{t("Exporta perfil, hechos, respuestas, vacantes, fuentes y candidaturas. Las fuentes quedan desactivadas al exportar. Los PDF generados se adjuntan al archivo JSON.")}</p><small>{t("Incluye datos personales. Guarda la copia en una ubicación privada.")}</small></div><Button variant="secondary" disabled={exporting} onClick={() => void downloadExport()}>{exporting ? c("Preparando archivo…", "Preparing file…") : t("Descargar exportación")} <Icon name="download" size={15}/></Button></Card>
    </div><aside className="settings-side"><Card className="settings-side-card"><span className="aside-number">{t("01")}</span><h3>{t("Una instalación, un espacio.")}</h3><p>{t("Esta versión no implementa usuarios remotos ni sincronización en nube. No compartas el puerto local con tu red.")}</p></Card><Card className="settings-side-card"><span className="aside-number">{t("02")}</span><h3>{t("El historial también es dato personal.")}</h3><p>{t("Los registros de eventos y las exportaciones pueden contener notas sensibles. Elimina las copias antiguas cuando ya no las necesites.")}</p></Card><Card className="settings-side-card settings-side-warning"><div className="card-icon peach"><Icon name="shield" size={17}/></div><h3>{c('Copia de seguridad y recuperación', 'Backup and recovery')}</h3><p>{c('En macOS, abre Backup Career Agent Stack.command en la carpeta del proyecto. Comprueba que termine correctamente y guarda la copia en una ubicación privada.', 'On macOS, open Backup Career Agent Stack.command in the project folder. Check that it finishes successfully and keep the backup in a private location.')}</p><p>{c('La restauración crea un espacio independiente para que puedas revisarlo antes de usarlo.', 'Restoration creates a separate workspace so you can review it before using it.')}</p><details><summary>{c('Instrucciones de recuperación', 'Recovery instructions')}</summary><p>{c('Desde la carpeta del proyecto, ejecuta pnpm run backup. Para restaurar, sigue docs/operations/backup-restore.md. Conserva también el archivo de clave por separado: se necesita para recuperar la copia.', 'From the project folder, run pnpm run backup. To restore, follow docs/operations/backup-restore.md. Also keep the separate key file: it is required for recovery.')}</p><p>{c('La copia contiene datos personales y no está cifrada. Guárdala en un disco cifrado o en una ubicación con acceso restringido.', 'The backup contains personal data and is not encrypted. Store it on an encrypted drive or in a location with restricted access.')}</p></details></Card></aside></div>
    <div className="settings-disclosure"><strong>{t("Sin sorpresas.")}</strong> {t("Lever permite autocompletar datos de contacto con autorización. Revisa la misma ventana y toma el control para adjuntar y enviar tú. No hay envío automático, IA ni acceso al correo.")}</div>
  </AppShell></WorkspaceGate>;
}
