'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Button, Notice } from '@/components/ui';

type OllamaStatus = {
  enabled: boolean; available: boolean; privacy: 'NOT_VERIFIABLE' | 'USER_CONFIRMED' | 'NOT_CONFIGURED';
  models: Array<{ name: string; size?: number }>;
  connection: { id: string; model: string | null; connected: boolean; cloudDisabledConfirmed: boolean; revision: number } | null;
};

export function OllamaConnectionPanel() {
  const { locale } = useLocale();
  const es = locale === 'es';
  const c = (spanish: string, english: string) => es ? spanish : english;
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [model, setModel] = useState('');
  const [confirmCloudDisabled, setConfirmCloudDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<OllamaStatus>('/ai/ollama', { signal });
      if (signal?.aborted) return;
      setStatus(next);
      setModel(current => (next.connection?.model ?? current) || next.models[0]?.name || '');
      setError(false);
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, []);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);

  const connect = async () => {
    setBusy(true); setError(false);
    try { await api('/ai/ollama/connect', { method: 'POST', body: JSON.stringify({ model, confirmCloudDisabled }) }); await refresh(); setConfirmCloudDisabled(false); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!status?.connection) return;
    setBusy(true);
    try { await api(`/ai/connections/${encodeURIComponent(status.connection.id)}/disconnect`, { method: 'POST' }); await refresh(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };

  return <section className="card" aria-labelledby="ollama-connection-heading">
    <h2 id="ollama-connection-heading">{c('IA local con Ollama', 'Local AI with Ollama')}</h2>
    <p>{c('Career Stack solo contacta la dirección local de Ollama configurada por quien administra la app. No acepta una dirección enviada por una oferta ni descarga modelos.', 'Career Stack contacts only the local Ollama address configured by the app administrator. A job listing cannot supply an address, and the app does not download models.')}</p>
    {error && <Notice tone="error">{c('No pudimos consultar Ollama o guardar el cambio. Comprueba que Ollama esté iniciado y vuelve a intentarlo.', 'Could not reach Ollama or save the change. Check that Ollama is running and try again.')}</Notice>}
    {!status ? <p role="status">{c('Comprobando Ollama…', 'Checking Ollama…')}</p> : <>
      {!status.enabled && <Notice tone="warning">{c('La ayuda con IA está desactivada en esta instalación.', 'AI assistance is disabled for this installation.')}</Notice>}
      {status.enabled && !status.available && <Notice tone="warning">{c('No encontramos Ollama en la dirección local configurada. Inícialo en este equipo y vuelve a comprobar.', 'Ollama was not found at the configured local address. Start it on this computer and check again.')}</Notice>}
      {status.available && status.models.length === 0 && <Notice tone="warning">{c('No hay modelos locales instalados que puedan usarse aquí. Descarga uno directamente con Ollama y vuelve a comprobar.', 'No compatible local models are installed. Download a model directly with Ollama and check again.')}</Notice>}
      {status.connection?.connected ? <>
        <p><strong>{c('Modelo conectado:', 'Connected model:')}</strong> {status.connection.model}</p>
        <p>{c('La desactivación de funciones en la nube está confirmada por ti; Career Stack no puede verificar la configuración del proceso de Ollama.', 'You confirmed cloud features are disabled; Career Stack cannot verify the Ollama server process configuration.')}</p>
        <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>{c('Desconectar Ollama', 'Disconnect Ollama')}</Button>
      </> : status.available && status.models.length > 0 && <>
        <label htmlFor="ollama-model">{c('Modelo local', 'Local model')}</label>
        <select id="ollama-model" value={model} onChange={event => setModel(event.target.value)}>
          {status.models.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <div className="notice notice-warning">
          <p>{c('Antes de conectar, configura Ollama con la nube desactivada (OLLAMA_NO_CLOUD=1 o disable_ollama_cloud=true en server.json) y reinicia su servidor. Career Stack no puede comprobar este ajuste automáticamente.', 'Before connecting, configure Ollama with cloud features disabled (OLLAMA_NO_CLOUD=1 or disable_ollama_cloud=true in server.json), then restart its server. Career Stack cannot check this setting automatically.')}</p>
          <label><input type="checkbox" checked={confirmCloudDisabled} onChange={event => setConfirmCloudDisabled(event.target.checked)}/> {c('Confirmo que desactivé las funciones en la nube en el servidor de Ollama.', 'I confirm that I disabled cloud features in the Ollama server.')}</label>
        </div>
        <p>{c('La calidad y velocidad dependen del modelo y del equipo. No garantizamos que un modelo concreto funcione bien con 8 GB de memoria.', 'Quality and speed depend on the model and computer. We do not guarantee any particular model will perform well with 8 GB of memory.')}</p>
        <Button disabled={busy || !confirmCloudDisabled || !model} onClick={() => void connect()}>{busy ? c('Conectando…', 'Connecting…') : c('Conectar este modelo', 'Connect this model')}</Button>
      </>}
      <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{c('Volver a comprobar', 'Check again')}</Button>
    </>}
  </section>;
}
