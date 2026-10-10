# Backup and isolated restore · Copia de seguridad y restauración aislada

## From Settings / Desde Ajustes

Choose **Settings and privacy → Create backup**. Wait for verification, then download **both** the archive and recovery key. The checksum download is optional. The app uses the same verified backup command with the running API's configuration; it does not read another installation's `.env`.

En **Ajustes y privacidad → Crear copia de seguridad**, espera la comprobación y descarga **la copia y la clave**. El archivo de comprobación es opcional. Se utiliza la configuración de la instalación abierta.

Download before creating another backup or restarting the API. Completed originals remain in `data/backups/<id>/`, with the separate key under `keys/`. Old copies are not deleted automatically. Failed attempts are removed. One backup can run at a time, with a five-minute limit; leave and return to Settings to see its progress. Downloads require the local session and are never cached. PostgreSQL client tools are still required. Restoring still uses the terminal instructions below.

Descarga antes de crear otra copia o reiniciar la API. Los originales quedan en `data/backups/<id>/`, con la clave en `keys/`; gestiona las copias antiguas desde esa carpeta. Las copias fallidas se eliminan. Puedes salir de Ajustes y volver mientras se prepara. La restauración sigue requiriendo la terminal.

## Backup from a terminal

```sh
pnpm run backup                      # → backups/career-backup-<UTC>.tar.age (+ .sha256) and backups/career-key-<fingerprint>.json
pnpm run backup --out-dir /Volumes/Encrypted/career --key-dir ~/Private/keys
```

On macOS you can also double-click `Backup Career Agent Stack.command`.

The command reports success only after it decrypts the written archive again and verifies all of it.

| What | How |
| --- | --- |
| Database | `pg_dump --format=custom` of one `REPEATABLE READ` snapshot (`pg_export_snapshot`). Row counts, the document list and applied migrations come from the same snapshot. |
| Documents | Every PDF referenced by `document_versions` is hashed while it is copied and must match the snapshot's SHA-256. A missing or changed file fails the backup; no incomplete copy is written. Unreferenced files are not included. |
| Concurrency guard | An advisory lock allows one backup at a time. `LOCK TABLE document_versions IN SHARE MODE` is taken before the snapshot and held until every file is copied. The app keeps running: document creation or approval waits a few seconds. After 10 s the backup stops with "busy, retry". |
| Encryption | The whole archive is encrypted with the [age](https://age-encryption.org/v1) format (X25519, ChaCha20-Poly1305 in 64 KiB chunks) for an identity derived from `APP_ENCRYPTION_KEY` ([ADR 019](../decisions/019-encrypted-backups.md)). Inside, it is the same tar as before encryption, so every check below still runs after decryption. Any change to the encrypted file, a truncation or a wrong key fails decryption. |
| Manifest | `manifest.json` records versions, row counts, migrations, and the size and SHA-256 of each entry. `manifest.hmac` is an HMAC-SHA-256 keyed with a value derived from `APP_ENCRYPTION_KEY`, so tampering is detected even if someone recomputes the checksums. |
| Excluded | `.env`, the database password, `APP_SESSION_SECRET`, sign-in tokens, logs, process records and browser state. `APP_ENCRYPTION_KEY` goes only into the separate key file (0600). That file is reused when the key is the same. |
| Permissions | The folders are 0700. The archive, `.sha256` and key file are 0600. The plain tar only exists in a private temporary folder (0700; on Windows, a folder restricted to the current user by ACL), which is removed afterwards, also on failure. |

**The archive is encrypted; the key file is what opens it.** Keep the key file **separately** from the backups, for example in a password manager: anyone with both can read your data, and without the key file nobody can read or restore the backup, including you. There is no way to recover a lost key file.

Backups made before encryption (plain `.tar`) were never protected. They can still be restored with `--allow-unencrypted`, after a warning; make a new backup and delete the old ones.

### Decrypt without the app

The key file (format version 2) also contains the age identity, so the official [`age`](https://github.com/FiloSottile/age) tool can decrypt a backup even without this app. The output is the plain tar with your personal data: write it only to a private folder and delete it when done.

```sh
node -e 'process.stdout.write(require(process.argv[1]).ageIdentity + "\n")' ~/Private/keys/career-key-….json > identity.txt
age --decrypt --identity identity.txt --output career-backup.tar backups/career-backup-….tar.age
rm identity.txt
```

Key files written before encryption (version 1) do not contain `ageIdentity`; the app derives it from `APP_ENCRYPTION_KEY` and restores those backups normally.

Requirements: `pg_dump`/`pg_restore` at the server's major version or newer (`brew install libpq`, or set `CAREER_PG_BIN=/path/bin`).

## Verify (no side effects)

```sh
pnpm run restore --verify-only --archive backups/career-backup-….tar.age --key-file ~/Private/keys/career-key-….json
```

This decrypts the backup into a private temporary folder and checks the tar structure, every hash, the manifest signature, the dump table of contents and schema compatibility. An encrypted backup needs `--key-file`. For an old unencrypted backup, add `--allow-unencrypted`; without `--key-file` it then checks integrity only, not authenticity.

## Isolated restore

```sh
CAREER_RESTORE_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres \
pnpm run restore --archive <backup.tar.age> --key-file <career-key.json> --target ~/career-restore-2026-10-03
```

- `CAREER_RESTORE_ADMIN_URL` is an admin connection that can `CREATE DATABASE` (loopback only). It is read from the environment, so the password never appears in the process arguments.
- The new database's owner is the role in `.env`'s `DATABASE_URL`, or in `CAREER_RESTORE_APP_URL`.
- Everything is verified **before** anything is created. The command refuses:
  - an existing database name, or the live database name
  - an existing target folder, or one inside the project or its data
  - a key file that cannot decrypt the backup, or a key that doesn't match
  - an unencrypted backup (made before encryption), unless `--allow-unencrypted` is given
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
pnpm run test:backup-crypto   # encryption: round trip, wrong key, tampering, private temporary folder, age CLI when installed
CAREER_BACKUP_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:integration
```

The integration tests create only disposable `career_bkt_*` databases and a role with fictional data, then drop them.

## Resumen (español)

- `pnpm run backup` crea una copia verificada y **cifrada** con age (`.tar.age`): base de datos, PDFs y manifiesto firmado. Se cifra con una identidad derivada de `APP_ENCRYPTION_KEY`, que se guarda en un archivo de clave aparte. **Guarda la clave lejos de las copias:** quien tenga las dos puede leer tus datos, y sin la clave nadie puede leer ni restaurar la copia, tampoco tú. Una clave perdida no se puede recuperar.
- Las copias anteriores al cifrado (`.tar`) nunca estuvieron protegidas. Se restauran con `--allow-unencrypted`, tras un aviso; haz una copia nueva y borra las antiguas.
- El archivo de clave incluye la identidad age, así que la herramienta oficial `age` puede descifrar una copia sin la app (ver «Decrypt without the app»).
- `pnpm run restore --verify-only …` descifra la copia en una carpeta temporal privada y la comprueba sin crear nada.
- La restauración crea siempre una base de datos y una carpeta **nuevas** y nunca toca la instalación activa.
- La copia restaurada tiene un secreto de sesión nuevo, los tableros desactivados y los permisos en UNKNOWN. Ábrela con `CAREER_ENV_FILE=<carpeta>/.env pnpm start`, desde otra copia del código.
