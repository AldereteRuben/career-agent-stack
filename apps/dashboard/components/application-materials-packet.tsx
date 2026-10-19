'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Notice } from '@/components/ui';
import { copy, labelFor } from '@/lib/labels';
import { useLocale } from '@/lib/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';

type PacketFile = { id: string; fileName: string; kind: 'RESUME' | 'COVER_LETTER'; language: string; revision: number | null; selectable: boolean; reason?: string; newerPendingRevision: boolean };
type PacketFilesResponse = { files: PacketFile[] };

export function ApplicationMaterialsPacket({ applicationId }: { applicationId: string }) {
  const { locale } = useLocale();
  const c = copy(locale);
  const [files, setFiles] = useState<PacketFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const selectedFiles = files.filter((file) => selectedIds.includes(file.id) && file.selectable);
  const selectedFilesHaveNewerDraft = selectedFiles.some((file) => file.newerPendingRevision);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setFiles([]);
    setSelectedIds([]);
    void api<PacketFilesResponse>(`/applications/${applicationId}/materials`)
      .then((response) => { if (active) setFiles(response.files); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [applicationId]);

  const download = async () => {
    if (!selectedIds.length || busy) return;
    setBusy(true);
    setError('');
    setAnnouncement(c('Preparando el paquete ZIP…', 'Preparing the ZIP packet…'));
    try {
      const response = await fetch(`/api/v1/applications/${applicationId}/materials.zip`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: selectedIds }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; detail?: string };
        throw new ApiError('', response.status, payload.error ?? 'UNKNOWN', payload.detail);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'application-materials.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setAnnouncement(c('Descarga del paquete ZIP iniciada.', 'ZIP packet download started.'));
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && reason.code === 'MATERIAL_NOT_AVAILABLE') {
        setFiles([]);
        setSelectedIds([]);
        setLoading(true);
        void api<PacketFilesResponse>(`/applications/${applicationId}/materials`)
          .then((response) => { setFiles(response.files); setError(''); })
          .catch((reloadError: unknown) => setError(errorMessage(reloadError)))
          .finally(() => setLoading(false));
      }
    } finally {
      setBusy(false);
    }
  };

  return <Card className="application-resume application-materials">
    <h3>{c('Paquete de materiales', 'Application materials packet')}</h3>
    <p>{c('Elige los archivos aprobados que quieras descargar juntos. No se envía nada a la empresa.', 'Choose the approved files to download together. Nothing is sent to the employer.')}</p>
    {loading ? <p role="status">{c('Buscando archivos aprobados…', 'Loading approved files…')}</p>
      : error ? <><p role="alert" className="field-hint">{error}</p><Button variant="quiet" onClick={() => {
        setLoading(true); setError('');
        void api<PacketFilesResponse>(`/applications/${applicationId}/materials`)
          .then((response) => setFiles(response.files))
          .catch((reason: unknown) => setError(errorMessage(reason)))
          .finally(() => setLoading(false));
      }}>{c('Reintentar', 'Retry')}</Button></>
        : files.length ? <fieldset className="application-material-list" disabled={busy}>
          <legend>{c('Archivos que puedes incluir', 'Files you can include')}</legend>
          {files.map((file) => {
            const checked = selectedIds.includes(file.id);
            const kind = file.kind === 'RESUME' ? c('CV', 'Resume') : c('Carta de presentación', 'Cover letter');
            return <div className="application-material-choice" key={file.id}>
              {file.selectable ? <label>
                <input type="checkbox" aria-label={file.fileName} checked={checked} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))}/>
                <span><strong>{file.fileName}</strong><small>{kind} · {file.language.toUpperCase()}{file.revision ? ` · ${c('Revisión', 'Revision')} ${file.revision}` : ''}</small></span>
              </label> : <div className="application-material-unavailable">
                <span><strong>{file.fileName}</strong><small>{kind} · {file.language.toUpperCase()}{file.revision ? ` · ${c('Revisión', 'Revision')} ${file.revision}` : ''}</small></span>
                <p>{labelFor.applicationPacketReason(file.reason ?? 'APPLICATION_DOCUMENT_NEEDS_REVIEW', locale)}</p>
              </div>}
              {file.selectable && file.newerPendingRevision && <p className="field-hint">{c('Hay una edición más reciente pendiente de aprobación. Esta descarga contiene la última versión aprobada.', 'A newer edit is awaiting approval. This download contains the latest approved version.')}</p>}
            </div>;
          })}
        </fieldset>
        : <p>{c('No hay archivos aprobados y vigentes para esta solicitud todavía.', 'There are no approved, current files for this application yet.')}</p>}
    {error && !loading && files.length > 0 && <p role="alert" className="field-hint">{error}</p>}
    {files.length > 0 && <p role="status" aria-live="polite">{c(`${selectedFiles.length} archivos seleccionados`, `${selectedFiles.length} files selected`)}</p>}
    {selectedFilesHaveNewerDraft && <Notice tone="warning" role={null}>{c('Uno o más archivos seleccionados tienen una edición más reciente pendiente. El ZIP incluirá únicamente las versiones aprobadas.', 'One or more selected files have a newer edit awaiting approval. The ZIP will include only approved versions.')}</Notice>}
    <div className="button-row"><Button variant="secondary" disabled={loading || busy || selectedFiles.length === 0} onClick={() => void download()}>{busy ? c('Preparando ZIP…', 'Preparing ZIP…') : c('Descargar seleccionados', 'Download selected files')}</Button></div>
    {announcement && <p role="status" aria-live="polite">{announcement}</p>}
  </Card>;
}
