# 019 — Encrypted operational backups and data at rest

Status: **accepted**, implementation pending (issue [#84](https://github.com/AldereteRuben/career-agent-stack/issues/84)). Date: 2026-10-10.

## Context

What the app protects today, checked in the code:

| Data | Protection today |
|---|---|
| Active PostgreSQL database and generated PDFs (`data/files`) | **Not encrypted by the app.** Only file permissions and, when enabled, the operating system's disk encryption (FileVault, BitLocker, LUKS) protect them. |
| Operational backup (`career-backup-*.tar`) | **Not encrypted.** `manifest.hmac` is an HMAC-SHA-256 over the manifest with a key derived from `APP_ENCRYPTION_KEY` (HKDF, `backup-manifest-hmac-v1`). It detects tampering; it does not hide the contents. Anyone who has the archive can read the database dump and the PDFs. |
| `APP_ENCRYPTION_KEY` | **Encrypts nothing.** It authenticates backup manifests and salts the AI account fingerprint. It travels in a separate key file (`career-key-<fingerprint>.json`), and a backup cannot be restored without it. |

The backup guide and `SECURITY.md` already say that backups are not encrypted. Three texts say otherwise and must be corrected:

- the `.env` written by `scripts/bootstrap.mjs`: "APP_ENCRYPTION_KEY protects stored data";
- `README.md` and `README.es.md`: `.env` "contains your encryption key" / "la clave de cifrado";
- the key file's warning: anyone holding it and a backup "can **read** and authenticate that backup", which implies the backup cannot be read without it.

Backups matter more now that the profile can hold an imported resume ([ADR 018](018-cv-import.md)), which deliberately does not store the raw resume text because backups are not encrypted.

## Decision

### 1. Backups are encrypted with age

New backups are encrypted with the **[age](https://age-encryption.org/v1) format** (X25519 recipients, ChaCha20-Poly1305 in 64 KiB chunks, with protection against truncation and reordering), using **`age-encryption`**, the official TypeScript implementation by age's author ([FiloSottile/typage](https://github.com/FiloSottile/typage), BSD-3-Clause). It encrypts `ReadableStream`s, so large backups are never held in memory.

The project does not design its own encryption format. An age file can also be decrypted without the app with the official `age` tool, which matters most during a recovery.

The dependency is pinned to an exact version and recorded in `THIRD_PARTY_NOTICES.md`; updates are reviewed like any security-sensitive dependency.

### 2. The key is derived from APP_ENCRYPTION_KEY

The age identity is derived from `APP_ENCRYPTION_KEY` with HKDF-SHA-256 (salt `career-agent-stack`, info `backup-age-identity-v1`, 32 bytes) and encoded as an age X25519 identity (`AGE-SECRET-KEY-1…`). The backup is encrypted to the matching recipient.

- **No new secret.** Restoring already requires the key file, so encryption adds neither a new password to remember nor a new way to lose a backup. Losing the key file still means the backup cannot be restored, as today.
- The **key file** (format version 2) also contains the derived age identity, so `age -d -i <identity> career-backup-….tar.age` decrypts a backup without the app. It reveals nothing beyond `APP_ENCRYPTION_KEY`, from which it is derived.
- Separate HKDF labels keep the encryption key, the manifest HMAC key and the key fingerprint independent of each other.

### 3. The archive format

A **format version 2** backup is the current version 1 tar (manifest, `manifest.hmac`, database dump, documents) encrypted as a whole: `career-backup-<UTC time>.tar.age`. Its `.sha256` file covers the encrypted file.

Nothing inside the tar changes, so the existing verification (manifest, HMAC, sizes and hashes of every entry) still runs after decryption. A wrong key or any alteration fails during decryption, before any restored data is written. The plaintext is decrypted only into a private temporary directory for verification and restore, and removed afterwards, including on failure. "Private" depends on the system:

- **macOS and Linux:** the directory is created with mode `0700` (files `0600`).
- **Windows:** POSIX modes do not restrict access there ([Node.js `fs` documentation](https://nodejs.org/api/fs.html): `chmod` cannot set owner, group and others separately). The directory is created inside the current user's own temporary folder, inheritance is removed and access is granted only to the current user, and the ACL is checked before anything is written. If it cannot be restricted or checked, the restore stops instead of writing plaintext.

### 4. Old unencrypted backups stay restorable, with a warning

Format version 1 backups can still be restored. `pnpm run restore` detects that the file is not encrypted, explains that its contents were never protected, and continues only with an explicit `--allow-unencrypted`. Encrypted backups need no flag. New backups are always encrypted; there is no option to create an unencrypted one.

### 5. Data in active use is not encrypted by the app

The app does not encrypt the active database or the PDFs in `data/files`. The documentation states this plainly and recommends the operating system's disk encryption (FileVault on macOS, BitLocker on Windows, LUKS on Linux). Encrypting fields or files inside the app would be a separate, much larger design.

## Implementation plan

1. **Documentation** (no behavior change): describe what is and is not protected, as in the table above, in `README.md`, `README.es.md`, `SECURITY.md` and `docs/operations/backup-restore.md`, in English and Spanish, and correct the three misleading texts.
2. **Encrypted backups:** add `age-encryption`; derive the identity; write format version 2 and key file version 2; decrypt, verify and restore; refuse version 1 without `--allow-unencrypted`. Tests with fictional data and disposable databases: round trip, wrong key, truncated or altered file, old version 1 backup with and without the flag, no plaintext left behind after a failure, and the temporary directory's protection on each system (mode `0700` on Linux and macOS; on the Windows CI runner, an ACL that grants access only to the current user).
3. **Settings:** the backup downloaded from Settings is the encrypted `.tar.age`, the key file is still downloaded separately, and the text explains both in Spanish and English.

## Consequences

- A backup copied to a shared or cloud folder no longer exposes the profile, resumes or applications unless the key file is with it. Keeping the key file apart becomes the one thing that protects a backup.
- Restoring needs a little more time and temporary space for decryption.
- Changing `APP_ENCRYPTION_KEY` is still unsupported; backups made with an earlier key need the matching key file.
- **Known limitation, separate from this decision:** the project's other private files (`.env`, the key file, backup and restore folders, restored documents) are protected only with POSIX modes today, which do not restrict access on Windows, and `looseBits` cannot see Windows ACLs. Windows support is still being completed ([#19](https://github.com/AldereteRuben/career-agent-stack/issues/19)); applying the same ACL approach to those files belongs in its own issue.
- Encryption protects backups, not the running installation: a person with access to the computer and the user account can still read the active data, unless the disk is encrypted and the computer is locked.

## Out of scope

Encrypting the active database or `data/files`, key rotation, passphrase-based backups, and restoring from Settings without the terminal ([#33](https://github.com/AldereteRuben/career-agent-stack/issues/33)).
