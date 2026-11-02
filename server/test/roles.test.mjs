// 角色和权限：第一版数据升级、管理员平级、自定义角色、部门负责人和数据范围、服务器上的救急命令。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cookieOf, designOrg, member, server } from './helpers.mjs';
import { createApp } from '../src/app.js';
import { MIGRATIONS_FOR_TEST } from '../src/db.js';
import { hashPassword } from '../src/secrets.js';
import { purgeTrashOffline, resetPasswordOffline } from '../src/index.js';

const admin = (s, method, url, body) => s.request(method, '/api/v1/admin' + url, { cookie: s.adminCookie, body });

test('第一版数据升级：先备份；所有者变管理员，成员挂“成员”角色，邀请也挂上；团队内容的权限不动', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wwe-upgrade-'));
  let app = null;
  // 先关服务端再删目录：Windows 上数据库文件开着时删不掉。
  t.after(async () => { await app?.app.close(); await rm(dataDir, { recursive: true, force: true }); });
  // 用第一版的结构造一个旧数据库。
  const db = new DatabaseSync(path.join(dataDir, 'whalewing-enterprise.db'));
  db.exec(MIGRATIONS_FOR_TEST[0]);
  db.exec('PRAGMA user_version = 1');
  const at = new Date().toISOString();
  const hash = await hashPassword('old-pass-123');
  db.prepare("INSERT INTO meta (key, value) VALUES ('org_name', '老公司')").run();
  db.prepare('INSERT INTO departments (id, name, parent_id, sort, created_at) VALUES (1, ?, NULL, 1, ?)').run('研发部', at);
  const user = db.prepare('INSERT INTO users (username, display_name, password_hash, role, department_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  user.run('boss', '所有者', hash, 'owner', null, 'active', at, at);
  user.run('helper', '管理员', hash, 'admin', null, 'active', at, at);
  user.run('dev', '开发', hash, 'member', 1, 'active', at, at);
  db.prepare("INSERT INTO invites (code_hash, code_hint, department_id, role, max_uses, expires_at, created_at) VALUES ('h', 'abcdef', 1, 'member', 3, ?, ?)").run('2999-01-01T00:00:00Z', at);
  db.prepare("INSERT INTO items (id, kind, slug, title, revision, created_at, updated_at) VALUES (1, 'knowledge', 'handbook', '手册', 1, ?, ?)").run(at, at);
  db.prepare("INSERT INTO access (item_id, mode, subject_type, subject_id) VALUES (1, 'view', 'department', 1), (1, 'maintain', 'user', 3)").run();
  db.close();

  const notes = [];
  app = await createApp({ dataDir, version: 'test', onLog: message => notes.push(message) });
  assert.ok(notes.some(note => /从版本 1 升级到 2，已先备份/.test(note)));
  assert.equal(readdirSync(path.join(dataDir, 'backups')).filter(name => name.endsWith('-v1.db')).length, 1);

  const users = app.org.users();
  assert.deepEqual(users.map(u => [u.username, u.role]), [['boss', 'admin'], ['helper', 'admin'], ['dev', 'member']]);
  const memberRole = app.roles.presetMember();
  assert.equal(memberRole.name, '成员');
  assert.equal(users.find(u => u.username === 'dev').roleId, memberRole.id);
  assert.equal(app.db.prepare('SELECT role_id FROM invites').get().role_id, memberRole.id);
  assert.deepEqual(app.roles.list().map(role => [role.name, role.scope]), [['负责人', 'managed'], ['成员', 'self']]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM access WHERE item_id = 1').get().n, 2, '团队内容的可见范围和维护人不动');
  assert.equal(app.work.types()[0].prefix, 'RW', '预置“任务”类型');

  const login = await app.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'boss', password: 'old-pass-123', client: 'admin' } });
  assert.equal(login.statusCode, 200, '原来的所有者照常能登录管理端');
  assert.equal(login.json().me.access.admin, true);
  const dev = await app.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'dev', password: 'old-pass-123', client: 'plugin' } });
  assert.deepEqual([dev.json().me.access.roleName, dev.json().me.access.scope, dev.json().me.access.permissions], ['成员', 'self', ['item.create']]);
});

