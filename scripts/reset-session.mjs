// Recovery when you are signed out and the one-time sign-in token was already used.
// Writes a new single-use token to data/setup-token. It does not delete or change any workspace data
// and does not restart the API (the API reads the token file at sign-in time).
// Limits, stated honestly: browser sessions already signed in stay valid until they expire (14 days);
// this command does not revoke them. Rotating APP_SESSION_SECRET in .env (and restarting the API) does.
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { envPath, localDataPath, ok, projectRoot, readLocalEnv, say, writePrivateFileAtomic } from './lib/local-env.mjs';
import { ensurePrivateDir, ensurePrivateFile } from './lib/private-files.mjs';

try { await access(envPath); await ensurePrivateFile(envPath, { create: false }); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const target = resolve(localDataPath(await readLocalEnv()), 'setup-token');
const shown = relative(projectRoot, target).startsWith('..') ? target : relative(projectRoot, target);
await ensurePrivateDir(dirname(target));
await writePrivateFileAtomic(target, randomBytes(24).toString('base64url'));
ok(`Nuevo token de acceso de un solo uso guardado en ${shown} (no se muestra).`, `New single-use sign-in token saved to ${shown} (not shown).`);
say('  Cópialo con: pnpm start --copy-token  y pégalo en la pantalla de acceso (o abre el archivo y copia su contenido).', 'Copy it with: pnpm start --copy-token  and paste it on the sign-in screen (or open the file and copy its contents).');
say('  Tus datos no cambian. Las sesiones ya abiertas siguen válidas hasta caducar.', 'Your data is unchanged. Sessions already signed in stay valid until they expire.');
