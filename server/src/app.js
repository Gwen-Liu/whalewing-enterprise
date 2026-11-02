import Fastify from 'fastify';
import { z } from 'zod';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { API_PREFIX, ApiError, apiError, CATEGORIES, KINDS, schemas } from '@whalewing-enterprise/shared';
import { openDatabase } from './db.js';
import { Audit } from './audit.js';
import { Org, SESSION_TTL } from './org.js';
import { Roles } from './roles.js';
import { Work } from './work.js';
import { Content } from './content.js';
import { safeEqual, setupCode as makeSetupCode, sha256 } from './secrets.js';
import { joinPage, missingAdminPage } from './pages.js';

const ADMIN_COOKIE = 'wwe_admin';
const ADMIN_HEADER = 'x-whalewing-admin';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
// 接口校验没写专门说明的地方，用 zod 自带的中文说明，不把英文报错给人看。只在服务端进程里设，员工端用的是 DSH 自带的 zod，不动它。
z.config(z.locales.zhCN());

const PAGE_CSP ="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** 校验请求；不合格时把第一条原因说给人听。 */
export function parse(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue.path.length ? `${issue.path.join('.')}：` : '';
  throw apiError('INVALID_INPUT', `${where}${issue.message}`);
}

/** 构建好的管理端网页：启动时把文件读进内存，按固定的文件表提供，不按请求路径去拼磁盘路径。 */
function loadStatic(dir) {
  const files = new Map();
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name), rel = prefix + entry.name;
      if (entry.isDirectory()) walk(full, rel + '/');
      else if (entry.isFile()) {
        const body = readFileSync(full);
        files.set(rel, { body, type: TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream', etag: `"${sha256(body).slice(0, 32)}"` });
      }
    }
  };
  try { if (statSync(dir).isDirectory()) walk(dir, ''); } catch { /* 还没构建管理端 */ }
  return files;
}

