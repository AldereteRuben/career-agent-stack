/**
 * PostgreSQL 16+ no longer lets a CREATEROLE administrator act as the roles it creates, which "create database … owner"
 * needs. The creator holds ADMIN OPTION on the new role, so it can grant itself membership with SET.
 * The grant is SET only (`inherit false`): the administrator must not silently hold the application role's privileges,
 * so statements that check ownership run between `SET ROLE` and `RESET ROLE` (see runAsRole). A repeated grant resets
 * INHERIT too, which also repairs a membership created with the default (inheriting) options.
 * Superusers need nothing. Returns whether a grant was made; a refused grant throws the original error (code 42501).
 */
export async function allowAdminToUseRole(client, role) {
  const { rows: [{ rolsuper, version }] } = await client.query(
    `select rolsuper, current_setting('server_version_num')::int as version from pg_roles where rolname = current_user`,
  );
  if (rolsuper) return false;
  await client.query(`grant ${client.escapeIdentifier(role)} to current_user${version >= 160000 ? ' with set true, inherit false' : ''}`);
  return true;
}

/** Runs `work` as `role` (SET ROLE) and always returns to the session's own role, even when `work` throws. */
export async function runAsRole(client, role, work) {
  await client.query(`set role ${client.escapeIdentifier(role)}`);
  try { return await work(); }
  finally { await client.query('reset role'); }
}

/**
 * Before PostgreSQL 16 a grant cannot be SET only: membership always inherits. Once the database is protected the
 * administrator gives the membership back, so it cannot open the installation's database. On 16+ the SET-only
 * membership is harmless and stays (a repeated run needs it). Not exercised by CI, which runs PostgreSQL 17.
 */
export async function releaseAdminFromRole(client, role) {
  const { rows: [{ version }] } = await client.query(`select current_setting('server_version_num')::int as version`);
  if (version >= 160000) return false;
  await client.query(`revoke ${client.escapeIdentifier(role)} from current_user`);
  return true;
}
