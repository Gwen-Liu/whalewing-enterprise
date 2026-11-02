import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

export const SETUP_CODE = '1234-5678';
export const OWNER = { username: 'owner', displayName: '王管理', password: 'owner-pass-1' };

/** 一个临时数据目录里的服务端；返回带登录状态的请求小工具。 */
export async function server(t, { setup = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wwe-test-'));
  const instance = await createApp({ dataDir, version: '0.0.0-test', setupCode: SETUP_CODE });
  t.after(async () => { await instance.app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (method, url, { body, token, cookie, csrf = true, headers = {} } = {}) => {
    const response = await instance.app.inject({
      method, url,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(cookie && csrf ? { 'x-whalewing-admin': '1' } : {}),
        ...headers,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = response.json(); } catch { /* 不是 JSON */ }
    return { status: response.statusCode, json, headers: response.headers, body: response.body };
  };
  const result = { ...instance, dataDir, request };
  if (setup) {
    const done = await request('POST', '/api/v1/setup', { body: { setupCode: SETUP_CODE, orgName: '鲸翼测试公司', ...OWNER } });
    if (done.status !== 200) throw new Error(`初始化失败：${done.body}`);
    result.adminCookie = cookieOf(done);
  }
  return result;
}

export function cookieOf(response) {
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ? first.split(';')[0] : null;
}

/** 管理员建一个成员并用员工端登录，返回令牌和成员信息。 */
export async function member(s, { username, departmentId = null, role = 'member', password = 'member-pass-1' }) {
  const created = await s.request('POST', '/api/v1/admin/users', { cookie: s.adminCookie, body: { username, displayName: username, password, role, departmentId } });
  if (created.status !== 200) throw new Error(`建成员失败：${created.body}`);
  const login = await s.request('POST', '/api/v1/auth/login', { body: { username, password, client: 'plugin' } });
  if (login.status !== 200) throw new Error(`登录失败：${login.body}`);
  return { user: created.json, token: login.json.token };
}

const admin = (s, method, url, body) => s.request(method, '/api/v1/admin' + url, { cookie: s.adminCookie, body });

/** 照设计里的例子建组织：交付中心（乙）下面一组（丙；丁、戊）、二组（己；庚）。 */
export async function designOrg(s) {
  const dept = async (name, parentId = null) => (await admin(s, 'POST', '/departments', { name, parentId })).json;
  const center = await dept('交付中心');
  const one = await dept('一组', center.id);
  const two = await dept('二组', center.id);
  const roles = (await admin(s, 'GET', '/roles')).json.roles;
  const lead = roles.find(role => role.preset === 'lead');
  const team = (await admin(s, 'POST', '/roles', { name: '小组长', scope: 'managed', permissions: ['item.create', 'item.assign', 'item.adjust', 'board.view', 'project.manage'] })).json;
  const people = {};
  const add = async (key, departmentId, roleId) => {
    people[key] = await member(s, { username: key, departmentId });
    if (roleId) await admin(s, 'PATCH', `/users/${people[key].user.id}`, { roleId });
  };
  await add('yi', center.id, lead.id);
  await add('bing', one.id, team.id);
  await add('ding', one.id);
  await add('wu', one.id);
  await add('ji', two.id, team.id);
  await add('geng', two.id);
  await admin(s, 'PUT', `/departments/${center.id}/managers`, { userIds: [people.yi.user.id] });
  await admin(s, 'PUT', `/departments/${one.id}/managers`, { userIds: [people.bing.user.id] });
  await admin(s, 'PUT', `/departments/${two.id}/managers`, { userIds: [people.ji.user.id] });
  return { center, one, two, lead, team, people };
}
