// 员工端核心逻辑对着真实的服务端跑：加入、同步、权限变化、维护、停用、离线、退出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/src/app.js';
import { Engine } from '../src/engine.js';
import { inspectAddress } from '../src/net.js';

const SETUP_CODE = '1111-2222';

function fakeCredentials() {
  const records = new Map();
  return {
    records,
    readRecord: async key => records.get(key),
    modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); },
    deleteRecord: async key => { records.delete(key); },
  };
}

function fakePersonal() {
  const calls = [];
  return {
    calls,
    search: async query => { calls.push(['search', query]); return { notes: [{ path: '40-知识/周报写法.md', title: '周报写法' }, { path: '@team/x/y.md', title: '团队的' }], total: 2, truncated: false }; },
    read: async notePath => { calls.push(['read', notePath]); return { path: notePath, content: '# 周报写法\n\n先写结论，再写进展。', hash: 'personal' }; },
  };
}

async function world(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wwe-plugin-'));
  const server = await createApp({ dataDir: path.join(dir, 'server'), version: 'test', setupCode: SETUP_CODE });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  let clock = Date.now();
  const engines = [];
  t.after(async () => {
    for (const engine of engines) engine.close();
    await server.app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const api = async (method, url, body, cookie) => {
    const response = await fetch(origin + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-whalewing-admin': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json().catch(() => null);
    return { status: response.status, json, headers: response.headers };
  };
  const setup = await api('POST', '/api/v1/setup', { setupCode: SETUP_CODE, orgName: '鲸翼测试公司', username: 'owner', displayName: '所有者', password: 'owner-pass-1' });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const admin = (method, url, body) => api(method, '/api/v1/admin' + url, body, cookie);
  const makeEngine = (name = 'a') => {
    // published 模拟 Host 每次收到变化就把专家列表推给鲸翼。
    const published = [];
    const engine = new Engine({ baseDir: path.join(dir, `client-${name}`), credentials: fakeCredentials(), credentialKey: `dsh-whalewing-enterprise/session-${name}`,
      personal: fakePersonal(), version: '0.2.1-rc.5.1', now: () => clock, log: () => {}, onChange: () => published.push(engine.expertItems()) });
    engine.published = published;
    engines.push(engine);
    return engine;
  };
  return { dir, server, origin, api, admin, cookie, makeEngine, tick: ms => { clock += ms; } };
}

async function seed(w) {
  const rd = (await w.admin('POST', '/departments', { name: '研发部', parentId: null })).json;
  await w.admin('POST', '/items', { kind: 'knowledge', slug: 'handbook', title: '研发手册', access: { view: [{ type: 'department', id: rd.id }], maintain: [{ type: 'department', id: rd.id }] } });
  await w.api('PUT', '/api/v1/items/knowledge/handbook/files/' + encodeURIComponent('评审') + '/' + encodeURIComponent('代码评审.md'), { content: '# 代码评审\n\n两人以上看过才能合并到主干。', baseHash: null }, w.cookie);
  await w.admin('POST', '/items', { kind: 'expert', slug: 'reviewer', title: '评审专家', description: '帮你做代码评审', access: { view: [{ type: 'all' }], maintain: [] } });
  await w.admin('POST', '/items', { kind: 'skill', slug: 'weekly-report', title: '周报', description: '按团队格式写周报' });
  const invite = (await w.admin('POST', '/invites', { departmentId: rd.id, maxUses: 5 })).json;
  return { rd, link: invite.link };
}

test('加入前先看清是哪家企业；加入后团队内容落到本机缓存，专家、知识、技能都能用', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  assert.equal(engine.status().state, 'disconnected');

  const probe = await engine.probe({ address: link });
  assert.deepEqual([probe.mode, probe.orgName, probe.department, probe.encrypted, probe.private], ['invite', '鲸翼测试公司', '研发部', false, true]);

  const status = await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  assert.equal(status.state, 'connected');
  assert.equal(status.me.department.name, '研发部');
  assert.deepEqual(status.items.map(item => `${item.kind}/${item.slug}`).sort(), ['expert/reviewer', 'knowledge/handbook', 'skill/weekly-report']);
  assert.ok(!JSON.stringify(status).includes('token'), '状态里不带令牌');

  const skill = await readFile(path.join(engine.skillsDir, 'weekly-report', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: weekly-report/);

  const experts = engine.expertItems();
  assert.equal(experts.length, 1);
  assert.deepEqual([experts[0].id, experts[0].name, experts[0].readOnly], ['reviewer', '评审专家', true]);

  const found = await engine.searchKnowledge('评审 合并');
  assert.equal(found.notes.length, 1);
  assert.equal(found.notes[0].path, 'handbook/评审/代码评审.md');
  assert.match(found.notes[0].title, /研发手册 \/ 代码评审/);
  const note = await engine.readKnowledge('handbook/评审/代码评审.md');
  assert.match(note.content, /两人以上/);
  assert.ok(path.isAbsolute(note.absolutePath) && existsSync(note.absolutePath));
  assert.equal((await engine.searchKnowledge('不存在的词')).notes.length, 0);

  // 再连一家：一个工作台只能连一家企业。
  await assert.rejects(engine.login({ address: w.origin, username: 'owner', password: 'owner-pass-1' }), error => error.code === 'CONNECTED');
});

test('改了可见范围或删了内容，下次同步本机就撤掉', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  await w.admin('PATCH', '/items/knowledge/handbook', { access: { view: [], maintain: [] } });
  await w.admin('DELETE', '/items/skill/weekly-report');
  const status = await engine.sync();
  assert.deepEqual(status.items.map(item => item.slug), ['reviewer']);
  assert.equal((await engine.searchKnowledge('评审')).notes.length, 0);
  assert.deepEqual(await readdir(engine.skillsDir), []);
  assert.ok(existsSync(engine.skillsDir), '登记给鲸翼的技能目录本身还在');
  assert.ok(!existsSync(path.join(engine.cacheDir, 'knowledge', 'handbook')));
});

test('维护人在专家团队里改团队专家；不是维护人、版本对不上都拒收', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  const expert = { name: '评审专家', description: '改过的介绍', prompt: '你是评审专家，先看测试。', skills: ['weekly-report'], avatar: null };
  await assert.rejects(engine.saveExpert({ id: 'reviewer', expectedRevision: engine.expertItems()[0].revision, expert }), error => error.code === 'FORBIDDEN');

  const users = (await w.admin('GET', '/users')).json.users;
  const zhang = users.find(user => user.username === 'zhang');
  await w.admin('PATCH', '/items/expert/reviewer', { access: { view: [{ type: 'all' }], maintain: [{ type: 'user', id: zhang.id }] } });
  await engine.sync();
  const before = engine.expertItems()[0];
  assert.equal(before.readOnly, false);
  await assert.rejects(engine.saveExpert({ id: 'reviewer', expectedRevision: before.revision - 1, expert }), error => error.code === 'CONFLICT');
  const saved = await engine.saveExpert({ id: 'reviewer', expectedRevision: before.revision, expert });
  assert.equal(saved.description, '改过的介绍');
  assert.ok(saved.revision > before.revision);
  const onServer = await fetch(w.origin + '/api/v1/items/expert/reviewer/files/expert.md', { headers: { cookie: w.cookie } }).then(r => r.text());
  assert.match(onServer, /skills:\n {2}- weekly-report/);
});

test('维护人在团队页签新建笔记、提交个人笔记；只发选中的那一篇', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  await engine.writeFile({ kind: 'knowledge', slug: 'handbook', path: '发布/上线清单.md', content: '# 上线清单\n\n先备份。', baseHash: null });
  assert.equal((await engine.searchKnowledge('备份')).notes.length, 1);

  const personal = await engine.personalSearch({ query: '周报' });
  assert.deepEqual(personal.notes.map(note => note.path), ['40-知识/周报写法.md'], '团队笔记不出现在个人笔记的选择里');
  await engine.submitPersonal({ notePath: '40-知识/周报写法.md', slug: 'handbook', path: '周报写法.md' });
  assert.deepEqual(engine.personal.calls.filter(call => call[0] === 'read'), [['read', '40-知识/周报写法.md']]);
  assert.equal((await engine.searchKnowledge('先写结论')).notes[0].path, 'handbook/周报写法.md');
  await assert.rejects(engine.submitPersonal({ notePath: '40-知识/周报写法.md', slug: 'handbook', path: '周报写法.md' }), error => error.code === 'CONFLICT');

  const read = await engine.readFile({ kind: 'knowledge', slug: 'handbook', path: '发布/上线清单.md' });
  await engine.writeFile({ kind: 'knowledge', slug: 'handbook', path: '发布/上线清单.md', content: read.content + '\n再发布。', baseHash: read.hash });
  await assert.rejects(engine.writeFile({ kind: 'knowledge', slug: 'handbook', path: '发布/上线清单.md', content: '旧版本覆盖', baseHash: read.hash }), error => error.code === 'CONFLICT');
});

