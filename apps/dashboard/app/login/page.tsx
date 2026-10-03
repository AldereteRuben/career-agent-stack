'use client';

import { Brand } from '@/components/brand';
import { RELEASE_VERSION } from '@career/domain';
import { LanguageToggle, localizedError, useLocale } from '@/lib/i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Icon, Notice } from '@/components/ui';
import { copy } from '@/lib/labels';

export default function LoginPage() {
  const { locale } = useLocale(); const c = copy(locale);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const router = useRouter();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ setupToken: token.trim() }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(localizedError(result.error ?? 'UNKNOWN', locale));
      setToken(''); router.replace('/');
    } catch (err) { setError(err instanceof Error ? err.message : c('No pudimos abrir tu espacio. Inténtalo de nuevo.', 'We could not open your workspace. Try again.')); }
    finally { setBusy(false); }
  };
  return <main className="login-screen">
    <div className="login-decoration login-decoration-one"/><div className="login-decoration login-decoration-two"/>
    <section className="login-card">
      <div className="login-language"><LanguageToggle/></div>
      <a href="/" className="brand login-brand"><Brand/></a>
      <h1>{c('Entra en tu espacio', 'Open your workspace')}</h1>
      <p>{c('Tu búsqueda de empleo se guarda en este equipo. Usa un código de acceso para abrirla.', 'Your job search is saved on this device. Use a sign-in code to open it.')}</p>
      <ol className="login-steps">
        <li>{c('Abre la carpeta donde instalaste Career Stack.', 'Open the folder where you installed Career Stack.')}</li>
        <li>{c('Abre el archivo', 'Open the file')} <code>data/setup-token</code> {c('con un editor de texto y copia su contenido.', 'with a text editor and copy its contents.')}</li>
        <li>{c('Pega el código aquí para entrar.', 'Paste the code here to sign in.')}</li>
      </ol>
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={submit} className="login-form" aria-busy={busy}>
        <Field label={c('Código de acceso', 'Sign-in code')} disabled={!ready || busy} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required placeholder={c('Pega el código aquí', 'Paste the code here')}/>
        <Button type="submit" disabled={!ready || busy || !token.trim()}>{busy ? c('Comprobando…', 'Checking…') : c('Entrar en mi espacio', 'Open my workspace')} <Icon name="arrow" size={15}/></Button>
      </form>
      <details className="login-help" open={Boolean(error) || undefined}><summary>{c('¿No tienes código o ya no funciona?', 'No code, or it no longer works?')}</summary>
        <p>{c('Abre una terminal en la carpeta de Career Stack y ejecuta:', 'Open a terminal in the Career Stack folder and run:')} <code>pnpm run reset:session</code>.</p>
        <p>{c('Después abre data/setup-token y copia el código nuevo. Tus datos se conservan.', 'Then open data/setup-token and copy the new code. Your data is kept.')}</p>
        <p>{c('El código se usa una sola vez. Tu sesión permanece abierta durante 14 días.', 'The code can be used once. Your session stays open for 14 days.')}</p>
      </details>
      <details className="login-help"><summary>{c('Otras formas de obtener el código', 'Other ways to get the code')}</summary>
        <p>{c('Desde una terminal en la carpeta de instalación:', 'From a terminal in the installation folder:')} <code>pnpm start --copy-token</code>. {c('Si la copia automática no está disponible, abre data/setup-token y copia su contenido.', 'If automatic copying is unavailable, open data/setup-token and copy its contents.')}</p>
        <p><strong>macOS:</strong> {c('también puedes abrir Start Career Agent Stack.command. Para crear un código nuevo, abre Recover Career Agent Stack.command.', 'you can also open Start Career Agent Stack.command. To create a new code, open Recover Career Agent Stack.command.')}</p>
      </details>
      <div className="login-footer"><span><span className="local-pulse"/> {c('Local y privado', 'Local and private')}</span><span>{RELEASE_VERSION}</span></div>
    </section>
  </main>;
}