test('管理员之间平级：都能任命、停用别的管理员、重置他们的密码；最后一个启用的管理员不能被停用或降级', async t => {
  const s = await server(t);
  const second = await member(s, { username: 'admin2', role: 'admin', password: 'admin-pass-2' });
  const secondCookie = cookieOf(await s.request('POST', '/api/v1/auth/login', { body: { username: 'admin2', password: 'admin-pass-2', client: 'admin' } }));
  const first = s.org.users().find(user => user.username === 'owner');

  // 后任命的管理员能重置先来的管理员的密码，先来的那位已登录的地方马上失效。
  assert.equal((await s.request('POST', `/api/v1/admin/users/${first.id}/password`, { cookie: secondCookie, body: { password: 'new-pass-123' } })).status, 200);
  assert.equal((await s.request('GET', '/api/v1/admin/overview', { cookie: s.adminCookie })).status, 401);
  const firstCookie = cookieOf(await s.request('POST', '/api/v1/auth/login', { body: { username: 'owner', password: 'new-pass-123', client: 'admin' } }));

  assert.match((await s.request('PATCH', `/api/v1/admin/users/${second.user.id}`, { cookie: secondCookie, body: { role: 'member' } })).json.error.message, /不能把自己改成成员/);
  // 另一位能把他降成成员；降级马上生效，他进不了管理端。
  const demoted = await s.request('PATCH', `/api/v1/admin/users/${second.user.id}`, { cookie: firstCookie, body: { role: 'member' } });
  assert.equal(demoted.json.role, 'member');
  assert.equal(demoted.json.roleId, s.roles.presetMember().id, '降成成员时挂预置的“成员”角色');
  assert.equal((await s.request('GET', '/api/v1/admin/overview', { cookie: secondCookie })).status, 401);

  // 只剩一个启用的管理员：谁来操作都不能停用或降级他（直接调服务端逻辑模拟别处来的请求）。
  const lastAdmin = s.org.user(first.id);
  assert.throws(() => s.org.updateUser(s.org.user(second.user.id), first.id, { status: 'disabled' }), /最后一个启用的管理员/);
  assert.throws(() => s.org.updateUser(s.org.user(second.user.id), first.id, { role: 'member' }), /最后一个启用的管理员/);
  assert.equal(s.org.user(first.id).status, lastAdmin.status);

  const audit = (await s.request('GET', '/api/v1/admin/audit?action=user', { cookie: firstCookie })).json.entries;
  assert.ok(audit.some(entry => entry.action === 'user.password' && entry.target === 'owner' && /admin2/.test(entry.actorName)));
});

test('自定义角色：名字不能重；有人在用时不能删；换角色不用重新登录，权限马上变', async t => {
  const s = await server(t);
  const created = await admin(s, 'POST', '/roles', { name: '项目经理', scope: 'all', permissions: ['item.create', 'board.view', 'board.view'] });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.permissions, ['item.create', 'board.view'], '重复的权限点只留一个');
  assert.equal((await admin(s, 'POST', '/roles', { name: '项目经理', scope: 'self', permissions: [] })).json.error.code, 'EXISTS');
  assert.equal((await admin(s, 'POST', '/roles', { name: '坏的', scope: 'self', permissions: ['root'] })).json.error.code, 'INVALID_INPUT');

  const pm = await member(s, { username: 'pm' });
  assert.equal((await s.request('GET', '/api/v1/me', { token: pm.token })).json.access.board, false);
  await admin(s, 'PATCH', `/users/${pm.user.id}`, { roleId: created.json.id });
  const me = (await s.request('GET', '/api/v1/me', { token: pm.token })).json;
  assert.deepEqual([me.access.roleName, me.access.scope, me.access.board], ['项目经理', 'all', true], '令牌还能用，权限马上换了');

  assert.equal((await admin(s, 'DELETE', `/roles/${created.json.id}`)).json.error.code, 'IN_USE');
  const invite = (await admin(s, 'POST', '/invites', { departmentId: null, roleId: created.json.id })).json;
  assert.equal((await s.request('GET', `/api/v1/invites/${invite.invite.code}`)).json.roleName, '项目经理');
  await admin(s, 'PATCH', `/users/${pm.user.id}`, { roleId: s.roles.presetMember().id });
  assert.match((await admin(s, 'DELETE', `/roles/${created.json.id}`)).json.error.message, /1 个没用完的邀请/);
  await admin(s, 'DELETE', `/invites/${invite.invite.id}`);
  assert.equal((await admin(s, 'DELETE', `/roles/${created.json.id}`)).status, 200);
  const renamed = await admin(s, 'PATCH', `/roles/${s.roles.presetMember().id}`, { name: '组员' });
  assert.equal(renamed.json.name, '组员', '预置角色能改名');
  const audit = (await admin(s, 'GET', '/audit?action=role')).json.entries.map(entry => entry.action);
  assert.deepEqual(audit, ['role.update', 'role.delete', 'role.create']);
});

