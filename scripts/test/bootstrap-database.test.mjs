// Proves a non-superuser CREATEROLE/CREATEDB administrator can create a database owned by a role it just created,
// which PostgreSQL 16+ refuses ("must be able to SET ROLE") without the grant bootstrap makes.
// Needs a loopback superuser URL on the maintenance database; it creates and removes its own roles and database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { allowAdminToUseRole, runAsRole } from '../lib/bootstrap-database.mjs';

const root = new URL('../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_BOOTSTRAP_TEST_ADMIN_URL;

test('a non-superuser administrator can create a database for the role it created', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'fixture URL must connect through the maintenance database');
  const id = randomBytes(5).toString('hex');
  const adminRole = `career_bt_admin_${id}`;
  const roles = [`career_bt_a_${id}`, `career_bt_b_${id}`];
  const databases = [`career_bt_a_${id}`, `career_bt_b_${id}`];
  const adminPassword = randomBytes(12).toString('hex');
  const asAdmin = new URL(maintenance); asAdmin.username = adminRole; asAdmin.password = adminPassword;
  const superuser = new Client({ connectionString: maintenance.toString() });
  let administrator;
  try {
    await superuser.connect();
    await superuser.query(`create role "${adminRole}" login createrole createdb password '${adminPassword}'`);
    administrator = new Client({ connectionString: asAdmin.toString() });
    await administrator.connect();
    const { rows: [{ version }] } = await administrator.query(`select current_setting('server_version_num')::int as version`);

    await administrator.query(`create role "${roles[0]}" login password 'x'`);
    if (version >= 160000) {
      await assert.rejects(administrator.query(`create database "${databases[0]}" owner "${roles[0]}"`), { code: '42501' }, 'PostgreSQL 16+ must refuse without the grant');
    }
    assert.equal(await allowAdminToUseRole(administrator, roles[0]), true);
    await administrator.query(`create database "${databases[0]}" owner "${roles[0]}"`);
    const { rows } = await administrator.query(`select pg_get_userbyid(datdba) as owner from pg_database where datname = $1`, [databases[0]]);
    assert.equal(rows[0].owner, roles[0]);
    await runAsRole(administrator, roles[0], async () => {
      await administrator.query(`comment on database "${databases[0]}" is 'bootstrap test'`);
      await administrator.query(`revoke all on database "${databases[0]}" from public`);
    });
    assert.equal((await administrator.query('select current_user as me')).rows[0].me, adminRole, 'reset role must return to the administrator');
    // The installation promises "no access for other local roles": the administrator must not be able to open the new database.
    assert.equal((await administrator.query(`select has_database_privilege($1, 'connect') as can_connect`, [databases[0]])).rows[0].can_connect, false);
    const asAdminOnNewDatabase = new Client({ connectionString: Object.assign(new URL(asAdmin), { pathname: `/${databases[0]}` }).toString() });
    await assert.rejects(asAdminOnNewDatabase.connect(), { code: '42501' }, 'the administrator must not be able to connect to the installation database');
    await asAdminOnNewDatabase.end().catch(() => undefined);
    const membership = async () => (await administrator.query(
      `select bool_or(m.set_option) as set, bool_or(m.inherit_option) as inherit from pg_auth_members m
         where m.roleid = $1::regrole and m.member = $2::regrole`, [`"${roles[0]}"`, `"${adminRole}"`])).rows;
    if (version >= 160000) {
      assert.deepEqual((await membership())[0], { set: true, inherit: false }, 'the grant must allow SET ROLE without inheriting privileges');
      const { rows: [privileges] } = await administrator.query(`select pg_has_role($1, 'usage') as inherits, pg_has_role($1, 'set') as can_set`, [roles[0]]);
      assert.deepEqual(privileges, { inherits: false, can_set: true });
      await assert.rejects(administrator.query(`comment on database "${databases[0]}" is 'x'`), { code: '42501' }, 'ownership statements need SET ROLE when privileges are not inherited');
    }
    await allowAdminToUseRole(administrator, roles[0]); // idempotent: repeating the grant must not fail
    if (version >= 160000) assert.deepEqual((await membership())[0], { set: true, inherit: false }, 'a second grant must keep inherit off');

    await superuser.query(`create role "${roles[1]}" login password 'x'`);
    assert.equal(await allowAdminToUseRole(superuser, roles[1]), false, 'a superuser needs no grant');
    await superuser.query(`create database "${databases[1]}" owner "${roles[1]}"`);
  } finally {
    await administrator?.end().catch(() => undefined);
    for (const database of databases) await superuser.query(`drop database if exists "${database}"`).catch(() => undefined);
    for (const role of [...roles, adminRole]) await superuser.query(`drop role if exists "${role}"`).catch(() => undefined);
    await superuser.end().catch(() => undefined);
  }
});