test('管理员停用账号：下次同步本机团队内容撤掉、令牌删掉，状态变成登录已失效', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  const zhang = (await w.admin('GET', '/users')).json.users.find(user => user.username === 'zhang');
  await w.admin('PATCH', `/users/${zhang.id}`, { status: 'disabled' });
  const status = await engine.sync();
  assert.equal(status.state, 'expired');
  assert.equal(status.lastError.code, 'AUTH_EXPIRED');
  assert.equal(engine.expertItems().length, 0);
  assert.deepEqual(engine.published.at(-1), [], '登录失效后推给鲸翼的专家列表是空的');
  assert.equal((await engine.searchKnowledge('评审')).notes.length, 0);
  assert.deepEqual(await readdir(engine.skillsDir), []);
  assert.equal(engine.credentials.records.size, 0);
  assert.equal(status.server, w.origin, '留着服务器地址，方便重新登录');
});

test('连不上时缓存照常用；超过离线天数先撤掉，连上后恢复', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  const port = w.server.app.server.address().port;
  await w.server.app.close();

  await assert.rejects(engine.sync(), error => error.code === 'NETWORK');
  let status = engine.status();
  assert.equal(status.state, 'offline');
  assert.equal(status.hidden, false);
  assert.equal((await engine.searchKnowledge('评审')).notes.length, 1, '离线时缓存照常能用');

  w.tick(8 * 24 * 60 * 60 * 1000);
  await assert.rejects(engine.sync());
  status = engine.status();
  assert.equal(status.hidden, true);
  assert.equal((await engine.searchKnowledge('评审')).notes.length, 0);
  assert.equal(engine.expertItems().length, 0);

  // 同一个数据目录重新启动服务端，员工端自动恢复。
  const again = await createApp({ dataDir: path.join(w.dir, 'server'), version: 'test' });
  await again.app.listen({ port, host: '127.0.0.1' });
  try {
    status = await engine.sync();
    assert.equal(status.state, 'connected');
    assert.equal(status.hidden, false);
    assert.equal((await engine.searchKnowledge('评审')).notes.length, 1);
  } finally {
    // 先关掉重启的服务端，临时目录才删得掉（Windows 上打开着的数据库文件删不了）。
    await again.app.close();
  }
});