test('上下级来自部门树和负责人：乙管整个交付中心，两个小组长互相看不到；没当负责人的“管理范围”只能管自己', async t => {
  const s = await server(t);
  const { one, two, people } = await designOrg(s);
  const accessOf = key => s.roles.access(s.org.user(people[key].user.id));
  const yi = accessOf('yi'), bing = accessOf('bing'), ji = accessOf('ji'), ding = accessOf('ding');
  assert.ok(yi.inScope(people.ding.user.id) && yi.inScope(people.geng.user.id), '上级比下级看得多，是树自己带出来的');
  assert.ok(bing.inScope(people.wu.user.id));
  assert.ok(!bing.inScope(people.geng.user.id) && !ji.inScope(people.ding.user.id), '两个小组长互相看不到对方的组');
  assert.ok(!ding.inScope(people.wu.user.id) && ding.inScope(people.ding.user.id));
  assert.equal(yi.board, true);
  assert.equal(ding.board, false);

  const me = (await s.request('GET', '/api/v1/me', { token: people.bing.token })).json.access;
  assert.deepEqual(me.managed, [{ id: one.id, name: '一组' }]);

  // 己不再是二组负责人：角色还是“小组长”，但实际只能管自己，看不到看板；管理端概览提示。
  await admin(s, 'PUT', `/departments/${two.id}/managers`, { userIds: [] });
  const after = s.roles.access(s.org.user(people.ji.user.id));
  assert.equal(after.board, false);
  assert.ok(!after.inScope(people.geng.user.id));
  const overview = (await admin(s, 'GET', '/overview')).json;
  assert.deepEqual(overview.roles.map(role => [role.name, role.notManaging]), [['小组长', 1]]);
  const departments = (await admin(s, 'GET', '/departments')).json.departments;
  assert.deepEqual(departments.find(department => department.id === one.id).managerIds, [people.bing.user.id]);
  assert.equal((await admin(s, 'PUT', `/departments/${one.id}/managers`, { userIds: [999] })).json.error.code, 'NOT_FOUND');
});

test('服务器上的救急命令：重置密码给临时密码并能顺便设成管理员；清空回收站', async t => {
  const s = await server(t);
  const dev = await member(s, { username: 'dev' });
  const item = (await s.request('POST', '/api/v1/work/items', { token: dev.token, body: { title: '要删的事项' } })).json;
  await s.request('DELETE', `/api/v1/work/items/${item.id}`, { cookie: s.adminCookie });
  await s.app.close();

  const reset = await resetPasswordOffline(s.dataDir, 'dev', { makeAdmin: true });
  assert.equal(reset.admin, true);
  assert.ok(reset.password.length >= 12);
  assert.equal(purgeTrashOffline(s.dataDir, { olderThanDays: 30 }), 0, '还没满 30 天的不删');
  assert.equal(purgeTrashOffline(s.dataDir), 1);
  await assert.rejects(resetPasswordOffline(s.dataDir, 'nobody'), /没有登录名是“nobody”/);

  const again = await createApp({ dataDir: s.dataDir, version: 'test' });
  try {
    const login = await again.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'dev', password: reset.password, client: 'admin' } });
    assert.equal(login.statusCode, 200);
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM work_items').get().n, 0);
    const audit = again.audit.list({ limit: 5 }).map(entry => [entry.action, entry.actorName]);
    assert.deepEqual(audit.slice(0, 2), [['work.purge', null], ['user.password', null]], '命令行做的操作也进操作记录，操作人是空（系统之外）');
    assert.ok(!existsSync(path.join(s.dataDir, 'setup-code.txt')));
  } finally { await again.app.close(); }
});
