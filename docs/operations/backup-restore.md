# Backup and isolated restore · Copia de seguridad y restauración aislada

## From Settings / Desde Ajustes

Choose **Settings and privacy → Create backup**. Wait for verification, then download **both** the archive and recovery key. The checksum download is optional. The app uses the same verified backup command with the running API's configuration; it does not read another installation's `.env`.

En **Ajustes y privacidad → Crear copia de seguridad**, espera la comprobación y descarga **la copia y la clave**. El archivo de comprobación es opcional. Se utiliza la configuración de la instalación abierta.

Download before creating another backup or restarting the API. Completed originals remain in `data/backups/<id>/`, with the separate key under `keys/`. Old copies are not deleted automatically. Failed attempts are removed. One backup can run at a time, with a five-minute limit; leave and return to Settings to see its progress. Downloads require the local session and are never cached. PostgreSQL client tools are still required. Restoring still uses the terminal instructions below.

Descarga antes de crear otra copia o reiniciar la API. Los originales quedan en `data/backups/<id>/`, con la clave en `keys/`; gestiona las copias antiguas desde esa carpeta. Las copias fallidas se eliminan. Puedes salir de Ajustes y volver mientras se prepara. La restauración sigue requiriendo la terminal.

## Backup from a terminal

```sh
pnpm run backup                      # → backups/career-backup-<UTC>.tar (+ .sha256) and backups/career-key-<fingerprint>.json
pnpm run backup --out-dir /Volumes/Encrypted/career --key-dir ~/Private/keys
```

On macOS you can also double-click `Backup Career Agent Stack.command`.

The command reports success only after it re-opens the written archive and verifies all of it.

| What | How |
| --- | --- |
| Database | `pg_dump --format=custom` of one `REPEATABLE READ` snapshot (`pg_export_snapshot`). Row counts, the document list and applied migrations come from the same snapshot. |
| Documents | Every PDF referenced by `document_versions` is hashed while it is copied and must match the snapshot's SHA-256. A missing or changed file fails the backup; no incomplete copy is written. Unreferenced files are not included. |
| Concurrency guard | An advisory lock allows one backup at a time. `LOCK TABLE document_versions IN SHARE MODE` is taken before the snapshot and held until every file is copied. The app keeps running: document creation or approval waits a few seconds. After 10 s the backup stops with "busy, retry". |
| Manifest | `manifest.json` records versions, row counts, migrations, and the size and SHA-256 of each entry. `manifest.hmac` is an HMAC-SHA-256 keyed with a value derived from `APP_ENCRYPTION_KEY`, so tampering is detected even if someone recomputes the checksums. |
| Excluded | `.env`, the database password, `APP_SESSION_SECRET`, sign-in tokens, logs, process records and browser state. `APP_ENCRYPTION_KEY` goes only into the separate key file (0600). That file is reused when the key is the same. |
| Permissions | The folders are 0700. The archive, `.sha256` and key file are 0600. |

**The archive is not encrypted.** Keep it on an encrypted drive. Keep the key file **separately**, for example in a password manager. Without the key file the backup cannot be restored.

Requirements: `pg_dump`/`pg_restore` at the server's major version or newer (`brew install libpq`, or set `CAREER_PG_BIN=/path/bin`).

## Verify (no side effects)

```sh
pnpm run restore --verify-only --archive backups/career-backup-….tar --key-file ~/Private/keys/career-key-….json
```

This checks the tar structure, every hash, the manifest signature, the dump table of contents and schema compatibility. Without `--key-file` it checks integrity only, not authenticity.

## Isolated restore

```sh
CAREER_RESTORE_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres \
pnpm run restore --archive <backup.tar> --key-file <career-key.json> --target ~/career-restore-2026-10-03
```

- `CAREER_RESTORE_ADMIN_URL` is an admin connection that can `CREATE DATABASE` (loopback only). It is read from the environment, so the password never appears in the process arguments.
- The new database's owner is the role in `.env`'s `DATABASE_URL`, or in `CAREER_RESTORE_APP_URL`.
- Everything is verified **before** anything is created. The command refuses:
  - an existing database name, or the live database name
  - an existing target folder, or one inside the project or its data
  - a key that doesn't match
  - any tampered, truncated, traversal or symlink entry
  - a schema newer than this checkout
- It then creates a **new** database and a **new** folder containing `.env` (0600), `data/files`, `data/setup-token` and `restore-report.json`.
- The new `.env` gets a fresh `APP_SESSION_SECRET` and keeps the original `APP_ENCRYPTION_KEY`. Writes, automation, e-mail and AI are off, and the ports default to 3100/3101.
- Restored data is sanitised:
  - boards: `enabled=false` and `permission_status=UNKNOWN`
  - source policy reviews: `UNKNOWN`
  - search profiles: disabled
- It then verifies row counts and document hashes. Applications in `IN_PROGRESS`/`UNKNOWN` are reported for manual reconciliation; nothing is resubmitted.
- If restore fails, it removes only the database and folder that this run created. The live installation is never written to.

To open the restored copy, use another checkout of the same version:

```sh
git worktree add ../career-restored && cd ../career-restored && pnpm install --frozen-lockfile
CAREER_ENV_FILE="$HOME/career-restore-2026-10-03/.env" pnpm start --copy-token
```

## Tests

```sh
pnpm run test:backup     # unit tests (archive guards, manifest, HMAC)
CAREER_BACKUP_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:integration
```

The integration tests create only disposable `career_bkt_*` databases and a role with fictional data, then drop them.

## Resumen (español)

- `pnpm run backup` crea una copia verificada: base de datos, PDFs y manifiesto firmado. La clave se guarda en un archivo aparte; guárdalo fuera de las copias. La copia no está cifrada.
- `pnpm run restore --verify-only …` comprueba la copia sin crear nada.
- La restauración crea siempre una base de datos y una carpeta **nuevas** y nunca toca la instalación activa.
- La copia restaurada tiene un secreto de sesión nuevo, los tableros desactivados y los permisos en UNKNOWN. Ábrela con `CAREER_ENV_FILE=<carpeta>/.env pnpm start`, desde otra copia del código.
