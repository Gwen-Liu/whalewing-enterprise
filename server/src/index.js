import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '@whalewing-enterprise/shared';
import { createApp } from './app.js';
import { backupDatabase, openDatabase, transaction } from './db.js';
import { Audit } from './audit.js';
import { Org } from './org.js';
import { Roles } from './roles.js';
import { Work } from './work.js';
import { hashPassword, randomToken } from './secrets.js';

export { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageInfo = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
export const defaultAdminDir = path.join(here, '..', 'admin-dist');

/** 按命令行参数 > 环境变量 > 数据目录里的 server.json > 默认值 决定设置。 */
export function resolveOptions(args = {}, env = process.env) {
  const dataDir = path.resolve(args.data ?? env.WWE_DATA ?? 'data');
  let file = {};
  const configFile = path.join(dataDir, 'server.json');
  if (existsSync(configFile)) {
    try { file = JSON.parse(readFileSync(configFile, 'utf8')); }
    catch (error) { throw new Error(`${configFile} 不是有效的 JSON：${error.message}`); }
  }
  const port = Number(args.port ?? env.WWE_PORT ?? file.port ?? DEFAULTS.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`端口 ${port} 不对，要是 1 到 65535 之间的整数`);
  const trust = args.trustProxy ?? env.WWE_TRUST_PROXY ?? file.trustProxy ?? false;
  return {
    dataDir,
    port,
    host: args.host ?? env.WWE_HOST ?? file.host ?? '0.0.0.0',
    // 放在 Nginx、Caddy 后面时要打开，才能拿到员工的真实地址和 https。
    trustProxy: trust === true || trust === 'true' || trust === '1' ? true : (typeof trust === 'string' && trust && trust !== 'false' && trust !== '0' ? trust : false),
  };
}

export async function startServer(options, { print = console.log } = {}) {
  const { app, notes } = await createApp({
    dataDir: options.dataDir,
    version: packageInfo.version,
    trustProxy: options.trustProxy,
    adminDir: options.adminDir ?? defaultAdminDir,
    logger: options.logger ?? { level: 'warn' },
    onLog: print,
    onError: error => console.error(error),
  });
  await app.listen({ port: options.port, host: options.host });
  const shown = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
  print(`鲸翼企业版服务端 ${packageInfo.version} 已启动：http://${shown}:${options.port}/admin/`);
  print(`数据目录：${options.dataDir}`);
  return { app, notes };
}

// ---------- 系统之外的操作 ----------
// 超级管理员不是系统里的账号：能登上服务器、碰到数据目录的人（项目维护者，或企业管服务器的人）用下面的命令救急。

function withDatabase(dataDir, fn) {
  if (!existsSync(path.join(dataDir, 'whalewing-enterprise.db'))) throw new Error(`${dataDir} 里没有数据库，确认数据目录对不对`);
  const db = openDatabase(dataDir);
  try { return fn(db); } finally { db.close(); }
}

/**
 * 管理员全都登不上时重置密码：生成一个临时密码，作废这个人所有已登录的地方，清掉登录锁定。
 * makeAdmin 时顺便把他改成启用的管理员（所有管理员都被停用、或只剩成员时用）。
 */
export async function resetPasswordOffline(dataDir, username, { makeAdmin = false } = {}) {
  const password = randomToken(12);
  const hash = await hashPassword(password);
  return withDatabase(dataDir, db => {
    const user = db.prepare('SELECT id, username, display_name AS name, role, status FROM users WHERE username = ?').get(username);
    if (!user) throw new Error(`没有登录名是“${username}”的账号。现有的管理员：${db.prepare("SELECT username FROM users WHERE role = 'admin'").all().map(row => row.username).join('、') || '（没有）'}`);
    const at = new Date().toISOString();
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, at, user.id);
      if (makeAdmin) db.prepare("UPDATE users SET role = 'admin', role_id = NULL, status = 'active' WHERE id = ?").run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM login_failures WHERE key = ?').run('u:' + user.username.toLowerCase());
      new Audit(db).record(null, 'user.password', user.username, { by: '服务器命令行', makeAdmin });
    });
    return { username: user.username, password, admin: makeAdmin || user.role === 'admin' };
  });
}

/** 彻底删除回收站里的事项（网页里只能放进回收站和恢复）。 */
export function purgeTrashOffline(dataDir, { olderThanDays = 0 } = {}) {
  return withDatabase(dataDir, db => {
    const audit = new Audit(db);
    const org = new Org(db, { version: packageInfo.version, audit });
    const roles = new Roles(db, { org, audit });
    org.roles = roles;
    return new Work(db, { org, roles, audit }).purgeTrash({ olderThanDays });
  });
}

/** 备份：数据库拿一份一致的副本，团队内容整个复制。运行中也可以做。 */
export function backup(dataDir, outDir) {
  if (!existsSync(path.join(dataDir, 'whalewing-enterprise.db'))) throw new Error(`${dataDir} 里没有数据库，确认数据目录对不对`);
  const target = path.resolve(outDir ?? path.join(dataDir, 'backups', `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(target, { recursive: true });
  const db = openDatabase(dataDir);
  try { backupDatabase(db, path.join(target, 'whalewing-enterprise.db')); } finally { db.close(); }
  if (existsSync(path.join(dataDir, 'content'))) cpSync(path.join(dataDir, 'content'), path.join(target, 'content'), { recursive: true });
  if (existsSync(path.join(dataDir, 'server.json'))) cpSync(path.join(dataDir, 'server.json'), path.join(target, 'server.json'));
  return target;
}
