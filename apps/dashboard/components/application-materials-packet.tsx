'use client';

import { useEffect, useState } from 'react';
import { Button, Card } from '@/components/ui';
import { copy } from '@/lib/labels';
import { useLocale } from '@/lib/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';

type PacketFile = { id: string; fileName: string; kind: 'RESUME' | 'COVER_LETTER'; language: string; revision: number | null };
type PacketFilesResponse = { files: PacketFile[] };

export function ApplicationMaterialsPacket({ applicationId }: { applicationId: string }) {
  const { locale } = useLocale();
  const c = copy(locale);
  const [files, setFiles] = useState<PacketFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      : error ? <><p role="status" className="field-hint">{error}</p><Button variant="quiet" onClick={() => {
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
            return <label className="application-material-choice" key={file.id}>
              <input type="checkbox" aria-label={file.fileName} checked={checked} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))}/>
              <span><strong>{file.fileName}</strong><small>{kind} · {file.language.toUpperCase()}{file.revision ? ` · ${c('Revisión', 'Revision')} ${file.revision}` : ''}</small></span>
            </label>;
          })}
        </fieldset>
        : <p>{c('No hay archivos aprobados y vigentes para esta solicitud todavía.', 'There are no approved, current files for this application yet.')}</p>}
    {error && !loading && files.length > 0 && <p role="status" className="field-hint">{error}</p>}
    <div className="button-row"><Button variant="secondary" disabled={loading || busy || selectedIds.length === 0} onClick={() => void download()}>{busy ? c('Preparando ZIP…', 'Preparing ZIP…') : c('Descargar seleccionados', 'Download selected files')}</Button></div>
  </Card>;
}
