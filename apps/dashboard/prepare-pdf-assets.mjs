import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const destination = join(dirname(fileURLToPath(import.meta.url)), 'public', 'pdf-assets', version);
mkdirSync(destination, { recursive: true });
for (const file of ['build/pdf.worker.min.mjs', 'standard_fonts', 'LICENSE']) {
  cpSync(join(root, file), join(destination, file === 'build/pdf.worker.min.mjs' ? 'pdf.worker.min.mjs' : file), { recursive: true });
}