export async function createApp(options) {
  const { dataDir, version, trustProxy = false, logger = false, adminDir, setupCode: fixedSetupCode } = options;
  const notes = [];
  const log = message => { notes.push(message); options.onLog?.(message); };
  const db = openDatabase(dataDir, { log });
  const audit = new Audit(db);
  const org = new Org(db, { version, audit });
  const roles = new Roles(db, { org, audit });
  org.roles = roles;
  const work = new Work(db, { org, roles, audit, clock: options.clock });
  const content = new Content(db, { contentDir: path.join(dataDir, 'content'), tmpDir: path.join(dataDir, 'tmp'), org, audit });
  const setupFile = path.join(dataDir, 'setup-code.txt');
  let setupCode = null;
  if (!org.isSetUp) {
    setupCode = fixedSetupCode ?? makeSetupCode();
    writeFileSync(setupFile, `${setupCode}\n`, { mode: 0o600 });
    log(`还没有初始化。打开管理端，填写初始化码 ${setupCode}（也写在 ${setupFile}）`);
  }

  // 每个请求的日志是 info 级别，默认只开 warn，不刷屏。
  const app = Fastify({ logger, trustProxy, bodyLimit: 256 * 1024, return503OnClosing: true });
  app.decorate('enterprise', { db, org, roles, work, content, audit });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true, max: 600, timeWindow: '1 minute',
    errorResponseBuilder: () => new ApiError('RATE_LIMITED'),
  });

  app.setErrorHandler((error, request, reply) => {
    let failure = error;
    if (!(error instanceof ApiError)) {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') failure = apiError('TOO_LARGE');
      else if (error.statusCode === 429) failure = apiError('RATE_LIMITED');
      else if (error.statusCode && error.statusCode < 500) failure = apiError('INVALID_INPUT', error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? '请求要用 JSON 格式' : undefined);
      else if (error.code === 'INVALID_INPUT') failure = apiError('INVALID_INPUT', error.message);
      else { request.log.error(error); options.onError?.(error); failure = apiError('INTERNAL'); }
    }
    reply.code(failure.status).send({ error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个地址' } });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (request.protocol === 'https') reply.header('strict-transport-security', 'max-age=15552000');
    const type = String(reply.getHeader('content-type') ?? '');
    if (!reply.getHeader('content-security-policy') && type.startsWith('text/html')) reply.header('content-security-policy', PAGE_CSP);
    if (request.url.startsWith(API_PREFIX)) reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
    return payload;
  });

  // ---------- 登录校验 ----------

  const bearer = request => {
    const header = request.headers.authorization;
    return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  };
  const adminSession = request => {
    const token = request.cookies[ADMIN_COOKIE];
    if (!token) throw apiError('AUTH_REQUIRED');
    // 管理端用 Cookie 登录；会改东西的请求还要带自定义请求头，别的网站的页面带不上，防跨站提交。
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers[ADMIN_HEADER] !== '1') throw apiError('CSRF');
    return { ...org.authenticate(token, 'admin'), token, kind: 'admin' };
  };
  const pluginSession = request => {
    const token = bearer(request);
    return { ...org.authenticate(token, 'plugin'), token, kind: 'plugin' };
  };
  // 员工端和管理端都能用的接口：带了令牌就按员工端，否则看管理端的 Cookie。
  const anySession = request => bearer(request) ? pluginSession(request) : adminSession(request);
  const requireSetUp = () => { if (!org.isSetUp) throw apiError('SETUP_REQUIRED'); };
  const setAdminCookie = (request, reply, token) => reply.setCookie(ADMIN_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'strict', secure: request.protocol === 'https', maxAge: SESSION_TTL.admin / 1000,
  });
  const strict = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const kindParam = request => {
    const { kind } = request.params;
    if (!KINDS.includes(kind)) throw apiError('NOT_FOUND');
    return kind;
  };
  const origin = request => org.settings().publicUrl ?? `${request.protocol}://${request.host}`;

  // ---------- 公开 ----------

  app.get(`${API_PREFIX}/hello`, async () => org.hello());

  app.get(`${API_PREFIX}/invites/:code`, strict, async request => org.inviteInfo(String(request.params.code)));

  app.post(`${API_PREFIX}/setup`, strict, async (request, reply) => {
    const input = parse(schemas.setupInput, request.body);
    if (org.isSetUp || !setupCode) throw apiError('SETUP_DONE');
    if (!safeEqual(input.setupCode.replace(/\s/g, ''), setupCode)) throw apiError('SETUP_CODE');
    const first = await org.setup(input);
    setupCode = null;
    rmSync(setupFile, { force: true });
    const session = org.createSession(first.id, 'admin');
    setAdminCookie(request, reply, session.token);
    return { me: session.me, expiresAt: session.expiresAt };
  });

  // ---------- 登录 ----------

  app.post(`${API_PREFIX}/auth/login`, strict, async (request, reply) => {
    const input = parse(schemas.loginInput, request.body);
    const session = await org.login(input, request.ip);
    if (input.client === 'admin') {
      setAdminCookie(request, reply, session.token);
      return { me: session.me, expiresAt: session.expiresAt };
    }
    return session;
  });

  app.post(`${API_PREFIX}/auth/join`, strict, async request => org.join(parse(schemas.joinInput, request.body)));

  app.post(`${API_PREFIX}/auth/logout`, async (request, reply) => {
    org.logout(bearer(request));
    const cookieToken = request.cookies[ADMIN_COOKIE];
    if (cookieToken && request.headers[ADMIN_HEADER] === '1') org.logout(cookieToken);
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get(`${API_PREFIX}/me`, async request => org.me(anySession(request).user));

  app.post(`${API_PREFIX}/me/password`, strict, async request => {
    const session = anySession(request);
    const input = parse(schemas.changePasswordInput, request.body);
    await org.changeOwnPassword(session.user, input.oldPassword, input.newPassword, sha256(session.token));
    return { ok: true };
  });

  // ---------- 同步和内容 ----------

  app.get(`${API_PREFIX}/sync`, async (request, reply) => {
    const { user } = anySession(request);
    const manifest = content.manifest(user);
    const me = org.me(user);
    const etag = `"${sha256(JSON.stringify({ me, items: manifest.items })).slice(0, 40)}"`;
    reply.header('etag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return { revision: manifest.revision, generatedAt: new Date().toISOString(), me, items: manifest.items };
  });

  const fileRoute = `${API_PREFIX}/items/:kind/:slug/files/*`;
  app.get(fileRoute, async (request, reply) => {
    const { user } = anySession(request);
    const file = await content.readFile(user, kindParam(request), request.params.slug, request.params['*']);
    reply.header('etag', `"${file.hash}"`);
    reply.header('x-content-hash', file.hash);
    // 文件内容是团队成员写的，浏览器直接打开时不让它当网页执行。
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.type(file.path.toLowerCase().endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
    return reply.send(file.buffer);
  });

  app.put(fileRoute, { bodyLimit: 8 * 1024 * 1024 }, async request => {
    const { user } = anySession(request);
    const input = parse(schemas.writeFileInput, request.body);
    return content.writeFile(user, kindParam(request), request.params.slug, request.params['*'], input);
  });

  app.delete(fileRoute, async request => {
    const { user } = anySession(request);
    const baseHash = typeof request.query.baseHash === 'string' ? request.query.baseHash : null;
    await content.deleteFile(user, kindParam(request), request.params.slug, request.params['*'], baseHash);
    return { ok: true, revision: content.revision() };
  });

  // ---------- 企业管理：事项和项目（员工端和管理端都用） ----------

  const id = request => {
    const value = Number(request.params.id);
    if (!Number.isInteger(value) || value <= 0) throw apiError('NOT_FOUND');
    return value;
  };
  const w = `${API_PREFIX}/work`;
  const accessOf = request => { requireSetUp(); const session = anySession(request); return { access: roles.access(session.user), kind: session.kind }; };
  // 经谁改的只是记录用：管理端网页一律算本人操作；员工端经小鲸或专家调工具时带 via。
  const viaOf = (kind, body) => kind === 'admin' || !body?.via ? { kind: 'ui' } : body.via;
  const positive = value => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : undefined; };
  const filtersOf = query => ({
    assigneeId: positive(query.assigneeId), projectId: positive(query.projectId), departmentId: positive(query.departmentId),
    typeId: positive(query.typeId), waitingOn: positive(query.waitingOn),
    category: ['open', ...CATEGORIES].includes(query.category) ? query.category : undefined,
    overdue: query.overdue === '1' || query.overdue === 'true',
    q: typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : undefined,
    limit: positive(query.limit), offset: Number(query.offset) > 0 ? Math.floor(Number(query.offset)) : 0,
  });

  app.get(`${w}/context`, async request => {
    const { access } = accessOf(request);
    const settings = org.settings();
    return {
      ...work.calendar(), workVisibility: settings.workVisibility, timeZone: settings.timeZone,
      access: access.describe(departmentId => org.department(departmentId)?.name),
      types: work.types(),
    };
  });
  // 选负责人、协作人用的名单：启用的人和部门树（只有名字和部门）。
  app.get(`${w}/directory`, async request => {
    const { access } = accessOf(request);
    return {
      users: org.users().filter(user => user.status === 'active').map(user => ({ id: user.id, username: user.username, displayName: user.displayName, departmentId: user.departmentId, inScope: access.inScope(user.id) })),
      departments: org.departments().map(department => ({ id: department.id, name: department.name, parentId: department.parentId })),
    };
  });
  app.get(`${w}/mine`, async request => work.mine(accessOf(request).access));
  app.get(`${w}/items`, async request => work.search(accessOf(request).access, filtersOf(request.query)));
  app.get(`${w}/items/:id`, async request => work.get(accessOf(request).access, id(request)));
  app.post(`${w}/items`, async request => {
    const { access, kind } = accessOf(request);
    const input = parse(schemas.workItemCreate, request.body);
    return work.create(access, input, { via: viaOf(kind, input) });
  });
  app.patch(`${w}/items/:id`, async request => {
    const { access, kind } = accessOf(request);
    const input = parse(schemas.workItemUpdate, request.body);
    return work.update(access, id(request), input, { via: viaOf(kind, input) });
  });
  app.post(`${w}/items/:id/comments`, async request => {
    const { access, kind } = accessOf(request);
    const input = parse(schemas.workComment, request.body);
    return work.comment(access, id(request), input.text, { via: viaOf(kind, input) });
  });
  app.delete(`${w}/items/:id`, async request => { work.remove(accessOf(request).access, id(request)); return { ok: true }; });
  app.get(`${w}/board`, async request => {
    const { access, kind } = accessOf(request);
    const query = request.query;
    // 管理端的全局看板连自己一起算；员工端的看板不含自己（自己的在“我的工作”里）。
    return work.board(access, { departmentId: positive(query.departmentId) ?? null, projectId: positive(query.projectId) ?? null, includeSelf: kind === 'admin' });
  });
  app.get(`${w}/export`, async (request, reply) => {
    const csv = work.exportCsv(accessOf(request).access, filtersOf(request.query));
    reply.header('content-disposition', `attachment; filename="work-items-${work.calendar().today}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(csv);
  });
  app.get(`${w}/projects`, async request => ({ projects: work.projects(accessOf(request).access) }));
  app.post(`${w}/projects`, async request => work.createProject(accessOf(request).access, parse(schemas.projectInput, request.body)));
  app.patch(`${w}/projects/:id`, async request => work.updateProject(accessOf(request).access, id(request), parse(schemas.projectUpdate, request.body)));
  app.delete(`${w}/projects/:id`, async request => { work.deleteProject(accessOf(request).access, id(request)); return { ok: true }; });

  // ---------- 管理 ----------

  const admin = `${API_PREFIX}/admin`;
  const asAdmin = request => { requireSetUp(); return adminSession(request).user; };

  app.get(`${admin}/overview`, async request => {
    asAdmin(request);
    const users = org.users();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      settings: org.settings(),
      members: { total: users.length, active: users.filter(u => u.status === 'active').length, recentlySeen: users.filter(u => u.lastSeenAt && u.lastSeenAt > weekAgo).length },
      departments: org.departments().length,
      content: content.overview(),
      work: work.overview(),
      roles: roles.list().filter(role => role.notManaging > 0).map(role => ({ id: role.id, name: role.name, notManaging: role.notManaging })),
      recent: audit.list({ limit: 8 }),
      serverVersion: version,
    };
  });

  app.get(`${admin}/users`, async request => { asAdmin(request); return { users: org.users() }; });
  app.post(`${admin}/users`, async request => org.createUser(asAdmin(request), parse(schemas.createUserInput, request.body)));
  app.patch(`${admin}/users/:id`, async request => org.updateUser(asAdmin(request), id(request), parse(schemas.userUpdate, request.body)));
  app.post(`${admin}/users/:id/password`, strict, async request => {
    await org.resetPassword(asAdmin(request), id(request), parse(schemas.resetPasswordInput, request.body).password);
    return { ok: true };
  });

  app.get(`${admin}/departments`, async request => { asAdmin(request); return { departments: org.departmentsWithManagers() }; });
  app.put(`${admin}/departments/:id/managers`, async request => ({ managerIds: roles.setManagers(asAdmin(request), id(request), parse(schemas.managersInput, request.body).userIds) }));

  app.get(`${admin}/roles`, async request => { asAdmin(request); return { roles: roles.list() }; });
  app.post(`${admin}/roles`, async request => roles.create(asAdmin(request), parse(schemas.roleInput, request.body)));
  app.patch(`${admin}/roles/:id`, async request => roles.update(asAdmin(request), id(request), parse(schemas.roleUpdate, request.body)));
  app.delete(`${admin}/roles/:id`, async request => { roles.remove(asAdmin(request), id(request)); return { ok: true }; });

  app.get(`${admin}/work-types`, async request => { asAdmin(request); return { types: work.types({ includeArchived: true }) }; });
  app.post(`${admin}/work-types`, async request => work.createType(asAdmin(request), parse(schemas.workTypeInput, request.body)));
  app.patch(`${admin}/work-types/:id`, async request => work.updateType(asAdmin(request), id(request), parse(schemas.workTypeUpdate, request.body)));
  app.delete(`${admin}/work-types/:id`, async request => { work.deleteType(asAdmin(request), id(request)); return { ok: true }; });

  app.get(`${admin}/work/trash`, async request => { asAdmin(request); return { items: work.trash() }; });
  app.post(`${admin}/work/items/:id/restore`, async request => work.restore(roles.access(asAdmin(request)), id(request)));
  app.post(`${admin}/work/import`, { bodyLimit: 8 * 1024 * 1024 }, async request => work.importRows(roles.access(asAdmin(request)), parse(schemas.importInput, request.body)));
  app.post(`${admin}/departments`, async request => org.createDepartment(asAdmin(request), parse(schemas.departmentInput, request.body)));
  app.patch(`${admin}/departments/:id`, async request => org.updateDepartment(asAdmin(request), id(request), parse(schemas.departmentUpdate, request.body)));
  app.delete(`${admin}/departments/:id`, async request => { org.deleteDepartment(asAdmin(request), id(request)); return { ok: true }; });

  app.get(`${admin}/invites`, async request => { asAdmin(request); return { invites: org.invites() }; });
  app.post(`${admin}/invites`, async request => {
    const invite = org.createInvite(asAdmin(request), parse(schemas.inviteInput, request.body));
    return { invite, link: `${origin(request)}/join/${invite.code}` };
  });
  app.delete(`${admin}/invites/:id`, async request => org.revokeInvite(asAdmin(request), id(request)));

  app.get(`${admin}/items`, async request => {
    asAdmin(request);
    const kind = request.query.kind;
    if (kind !== undefined && !KINDS.includes(kind)) throw apiError('INVALID_INPUT', '没有这种内容');
    return { items: content.items(kind) };
  });
  app.post(`${admin}/items`, async request => content.createItem(asAdmin(request), parse(schemas.itemInput, request.body)));
  app.get(`${admin}/items/:kind/:slug`, async request => {
    asAdmin(request);
    const item = content.item(kindParam(request), request.params.slug);
    if (!item) throw apiError('NOT_FOUND');
    return { item: content.describe(item), files: content.files(item.id) };
  });
  app.patch(`${admin}/items/:kind/:slug`, async request => content.updateItem(asAdmin(request), kindParam(request), request.params.slug, parse(schemas.itemUpdate, request.body)));
  app.delete(`${admin}/items/:kind/:slug`, async request => {
    await content.deleteItem(asAdmin(request), kindParam(request), request.params.slug);
    return { ok: true };
  });
  app.post(`${admin}/items/skill/:slug/archive`, { bodyLimit: 30 * 1024 * 1024 }, async request => {
    const actor = asAdmin(request);
    const archive = typeof request.body?.archive === 'string' ? Buffer.from(request.body.archive, 'base64') : null;
    if (!archive?.length) throw apiError('INVALID_INPUT', '请选择 zip 压缩包');
    return content.replaceSkillArchive(actor, request.params.slug, archive);
  });

  app.get(`${admin}/settings`, async request => { asAdmin(request); return org.settings(); });
  app.patch(`${admin}/settings`, async request => org.updateSettings(asAdmin(request), parse(schemas.settingsUpdate, request.body)));

  app.get(`${admin}/audit`, async request => {
    asAdmin(request);
    const query = request.query;
    return { entries: audit.list({ limit: Number(query.limit) || 50, before: Number(query.before) || undefined, action: typeof query.action === 'string' ? query.action : undefined, actorId: Number(query.actorId) || undefined }) };
  });

  // ---------- 网页 ----------

  const staticFiles = adminDir ? loadStatic(adminDir) : new Map();
  app.get('/', async (request, reply) => reply.redirect('/admin/'));
  app.get('/admin', async (request, reply) => reply.redirect('/admin/'));
  app.get('/admin/*', async (request, reply) => {
    if (!staticFiles.size) return reply.type('text/html; charset=utf-8').send(missingAdminPage());
    const rel = request.params['*'];
    let file = staticFiles.get(rel);
    if (!file && !path.extname(rel)) file = staticFiles.get('index.html');
    if (!file) return reply.code(404).type('text/plain; charset=utf-8').send('没有这个文件');
    reply.header('etag', file.etag);
    reply.header('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.headers['if-none-match'] === file.etag) return reply.code(304).send();
    return reply.type(file.type).send(file.body);
  });
  app.get('/join/:code', async (request, reply) => {
    let info = null, problem = null;
    try { info = org.inviteInfo(String(request.params.code)); } catch (error) { problem = error.message; }
    return reply.type('text/html; charset=utf-8').send(joinPage({ info, problem, version, link: `${origin(request)}/join/${request.params.code}` }));
  });

  const timer = setInterval(() => { try { org.pruneSessions(); } catch (error) { options.onError?.(error); } }, 60 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); db.close(); });

  return { app, db, org, roles, work, content, audit, notes, get setupCode() { return setupCode; } };
}
