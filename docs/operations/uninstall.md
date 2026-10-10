# Uninstall and delete everything · Desinstalar y borrarlo todo

`pnpm run uninstall` removes this installation: its PostgreSQL database and role, its data and generated documents, optionally its backups, and finally `.env`. It is designed so that it cannot remove someone else's data: it checks ownership before dropping anything, and it shows exactly what it would delete before it does. Decision record: [ADR 020](../decisions/020-deletion-and-uninstall.md).

`pnpm run uninstall` elimina esta instalación: su base de datos y su usuario de PostgreSQL, sus datos y documentos generados, opcionalmente sus copias de seguridad y, al final, `.env`. Está pensado para que no pueda borrar datos ajenos: comprueba de quién es cada cosa antes de borrarla y muestra exactamente qué borrará antes de hacerlo. Decisión: [ADR 020](../decisions/020-deletion-and-uninstall.md).

## English

### 1. Before you start

- **Make a backup and keep it, with its key file, outside this folder** if you might want your data again ([backup guide](backup-restore.md)). Uninstalling cannot be undone.
- **Stop the app:** `pnpm run stop`. PostgreSQL may keep running; the script needs it.
- Have the PostgreSQL **administrator** connection that bootstrap used. The script uses `CAREER_ADMIN_DATABASE_URL`, or, if it is not set, `postgresql://<your user>@127.0.0.1:5432/postgres` (the Homebrew default). With Docker it is usually `postgresql://career:career@127.0.0.1:5432/postgres`.

### 2. See what would be deleted

```sh
pnpm run uninstall
```

This changes nothing. It lists the database, the role, the folders with their sizes, and what is kept, and it ends with the exact command to delete, including this installation's id (`CAREER_INSTALL_ID` in `.env`).

### 3. Delete

```sh
pnpm run uninstall --confirm <id>                     # keeps backups/
pnpm run uninstall --confirm <id> --include-backups   # also deletes backups/ and its key files
```

The order is: database, role, data and documents (including backups made from Settings in `data/backups/`), `backups/` if you asked, `.env`, and a temporary progress file. When it finishes, delete the project folder yourself: the script does not delete the code or `node_modules`.

**If it stops halfway**, fix what it reports and run the same command again. A private progress file (`.uninstall-progress.json`) remembers what was already deleted, so it resumes, even if `.env` is already gone. Without `.env`, it checks that nothing on the server still carries this installation's mark before it finishes, so `CAREER_ADMIN_DATABASE_URL` must point at the same server the installation used.

### What it refuses, and why

| Message | Meaning |
|---|---|
| The app is still running | The API or web app is running. Run `pnpm run stop` (or `pnpm run stop --forget` for stale records). |
| `--confirm` does not match | The id is not this installation's. Check that you are in the right folder. |
| The database or role does not carry this installation's mark | Bootstrap marks what it creates. If the mark is missing or different, the database may belong to someone else, so nothing is deleted. |
| It cannot be proven that the database belongs to this installation | You gave bootstrap your own database (`CAREER_DATABASE_URL`), or the installation is older than installation ids. Remove the database by hand (below), then run again with `--skip-database`. |
| The role still owns other databases | Usually restored installations that use this installation's role. Uninstall those first (next section), then run the command again. |
| A path will not be deleted | A data folder is outside the installation folder, overlaps a reserved folder (`.git`, `node_modules`, `apps`, `packages`, `scripts`, `docs`, `.github`, `backups`) or goes through a symbolic link. It is left in place and listed; delete it yourself if appropriate. |

### Restored installations

A restored installation has its own folder, `.env` and database, and uses the original installation's PostgreSQL role. Uninstall it from this checkout:

```sh
CAREER_ENV_FILE=/path/to/restored/.env pnpm run uninstall
CAREER_ENV_FILE=/path/to/restored/.env pnpm run uninstall --confirm <CAREER_RESTORE_ID>
```

It drops only the restored database and deletes that folder. It never drops the role, which the original installation still uses. Restores made before this version have no `CAREER_RESTORE_ID`: remove those by hand.

### Removing things by hand

Use these steps only for what the script refused or does not cover. Read the names from that installation's `DATABASE_URL` (`postgresql://ROLE:…@host:port/DATABASE`), and never paste the password anywhere.

```sh
# Check what the role still owns before dropping it (connect as the administrator)
psql "postgresql://ADMIN@127.0.0.1:5432/postgres" -c "select datname from pg_database where datdba = 'ROLE'::regrole"
psql "postgresql://ADMIN@127.0.0.1:5432/postgres" -c 'drop database "DATABASE"'
psql "postgresql://ADMIN@127.0.0.1:5432/postgres" -c 'drop role "ROLE"'    # only if no other database uses it
```

Do not use `DROP OWNED`: it would also delete that role's objects in other databases. Then delete `data/` (or the folders in `DATA_LOCAL_PATH` and `FILES_LOCAL_PATH`), `backups/` if you want, and `.env`.

**Docker:** the database server keeps its data in the `career-postgres` volume, which can hold other installations' databases (restored ones, for example). Remove the volume only once no other database is left in it:

```sh
docker compose exec postgres psql -U career -d postgres -Atc "select datname from pg_database where not datistemplate and datname <> 'postgres'"
docker compose down -v    # only if the list above is empty
```

### What cannot be deleted from here

- Backups and files you downloaded or copied elsewhere.
- Applications and documents already sent to employers.
- The history kept by an AI provider (Codex or Claude) and its sign-in on this computer.
- The PostgreSQL server, the Playwright browsers and the project's code: delete them yourself if you no longer need them.

## Español

### 1. Antes de empezar

