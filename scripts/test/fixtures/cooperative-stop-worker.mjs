import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { attachGracefulShutdown, resolveLauncherStopFile } from '../../../apps/api/src/graceful-shutdown.js';

const marker = process.env.CAREER_TEST_CLOSED;
const closingMarker = process.env.CAREER_TEST_CLOSING;
const closeDelayMs = Number(process.env.CAREER_TEST_CLOSE_DELAY_MS || 0);
const stopFile = process.argv.includes('--ignore-stop')
  ? null
  : resolveLauncherStopFile(process.env.DATA_LOCAL_PATH, process.env.CAREER_STOP_FILE, process.platform);
const server = createServer((_request, response) => { response.writeHead(200); response.end('ok'); });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
console.log(JSON.stringify({ port: server.address().port }));

const app = {
  close: async () => {
    await writeFile(closingMarker, 'closing');
    if (closeDelayMs) await delay(closeDelayMs);
    return new Promise((resolve, reject) => server.close(async (error) => {
      if (error) { reject(error); return; }
      try { await writeFile(marker, 'closed'); resolve(); } catch (writeError) { reject(writeError); }
    }));
  },
};
const pool = { end: async () => {} };
attachGracefulShutdown(app, pool, { stopFile });
