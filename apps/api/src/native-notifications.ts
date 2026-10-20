import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import notifier from 'node-notifier';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const actionLabel = (language: 'en' | 'es') => language === 'es' ? 'Abrir ofertas' : 'Open jobs';

export type NativeAlert = { title: string; message: string; language: 'en' | 'es' };
export type NotificationResult = 'ACCEPTED' | 'UNAVAILABLE';

function notificationClient() {
  if (process.platform === 'darwin') return new notifier.NotificationCenter({ withFallback: false });
  return null;
}

function localJobsUrl(): string {
  const url = new URL('/jobs?view=new', config.WEB_ORIGIN);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('LOCAL_UI_UNAVAILABLE');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_UI_UNAVAILABLE');
  return url.toString();
}

async function openJobs(): Promise<void> {
  const url = localJobsUrl();
  if (process.platform === 'darwin') await execFileAsync('open', [url], { windowsHide: true });
  else if (process.platform === 'win32') await execFileAsync('explorer.exe', [url], { windowsHide: true });
  else if (process.platform === 'linux') await execFileAsync('xdg-open', [url], { windowsHide: true });
}

/** Sends privacy-safe OS notifications. User action opens only the configured loopback UI. */
export async function sendNativeAlert(alert: NativeAlert): Promise<NotificationResult> {
  // node-notifier's Windows toaster waits for a user activation and cannot be
  // bounded by its timeout option. Do not hold the opt-out lock indefinitely.
  if (process.platform === 'win32') return 'UNAVAILABLE';
  if (process.platform === 'linux') {
    const action = actionLabel(alert.language);
    // Keep the worker lease and workspace opt-out lock bounded if the desktop session is stuck.
    const { stdout } = await execFileAsync('notify-send', ['--app-name=Career Stack', `--action=open=${action}`, alert.title, alert.message], { windowsHide: true, timeout: 30_000 });
    if (stdout.trim() === 'open') void openJobs().catch(() => {});
    return 'ACCEPTED';
  }
  const client = notificationClient();
  if (!client) return 'UNAVAILABLE';
  return new Promise((resolve, reject) => {
    client.notify({ title: alert.title, message: alert.message, actions: [actionLabel(alert.language)], wait: true, timeout: 30 }, (error, _response, metadata) => {
      if (error) { reject(error); return; }
      const activation = metadata?.activationType;
      if (activation === 'actionClicked' || activation === 'contentsClicked') {
        void openJobs().catch(() => {});
      }
      resolve('ACCEPTED');
    });
  });
}

export async function checkNativeNotificationAvailability(): Promise<boolean> {
  if (process.platform === 'linux') {
    try { await execFileAsync('which', ['notify-send'], { windowsHide: true, timeout: 5_000 }); return true; }
    catch { return false; }
  }
  if (process.platform === 'win32') return false;
  if (!notificationClient()) return false;
  return true;
}
