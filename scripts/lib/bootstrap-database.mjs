/**
 * PostgreSQL 16+ no longer lets a CREATEROLE administrator act as the roles it creates, which "create database … owner"
 * needs. The creator holds ADMIN OPTION on the new role, so it can grant itself membership with SET.
 * Superusers need nothing. Returns whether a grant was made; a refused grant throws the original error (code 42501).
 */
export async function allowAdminToUseRole(client, role) {
  const { rows: [{ rolsuper, version }] } = await client.query(
    `select rolsuper, current_setting('server_version_num')::int as version from pg_roles where rolname = current_user`,
  );
  if (rolsuper) return false;
  await client.query(`grant ${client.escapeIdentifier(role)} to current_user${version >= 160000 ? ' with set true' : ''}`);
  return true;
}
