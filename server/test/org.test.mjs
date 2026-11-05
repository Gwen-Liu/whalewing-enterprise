import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cookieOf, member, OWNER, server, SETUP_CODE } from './helpers.mjs';
import { createApp } from '../src/app.js';

test('初始化：没初始化时只能用初始化码建第一个管理员，且只能做一次', async t => {
  const s = await server(t, { setup: false });
  const hello = await s.request('GET', '/api/v1/hello');
  assert.equal(hello.json.setupRequired, true);
  assert.equal(hello.json.orgName, null);
  assert.equal(hello.json.protocol, 2);
  assert.ok(existsSync(path.join(s.dataDir, 'setup-code.txt')));
  assert.equal((await s.request('POST', '/api/v1/auth/login', { body: { username: 'x', password: 'y', client: 'plugin' } })).json.error.code, 'SETUP_REQUIRED');

  const wrong = await s.request('POST', '/api/v1/setup', { body: { setupCode: '0000-0000', orgName: '公司', ...OWNER } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'SETUP_CODE');

  const weak = await s.request('POST', '/api/v1/setup', { body: { setupCode: SETUP_CODE, orgName: '公司', ...OWNER, password: 'short' } });
  assert.equal(weak.json.error.code, 'INVALID_INPUT');
  assert.match(weak.json.error.message, /密码至少 8 位/);

  const ok = await s.request('POST', '/api/v1/setup', { body: { setupCode: SETUP_CODE, orgName: '鲸翼测试公司', ...OWNER } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.me.user.role, 'admin', '第一个账号就是普通的管理员，没有“所有者”');
  assert.equal(ok.json.me.access.admin, true);
  const cookie = cookieOf(ok);
  assert.match(ok.headers['set-cookie'], /HttpOnly/i);
  assert.match(ok.headers['set-cookie'], /SameSite=Strict/i);
  assert.ok(!existsSync(path.join(s.dataDir, 'setup-code.txt')), '初始化后删掉初始化码文件');

  const again = await s.request('POST', '/api/v1/setup', { body: { setupCode: SETUP_CODE, orgName: '别的公司', ...OWNER } });
  assert.equal(again.json.error.code, 'SETUP_DONE');
  assert.equal((await s.request('GET', '/api/v1/hello')).json.orgName, '鲸翼测试公司');
  assert.equal((await s.request('GET', '/api/v1/admin/overview', { cookie })).status, 200);
});

test('登录：输错 5 次锁定；成员不能登录管理端；管理端改东西要带防跨站请求头', async t => {
  const s = await server(t);
  await member(s, { username: 'zhang' });
  const adminLogin = await s.request('POST', '/api/v1/auth/login', { body: { username: 'zhang', password: 'member-pass-1', client: 'admin' } });
  assert.equal(adminLogin.json.error.code, 'FORBIDDEN');

  for (let i = 0; i < 5; i++) {
    const bad = await s.request('POST', '/api/v1/auth/login', { body: { username: 'zhang', password: 'wrong-password', client: 'plugin' } });
    assert.equal(bad.json.error.code, 'AUTH_INVALID');
  }
  const locked = await s.request('POST', '/api/v1/auth/login', { body: { username: 'zhang', password: 'member-pass-1', client: 'plugin' } });
  assert.equal(locked.json.error.code, 'AUTH_LOCKED');
  // 登录名大小写不同也算同一个账号。
  assert.equal((await s.request('POST', '/api/v1/auth/login', { body: { username: 'ZHANG', password: 'member-pass-1', client: 'plugin' } })).json.error.code, 'AUTH_LOCKED');

  const noHeader = await s.request('POST', '/api/v1/admin/departments', { cookie: s.adminCookie, csrf: false, body: { name: '研发部', parentId: null } });
  assert.equal(noHeader.json.error.code, 'CSRF');
  const unknown = await s.request('POST', '/api/v1/auth/login', { body: { username: 'nobody', password: 'whatever-1', client: 'plugin' } });
  assert.equal(unknown.json.error.code, 'AUTH_INVALID');
});

test('停用和改角色马上生效：已登录的令牌立刻作废', async t => {
  const s = await server(t);
  const zhang = await member(s, { username: 'zhang' });
  assert.equal((await s.request('GET', '/api/v1/me', { token: zhang.token })).json.user.username, 'zhang');
  const disabled = await s.request('PATCH', `/api/v1/admin/users/${zhang.user.id}`, { cookie: s.adminCookie, body: { status: 'disabled' } });
  assert.equal(disabled.json.status, 'disabled');
  const after = await s.request('GET', '/api/v1/sync', { token: zhang.token });
  assert.equal(after.status, 401);
  assert.equal((await s.request('POST', '/api/v1/auth/login', { body: { username: 'zhang', password: 'member-pass-1', client: 'plugin' } })).json.error.code, 'ACCOUNT_DISABLED');

  const first = s.org.users().find(user => user.role === 'admin');
  assert.equal((await s.request('PATCH', `/api/v1/admin/users/${first.id}`, { cookie: s.adminCookie, body: { status: 'disabled' } })).json.error.code, 'FORBIDDEN', '不能停用自己');
});

test('邀请：带部门和人数上限，用完、过期、撤销后都不能再用', async t => {
  const s = await server(t);
  const rd = await s.request('POST', '/api/v1/admin/departments', { cookie: s.adminCookie, body: { name: '研发部', parentId: null } });
  const created = await s.request('POST', '/api/v1/admin/invites', { cookie: s.adminCookie, body: { departmentId: rd.json.id, maxUses: 1 } });
  assert.equal(created.status, 200);
  const { link, invite } = created.json;
  assert.match(link, /\/join\/[A-Za-z0-9_-]{32}$/);
  const info = await s.request('GET', `/api/v1/invites/${invite.code}`);
  assert.deepEqual([info.json.orgName, info.json.department, info.json.role], ['鲸翼测试公司', '研发部', 'member']);

  const joined = await s.request('POST', '/api/v1/auth/join', { body: { code: invite.code, username: 'li', displayName: '李四', password: 'li-pass-123' } });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.me.department.name, '研发部');
  assert.equal(joined.json.me.org.name, '鲸翼测试公司');
  assert.equal((await s.request('GET', '/api/v1/me', { token: joined.json.token })).json.user.displayName, '李四');

  const used = await s.request('POST', '/api/v1/auth/join', { body: { code: invite.code, username: 'wang', displayName: '王五', password: 'wang-pass-123' } });
  assert.equal(used.json.error.code, 'INVITE_EXPIRED');
  assert.equal((await s.request('GET', '/api/v1/invites/not-a-real-invite-code-0000')).json.error.code, 'INVITE_INVALID');

  const second = (await s.request('POST', '/api/v1/admin/invites', { cookie: s.adminCookie, body: { departmentId: null, maxUses: 5 } })).json.invite;
  await s.request('DELETE', `/api/v1/admin/invites/${second.id}`, { cookie: s.adminCookie });
  assert.equal((await s.request('GET', `/api/v1/invites/${second.code}`)).json.error.code, 'INVITE_EXPIRED');

  const page = await s.request('GET', `/join/${invite.code}`);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);

  // 管理员之间平级：后任命的管理员也能邀请管理员。
  const admin = await member(s, { username: 'admin2', role: 'admin', password: 'admin-pass-1' });
  const adminCookie = cookieOf(await s.request('POST', '/api/v1/auth/login', { body: { username: 'admin2', password: 'admin-pass-1', client: 'admin' } }));
  assert.ok(admin.user.id);
  const adminInvite = await s.request('POST', '/api/v1/admin/invites', { cookie: adminCookie, body: { departmentId: null, role: 'admin' } });
  assert.equal(adminInvite.json.invite.role, 'admin');
  assert.equal((await s.request('GET', `/api/v1/invites/${adminInvite.json.invite.code}`)).json.roleName, '管理员');
  assert.equal(info.json.roleName, '成员', '成员的邀请写明加入后挂的角色');
});

