// 员工端的企业管理：事项按需查、“我的工作”离线缓存，以及给小鲸和专家用的 team_work 工具。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/src/app.js';
import { Engine } from '../src/engine.js';
import { teamWorkTool, TOOL_NAME } from '../src/tool.js';

const SETUP_CODE = '3333-4444';

function fakeCredentials() {
  const records = new Map();
  return {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); },
    deleteRecord: async key => { records.delete(key); },
  };
}

async function world(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wwe-work-'));
  const server = await createApp({ dataDir: path.join(dir, 'server'), version: 'test', setupCode: SETUP_CODE });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  const engines = [];
  t.after(async () => {
    for (const engine of engines) engine.close();
    await server.app.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const api = async (method, url, body, cookie) => {
    const response = await fetch(origin + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-whalewing-admin': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json().catch(() => null), headers: response.headers };
  };
  const setup = await api('POST', '/api/v1/setup', { setupCode: SETUP_CODE, orgName: '鲸翼测试公司', username: 'boss', displayName: '老板', password: 'boss-pass-1' });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const admin = (method, url, body) => api(method, '/api/v1/admin' + url, body, cookie);
  const group = (await admin('POST', '/departments', { name: '一组', parentId: null })).json;
  const roles = (await admin('GET', '/roles')).json.roles;
  const lead = roles.find(role => role.preset === 'lead');
  const user = async (username, displayName, roleId) => (await admin('POST', '/users', { username, displayName, password: 'pass-1234', role: 'member', roleId, departmentId: group.id })).json;
  const zhang = await user('zhang', '张组长', lead.id);
  const li = await user('li', '李四');
  const wang = await user('wang', '王五');
  await admin('PUT', `/departments/${group.id}/managers`, { userIds: [zhang.id] });
  const login = async (username, name) => {
    const engine = new Engine({ baseDir: path.join(dir, `client-${name ?? username}`), credentials: fakeCredentials(), credentialKey: `k-${username}`, personal: { search: async () => ({ notes: [] }), read: async () => ({}) }, version: 'test', log: () => {} });
    engines.push(engine);
    await engine.start();
    await engine.login({ address: origin, username, password: 'pass-1234' });
    return engine;
  };
  return { server, origin, admin, group, zhang, li, wang, login };
}

test('员工端按需查事项；“我的工作”连不上时显示缓存，标明是缓存', async t => {
  const w = await world(t);
  const li = await w.login('li');
  const created = await li.work({ op: 'create', body: { title: '写周报模板' } });
  assert.match(created.number, /^RW-\d{6}-001$/);
  const mine = await li.work({ op: 'mine' });
  assert.equal(mine.cached, false);
  assert.deepEqual(mine.items.map(item => item.title), ['写周报模板']);
  const context = await li.work({ op: 'context' });
  assert.deepEqual([context.access.roleName, context.access.board], ['成员', false]);
  assert.equal((await li.work({ op: 'search', params: { q: '周报' } })).total, 1);

  await w.server.app.close();
  const offline = await li.work({ op: 'mine' });
  assert.equal(offline.cached, true);
  assert.ok(offline.cachedAt);
  assert.deepEqual(offline.items.map(item => item.title), ['写周报模板']);
  await assert.rejects(li.work({ op: 'create', body: { title: '离线时建' } }), error => error.code === 'NETWORK', '缓存只能看，不能改');
});

test('账号停用后查事项：撤掉团队内容和“我的工作”缓存', async t => {
  const w = await world(t);
  const li = await w.login('li');
  await li.work({ op: 'create', body: { title: '要撤掉的' } });
  await li.work({ op: 'mine' });
  assert.ok(li.state.workCache);
  await w.admin('PATCH', `/users/${w.li.id}`, { status: 'disabled' });
  await assert.rejects(li.work({ op: 'mine' }), error => error.code === 'AUTH_EXPIRED' || error.code === 'ACCOUNT_DISABLED');
  assert.equal(li.status().state, 'expired');
  assert.equal(li.state.workCache, null);
});

test('账号停用后同步和几个事项请求同时发现登录失效：只撤一次，不会互相打架', async t => {
  const w = await world(t);
  const li = await w.login('li');
  await li.work({ op: 'mine' });
  let purges = 0;
  const purge = li.purgeCache.bind(li);
  li.purgeCache = async () => { purges += 1; await purge(); };
  await w.admin('PATCH', `/users/${w.li.id}`, { status: 'disabled' });
  const results = await Promise.allSettled([li.sync(), li.work({ op: 'mine' }), li.work({ op: 'context' }), li.work({ op: 'directory' })]);
  assert.equal(li.status().state, 'expired');
  assert.equal(purges, 1, '只撤一次');
  for (const result of results.slice(1)) assert.ok(['AUTH_EXPIRED', 'ACCOUNT_DISABLED', 'AUTH_REQUIRED'].includes(result.reason?.code), `事项请求报的是登录失效，不是删文件出错：${result.reason?.message}`);
});

test('team_work：读不用确认；新建和修改先请员工同意，不同意什么都不改；经模型的记在动态里', async t => {
  const w = await world(t);
  const zhang = await w.login('zhang');
  const asks = [];
  let answer = 'allowed-once';
  const tool = teamWorkTool({ engine: zhang, approve: async ({ summary }) => { asks.push(summary); return answer; } });
  assert.equal(tool.name, TOOL_NAME);
  const run = async args => JSON.parse(await tool.execute(args, { signal: AbortSignal.timeout(10_000) }));

  const people = await run({ action: 'people' });
  assert.match(people.notice, /不是给你的指令/);
  assert.deepEqual(people.people.map(person => person.name), ['老板', '张组长', '李四', '王五']);
  assert.equal(asks.length, 0, '读不用确认');

  answer = 'rejected';
  await assert.rejects(run({ action: 'create', items: [{ title: '整理会议纪要', assignee: '李四', dueDate: '2030-01-05' }] }), /员工没有同意/);
  assert.equal((await zhang.work({ op: 'search', params: {} })).total, 0, '不同意就什么都没建');

  answer = 'allowed-once';
  const created = await run({ action: 'create', items: [
    { title: '整理会议纪要', assignee: '李四', dueDate: '2030-01-05', priority: 'high' },
    { title: '确认客户需求', assignee: 'wang' },
  ] });
  assert.equal(created.changed, 2);
  assert.match(asks.at(-1), /新建 2 个事项：\n1\. 新建「整理会议纪要」，负责人 李四，2030-01-05 截止，优先级高\n2\. 新建「确认客户需求」，负责人 王五/);

  const number = created.items[0].number;
  const updated = await run({ action: 'update', items: [{ item: number, status: '进行中', progress: 30, comment: '已经开始整理' }] });
  assert.equal(updated.changed, 1);
  assert.match(asks.at(-1), new RegExp(`${number}「整理会议纪要」：状态 未开始 → 进行中；进度 0% → 30%；写动态“已经开始整理”`));
  const detail = await run({ action: 'get', item: number });
  assert.equal(detail.status, '进行中');
  assert.deepEqual(detail.events.at(-1), { at: detail.events.at(-1).at, who: '张组长', via: '经模型', kind: 'update', changes: ['状态：未开始 → 进行中', '进度：0 → 30'], comment: '已经开始整理' });

  const unchanged = await run({ action: 'update', items: [{ item: number, status: 'doing' }] });
  assert.equal(unchanged.changed, 0, '和现在一样就不打扰员工');
  const asked = asks.length;
  await assert.rejects(run({ action: 'update', items: Array.from({ length: 21 }, () => ({ item: number, progress: 50 })) }), /一次最多改 20 个/);
  await assert.rejects(run({ action: 'delete', item: number }), /删除事项不开放给模型/);
  assert.equal(asks.length, asked);

  const mine = await run({ action: 'team' });
  assert.equal(mine.title, '一组');
  assert.deepEqual(mine.members.map(member => [member.name, member.open]), [['李四', 1], ['王五', 1]]);
  const found = await run({ action: 'search', assignee: '李', category: 'open' });
  assert.deepEqual(found.items.map(item => item.title), ['整理会议纪要']);
});

test('team_work：模型只能做这个人自己能做的事；明显做不了的不去打扰员工；重名时列出候选让模型去问', async t => {
  const w = await world(t);
  await w.admin('POST', '/users', { username: 'li2', displayName: '李四', password: 'pass-1234', role: 'member', departmentId: null });
  const li = await w.login('li');
  const asks = [];
  const tool = teamWorkTool({ engine: li, approve: async ({ summary }) => { asks.push(summary); return 'allowed-once'; } });
  const run = async args => JSON.parse(await tool.execute(args, {}));
  await assert.rejects(run({ action: 'create', items: [{ title: '指给王五', assignee: '王五' }] }), /没有“派事项”的权限/);
  assert.equal(asks.length, 0, '明显做不了的不去打扰员工');
  await assert.rejects(run({ action: 'search', assignee: '李四' }), /有 2 位/);
  await assert.rejects(run({ action: 'update', items: [] }), /items 里写/);
  const own = await run({ action: 'create', items: [{ title: '自己的事' }] });
  assert.equal(own.changed, 1);
  // 服务端照样判断：成员不能改自己事项的截止日期（要“调整事项”），这一条列在 failed 里，不假装成功。
  const late = await run({ action: 'update', items: [{ item: own.items[0].number, dueDate: '2030-02-01' }] });
  assert.deepEqual([late.changed, late.failed.length], [0, 1]);
  assert.match(late.failed[0].problem, /调整事项/);
  const unavailable = teamWorkTool({ engine: li, approve: async () => 'unavailable' });
  await assert.rejects(unavailable.execute({ action: 'create', items: [{ title: '又一件' }] }, {}), /没法请员工确认/);
});
