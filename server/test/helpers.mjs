import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

export const SETUP_CODE = '1234-5678';
export const OWNER = { username: 'owner', displayName: '王所有者', password: 'owner-pass-1' };

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