test('邀请页会转义企业名称，防止被插入网页代码', async t => {
  const s = await server(t);
  await s.request('PATCH', '/api/v1/admin/settings', { cookie: s.adminCookie, body: { orgName: '<script>alert(1)</script>' } });
  const { invite } = (await s.request('POST', '/api/v1/admin/invites', { cookie: s.adminCookie, body: { departmentId: null } })).json;
  const page = await s.request('GET', `/join/${invite.code}`);
  assert.ok(!page.body.includes('<script>alert(1)</script>'));
  assert.ok(page.body.includes('&lt;script&gt;'));
});

test('助手名称：只有管理员能改；规则和鲸翼个人版一样；员工登录、读自己、同步都拿得到；清空后不改名', async t => {
  const s = await server(t);
  const settings = body => s.request('PATCH', '/api/v1/admin/settings', { cookie: s.adminCookie, body });
  assert.equal((await s.request('GET', '/api/v1/admin/settings', { cookie: s.adminCookie })).json.assistantName, null, '默认不改名');
  const zhang = await member(s, { username: 'zhang' });
  const orgOf = async () => (await s.request('GET', '/api/v1/me', { token: zhang.token })).json.org;
  assert.equal((await orgOf()).assistantName, null);

  // 起名：去掉首尾空白；正好 16 个字可以。
  const saved = await settings({ assistantName: '  小司助手 ' });
  assert.equal(saved.json.assistantName, '小司助手');
  assert.equal((await orgOf()).assistantName, '小司助手', '员工读自己时拿得到');
  const synced = await s.request('GET', '/api/v1/sync', { token: zhang.token });
  assert.equal(synced.json.me.org.assistantName, '小司助手', '同步时拿得到');
  const login = await s.request('POST', '/api/v1/auth/login', { body: { username: 'zhang', password: 'member-pass-1', client: 'plugin' } });
  assert.equal(login.json.me.org.assistantName, '小司助手', '登录时拿得到');
  assert.equal((await settings({ assistantName: '一二三四五六七八九十一二三四五六' })).json.assistantName, '一二三四五六七八九十一二三四五六');

  // 不合规的拒收，原来的名字不变。
  for (const bad of ['', '   ', '一二三四五六七八九十一二三四五六七', '小司\n助手', '小司\t助手', '小司 助手', 42]) {
    const rejected = await settings({ assistantName: bad });
    assert.equal(rejected.json.error?.code, 'INVALID_INPUT', JSON.stringify(bad));
  }
  assert.equal((await orgOf()).assistantName, '一二三四五六七八九十一二三四五六');

  // 改名后同步的 ETag 跟着变，员工端下次同步就拿到新名字；不带这个字段时不动。
  const before = (await s.request('GET', '/api/v1/sync', { token: zhang.token })).headers.etag;
  await settings({ assistantName: '小航助手' });
  const after = await s.request('GET', '/api/v1/sync', { token: zhang.token, headers: { 'if-none-match': before } });
  assert.equal(after.status, 200);
  assert.equal(after.json.me.org.assistantName, '小航助手');
  await settings({ offlineDays: 5 });
  assert.equal((await orgOf()).assistantName, '小航助手');

  // 只有管理员能改：员工端令牌（哪怕是管理员在员工端登录）调不了管理接口。
  assert.equal((await s.request('PATCH', '/api/v1/admin/settings', { token: zhang.token, body: { assistantName: '我的助手' } })).status, 401);
  const adminPlugin = await s.request('POST', '/api/v1/auth/login', { body: { username: OWNER.username, password: OWNER.password, client: 'plugin' } });
  assert.equal(adminPlugin.json.me.org.assistantName, '小航助手', '管理员在员工端也读得到');
  assert.equal((await s.request('PATCH', '/api/v1/admin/settings', { token: adminPlugin.json.token, body: { assistantName: '我的助手' } })).status, 401);
  assert.equal((await orgOf()).assistantName, '小航助手');

  // 清空：员工端拿到 null，鲸翼恢复“小鲸助手”。
  assert.equal((await settings({ assistantName: null })).json.assistantName, null);
  assert.equal((await orgOf()).assistantName, null);
  const { entries } = (await s.request('GET', '/api/v1/admin/audit?action=settings', { cookie: s.adminCookie })).json;
  assert.ok(entries.some(entry => entry.action === 'settings.update' && entry.detail?.assistantName === '小航助手'), '改名记进操作记录');
});