- **Haz una copia de seguridad y guárdala, con su archivo de clave, fuera de esta carpeta** si puede que quieras recuperar tus datos ([guía de copias](backup-restore.md)). Desinstalar no se puede deshacer.
- **Detén la app:** `pnpm run stop`. PostgreSQL puede seguir en marcha; el script lo necesita.
- Ten a mano la conexión de **administrador** de PostgreSQL que usó bootstrap. El script usa `CAREER_ADMIN_DATABASE_URL` o, si no está definida, `postgresql://<tu usuario>@127.0.0.1:5432/postgres` (lo habitual con Homebrew). Con Docker suele ser `postgresql://career:career@127.0.0.1:5432/postgres`.

### 2. Ver qué se borraría

```sh
pnpm run uninstall
```

No cambia nada. Muestra la base de datos, el usuario, las carpetas con su tamaño y lo que se conserva, y termina con el comando exacto para borrar, que incluye el id de esta instalación (`CAREER_INSTALL_ID` en `.env`).

### 3. Borrar

```sh
pnpm run uninstall --confirm <id>                     # conserva backups/
pnpm run uninstall --confirm <id> --include-backups   # borra también backups/ y sus archivos de clave
```

El orden es: base de datos, usuario, datos y documentos (incluidas las copias hechas desde Ajustes en `data/backups/`), `backups/` si lo pediste, `.env` y un archivo temporal de progreso. Al terminar, borra tú la carpeta del proyecto: el script no borra el código ni `node_modules`.

**Si se detiene a medias**, corrige lo que indique y ejecuta otra vez el mismo comando. Un archivo privado de progreso (`.uninstall-progress.json`) recuerda lo que ya se borró, así que retoma desde ahí, aunque `.env` ya no exista. Sin `.env`, antes de terminar comprueba que nada en el servidor lleve todavía la marca de esta instalación, así que `CAREER_ADMIN_DATABASE_URL` debe apuntar al mismo servidor que usaba la instalación.

### Qué rechaza y por qué

| Mensaje | Significado |
|---|---|
| La app sigue en marcha | La API o la app web están en marcha. Ejecuta `pnpm run stop` (o `pnpm run stop --forget` si los registros son antiguos). |
| `--confirm` no coincide | El id no es el de esta instalación. Comprueba que estás en la carpeta correcta. |
| La base o el usuario no llevan la marca de esta instalación | Bootstrap marca lo que crea. Si falta la marca o es otra, la base puede ser de otra persona o instalación, así que no se borra nada. |
| No se puede comprobar que la base sea de esta instalación | Diste a bootstrap tu propia base (`CAREER_DATABASE_URL`) o la instalación es anterior a los ids de instalación. Borra la base a mano (más abajo) y vuelve a ejecutar con `--skip-database`. |
| El usuario todavía es propietario de otras bases | Normalmente, instalaciones restauradas que usan el usuario de esta. Desinstálalas antes (siguiente apartado) y vuelve a ejecutar el comando. |
| No se borrará una ruta | Una carpeta de datos está fuera de la carpeta de la instalación, coincide con una carpeta reservada (`.git`, `node_modules`, `apps`, `packages`, `scripts`, `docs`, `.github`, `backups`) o pasa por un enlace simbólico. Se deja en su sitio y se muestra; bórrala tú si corresponde. |

### Instalaciones restauradas

Una instalación restaurada tiene su propia carpeta, `.env` y base de datos, y usa el usuario de PostgreSQL de la instalación original. Desinstálala desde este checkout:

```sh
CAREER_ENV_FILE=/ruta/restaurada/.env pnpm run uninstall
CAREER_ENV_FILE=/ruta/restaurada/.env pnpm run uninstall --confirm <CAREER_RESTORE_ID>
```

Solo borra la base restaurada y esa carpeta. Nunca borra el usuario, que sigue usando la instalación original. Las restauraciones hechas antes de esta versión no tienen `CAREER_RESTORE_ID`: bórralas a mano.

### Borrar a mano

Usa estos pasos solo para lo que el script rechazó o no cubre. Toma los nombres del `DATABASE_URL` de esa instalación (`postgresql://USUARIO:…@host:puerto/BASE`) y no pegues la contraseña en ningún sitio.

```sh
# Comprueba qué le queda al usuario antes de borrarlo (conéctate como administrador)
psql "postgresql://ADMIN@127.0.0.1:5432/postgres" -c "select datname from pg_database where datdba = 'USUARIO'::regrole"
psql "postgresql://ADMIN@127.0.0.1:5432/postgres" -c 'drop database "BASE"'
psql "postgresql://ADMIN@127.0.0.1:5432/postgres" -c 'drop role "USUARIO"'    # solo si ninguna otra base lo usa
```

No uses `DROP OWNED`: borraría también los objetos de ese usuario en otras bases. Después borra `data/` (o las carpetas de `DATA_LOCAL_PATH` y `FILES_LOCAL_PATH`), `backups/` si quieres, y `.env`.

**Docker:** el servidor guarda sus datos en el volumen `career-postgres`, que puede contener bases de otras instalaciones (las restauradas, por ejemplo). Borra el volumen solo cuando no quede ninguna otra base:

```sh
docker compose exec postgres psql -U career -d postgres -Atc "select datname from pg_database where not datistemplate and datname <> 'postgres'"
docker compose down -v    # solo si la lista anterior está vacía
```

### Lo que no se puede borrar desde aquí

- Las copias y archivos que descargaste o copiaste a otro sitio.
- Las solicitudes y documentos ya enviados a empresas.
- El historial que guarde un proveedor de IA (Codex o Claude) y su sesión en este equipo.
- El servidor PostgreSQL, los navegadores de Playwright y el código del proyecto: bórralos tú si ya no los necesitas.
