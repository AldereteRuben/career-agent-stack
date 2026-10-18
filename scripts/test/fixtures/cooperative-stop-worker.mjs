import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { attachGracefulShutdown, resolveLauncherStopFile } from '../../../apps/api/src/graceful-shutdown.js';

const marker = process.env.CAREER_TEST_CLOSED;
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
  close: () => new Promise((resolve, reject) => server.close(async (error) => {
    if (error) { reject(error); return; }
    try { await writeFile(marker, 'closed'); resolve(); } catch (writeError) { reject(writeError); }
  })),
};
const pool = { end: async () => {} };
attachGracefulShutdown(app, pool, { stopFile });