test('部门：不能移到自己的下级下面；有成员时不能删', async t => {
  const s = await server(t);
  const top = (await s.request('POST', '/api/v1/admin/departments', { cookie: s.adminCookie, body: { name: '总部', parentId: null } })).json;
  const child = (await s.request('POST', '/api/v1/admin/departments', { cookie: s.adminCookie, body: { name: '研发部', parentId: top.id } })).json;
  const loop = await s.request('PATCH', `/api/v1/admin/departments/${top.id}`, { cookie: s.adminCookie, body: { parentId: child.id } });
  assert.equal(loop.json.error.code, 'INVALID_INPUT');
  await member(s, { username: 'zhao', departmentId: child.id });
  assert.equal((await s.request('DELETE', `/api/v1/admin/departments/${child.id}`, { cookie: s.adminCookie })).json.error.code, 'IN_USE');
  const me = await s.request('POST', '/api/v1/auth/login', { body: { username: 'zhao', password: 'member-pass-1', client: 'plugin' } });
  assert.deepEqual(me.json.me.department.path, ['总部', '研发部']);
});

test('操作记录不记密码', async t => {
  const s = await server(t);
  await member(s, { username: 'zhang' });
  const { entries } = (await s.request('GET', '/api/v1/admin/audit', { cookie: s.adminCookie })).json;
  assert.ok(entries.some(entry => entry.action === 'user.create'));
  assert.ok(!JSON.stringify(entries).includes('member-pass-1'));
});

test('数据目录是更新版本写的时拒绝启动，不用旧程序打开', async t => {
  const s = await server(t);
  await s.app.close();
  const db = new DatabaseSync(path.join(s.dataDir, 'whalewing-enterprise.db'));
  db.exec('PRAGMA user_version = 99');
  db.close();
  await assert.rejects(createApp({ dataDir: s.dataDir, version: 'old' }), /更新版本/);
});