test('退出团队：服务端作废令牌，本机团队内容和状态都删掉', async t => {
  const w = await world(t);
  const { link } = await seed(w);
  const engine = w.makeEngine();
  await engine.start();
  await engine.join({ address: link, username: 'zhang', displayName: '张三', password: 'zhang-pass-1' });
  const token = [...engine.credentials.records.values()][0].payload.token;
  assert.equal(engine.published.at(-1).length, 1, '加入后推给鲸翼一位团队专家');
  const status = await engine.leave();
  assert.equal(status.state, 'disconnected');
  assert.deepEqual(engine.published.at(-1), [], '退出后推给鲸翼的专家列表是空的');
  assert.equal(engine.credentials.records.size, 0);
  assert.ok(!existsSync(engine.stateFile));
  assert.deepEqual(await readdir(engine.skillsDir), []);
  const after = await fetch(w.origin + '/api/v1/sync', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.status, 401);
  assert.deepEqual(engine.personal.calls, [], '退出不碰个人知识');

  // 重新启动员工端也还是没连接。
  const reopened = new Engine({ baseDir: engine.baseDir, credentials: engine.credentials, credentialKey: engine.credentialKey, personal: fakePersonal(), log: () => {} });
  await reopened.start();
  t.after(() => reopened.close());
  assert.equal(reopened.status().state, 'disconnected');
});

