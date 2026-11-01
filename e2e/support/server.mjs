// 功能测试用的服务端：每个测试文件一个临时数据目录，在 127.0.0.1 的空闲端口上跑，测完删掉。
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/src/app.js';
import { defaultAdminDir, packageInfo } from '../../server/src/index.js';

export const SETUP_CODE = '2468-1357';
export const OWNER = Object.freeze({ username: 'owner', displayName: '王所有者', password: 'owner-pass-123' });
export const ORG = '鲸翼测试公司';

/** 启动服务端。setup 为真时先用接口初始化好企业和所有者，返回能直接调管理接口的 admin()。 */
export async function startServer({ setup = true } = {}) {
  if (!existsSync(path.join(defaultAdminDir, 'index.html'))) throw new Error('还没构建管理端网页，先在仓库根目录运行 npm run build');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wwe-e2e-server-'));
  let instance = await createApp({ dataDir, version: packageInfo.version, setupCode: SETUP_CODE, adminDir: defaultAdminDir });
  await instance.app.listen({ port: 0, host: '127.0.0.1' });
  const port = instance.app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  let cookie = null;
  const request = async (method, url, body) => {
    const response = await fetch(origin + '/api/v1' + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-whalewing-admin': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${url} 失败：${JSON.stringify(json)}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return json;
  };
  if (setup) await request('POST', '/setup', { setupCode: SETUP_CODE, orgName: ORG, ...OWNER });
  const file = (kind, slug, rel) => `/items/${kind}/${slug}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
  return {
    origin, dataDir, get instance() { return instance; },
    /** 用所有者身份调接口（造测试数据用，不走界面）。 */
    admin: request,
    /** 用所有者身份重新登录（改了所有者密码、作废了其他登录之后用）。 */
    relogin: () => request('POST', '/auth/login', { username: OWNER.username, password: OWNER.password, client: 'admin' }),
    putFile: (kind, slug, rel, content, baseHash = null) => request('PUT', file(kind, slug, rel), { content, baseHash }),
    /** 停掉服务端但保留数据（模拟员工连不上）。 */
    async pause() { await instance.app.close(); },
    /** 用同一个数据目录、同一个端口重新起来。 */
    async resume() {
      instance = await createApp({ dataDir, version: packageInfo.version, adminDir: defaultAdminDir });
      await instance.app.listen({ port, host: '127.0.0.1' });
    },
    readFile: rel => import('node:fs/promises').then(fs => fs.readFile(path.join(dataDir, 'content', rel), 'utf8')),
    async stop() {
      await instance.app.close().catch(() => {});
      for (let attempt = 0; ; attempt++) {
        try { await rm(dataDir, { recursive: true, force: true }); break; }
        catch (error) { if (attempt >= 10) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
      }
    },
  };
}
