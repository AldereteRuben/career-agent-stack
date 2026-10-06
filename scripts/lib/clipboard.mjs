/**
 * Picks the command-line clipboard tools for this system. `has` tells whether an executable is installed.
 * Wayland sessions prefer wl-clipboard; xclip also serves X11 and XWayland. Returns null when none is available.
 */
export function clipboardTools({ platform = process.platform, env = process.env, has }) {
  if (platform === 'darwin') return { copy: ['pbcopy', []], paste: ['pbpaste', []] };
  if (env.WAYLAND_DISPLAY && has('wl-copy')) return { copy: ['wl-copy', []], paste: ['wl-paste', ['-n']] };
  if (has('xclip')) return { copy: ['xclip', ['-selection', 'clipboard']], paste: ['xclip', ['-selection', 'clipboard', '-o']] };
  return null;
}

/** Bilingual advice for a system without clipboard tools: where the token is and what to install. */
export function missingClipboardAdvice({ platform = process.platform, env = process.env, tokenPath }) {
  const open = { es: `Abre el archivo ${tokenPath}, copia su contenido y pégalo en la pantalla de acceso.`, en: `Open ${tokenPath}, copy its contents and paste them on the sign-in screen.` };
  if (platform !== 'linux') return open;
  const tool = env.WAYLAND_DISPLAY ? 'wl-clipboard' : 'xclip';
  return {
    es: `${open.es} Para copiar automáticamente instala ${tool} (por ejemplo: sudo apt install ${tool}).`,
    en: `${open.en} To copy automatically, install ${tool} (for example: sudo apt install ${tool}).`,
  };
}