test('加密规则：外网地址只能 https；内网地址可以 http 并标明没加密', async () => {
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const privateLookup = async () => [{ address: '192.168.1.20', family: 4 }];
  await assert.rejects(inspectAddress('http://team.example.com', { lookup: publicLookup }), error => error.code === 'INSECURE');
  assert.deepEqual(await inspectAddress('http://team.corp', { lookup: privateLookup }), { origin: 'http://team.corp', encrypted: false, private: true, hostname: 'team.corp' });
  assert.equal((await inspectAddress('team.example.com', { lookup: publicLookup })).encrypted, true, '没写协议时按 https');
  await assert.rejects(inspectAddress('http://8.8.8.8:8730'), error => error.code === 'INSECURE');
  assert.equal((await inspectAddress('http://10.0.0.5:8730')).private, true);
});

test('服务端接口版本对不上时说清楚该升级哪一边', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wwe-proto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetchImpl = async () => new Response(JSON.stringify({ product: 'whalewing-enterprise', protocol: 2, serverVersion: '0.3.0-rc.1.1', setupRequired: false, orgName: '新公司' }), { status: 200 });
  const engine = new Engine({ baseDir: dir, credentials: fakeCredentials(), credentialKey: 'k', personal: fakePersonal(), fetchImpl, log: () => {} });
  await assert.rejects(engine.probe({ address: 'http://127.0.0.1:9' }), error => error.code === 'PROTOCOL' && /升级/.test(error.message));
  const notOurs = new Engine({ baseDir: dir, credentials: fakeCredentials(), credentialKey: 'k', personal: fakePersonal(), log: () => {},
    fetchImpl: async () => new Response('<html>别的网站</html>', { status: 200 }) });
  await assert.rejects(notOurs.probe({ address: 'http://127.0.0.1:9' }), error => error.code === 'SERVER');
});

test('服务端发来路径不对的清单时什么都不写到缓存外面', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wwe-evil-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const me = { user: { id: 1, username: 'a', displayName: 'a', role: 'member', departmentId: null, status: 'active' }, department: null, org: { name: '坏公司', offlineDays: 7 } };
  const hash = 'a'.repeat(64);
  const fetchImpl = async url => {
    if (url.endsWith('/hello')) return new Response(JSON.stringify({ product: 'whalewing-enterprise', protocol: 1, serverVersion: 'x', setupRequired: false, orgName: '坏公司' }));
    if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ token: 'x'.repeat(40), expiresAt: new Date().toISOString(), me }));
    if (url.endsWith('/sync')) return new Response(JSON.stringify({ revision: 1, generatedAt: '', me, items: [{ kind: 'skill', slug: 'evil', title: 'x', description: '', revision: 1, canMaintain: false, files: [{ path: '../../escape.txt', hash, size: 1 }] }] }));
    return new Response('x');
  };
  const engine = new Engine({ baseDir: path.join(dir, 'client'), credentials: fakeCredentials(), credentialKey: 'k', personal: fakePersonal(), fetchImpl, log: () => {} });
  await engine.start();
  t.after(() => engine.close());
  await assert.rejects(engine.login({ address: 'http://127.0.0.1:9', username: 'a', password: 'b' }), error => error.code === 'INVALID_INPUT');
  assert.ok(!existsSync(path.join(dir, 'escape.txt')));
  assert.ok(!existsSync(path.join(dir, 'client', 'escape.txt')));
});
