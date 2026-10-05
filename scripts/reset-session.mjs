// Recovery when you are signed out and the one-time sign-in token was already used.
// Writes a new single-use token to data/setup-token. It does not delete or change any workspace data
// and does not restart the API (the API reads the token file at sign-in time).
// Limits, stated honestly: browser sessions already signed in stay valid until they expire (14 days);
// this command does not revoke them. Rotating APP_SESSION_SECRET in .env (and restarting the API) does.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { localDataPath, ok, projectRoot, readLocalEnv, say } from './lib/local-env.mjs';

const target = resolve(localDataPath(await readLocalEnv()), 'setup-token');
const shown = relative(projectRoot, target).startsWith('..') ? target : relative(projectRoot, target);
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
await writeFile(target, randomBytes(24).toString('base64url'), { mode: 0o600 });
await chmod(target, 0o600);
ok(`Nuevo token de acceso de un solo uso guardado en ${shown} (no se muestra).`, `New single-use sign-in token saved to ${shown} (not shown).`);
say('  Cópialo con: pnpm start --copy-token  y pégalo en la pantalla de acceso (o abre el archivo y copia su contenido).', 'Copy it with: pnpm start --copy-token  and paste it on the sign-in screen (or open the file and copy its contents).');
say('  Tus datos no cambian. Las sesiones ya abiertas siguen válidas hasta caducar.', 'Your data is unchanged. Sessions already signed in stay valid until they expire.');
