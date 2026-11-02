// 员工端的核心：连接和登录、同步团队内容到本机缓存、给鲸翼个人版提供团队专家和团队知识。
// 不碰员工的个人知识、个人技能和会话；只有员工点“提交到团队”的那一篇才会发给服务端。
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  KIND_LABELS, PRODUCT, PROTOCOL_VERSION, SLUG, normalizeContentPath, parseExpertTemplate, parseInviteLink, renderExpertTemplate, schemas,
} from '@whalewing-enterprise/shared';
import { EnterpriseError, inspectAddress, request } from './net.js';

const DAY = 24 * 60 * 60 * 1000;
export const SYNC_INTERVAL = 10 * 60 * 1000;
const KIND_DIRS = { knowledge: 'knowledge', expert: 'experts', skill: 'skills' };
const AUTH_LOST = new Set(['AUTH_EXPIRED', 'AUTH_REQUIRED', 'ACCOUNT_DISABLED']);
const OFFLINE_CODES = new Set(['NETWORK', 'TIMEOUT', 'CERTIFICATE', 'SERVER', 'INTERNAL', 'RATE_LIMITED', 'SETUP_REQUIRED']);
const fail = (code, message) => new EnterpriseError(code, message);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });

function noteTitle(rel, content) {
  const heading = content.match(/^#\s+(.+?)\s*#*\s*$/m);
  return (heading ? heading[1] : path.posix.basename(rel, '.md')).slice(0, 120);
}

function excerptOf(content, terms) {
  const flat = content.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = terms.length ? Math.max(0, lower.indexOf(terms[0])) : 0;
  const start = Math.max(0, at - 60);
  return (start > 0 ? '…' : '') + flat.slice(start, start + 220) + (start + 220 < flat.length ? '…' : '');
}

async function writeAtomic(file, data, tmpDir) {
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const temp = path.join(tmpDir, randomUUID());
  await writeFile(temp, data);
  await rename(temp, file);
}

async function listFiles(dir, prefix = '') {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const result = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(path.join(dir, entry.name), rel));
    else result.push(rel);
  }
  return result;
}

async function removeEmptyDirs(dir, keep) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) if (entry.isDirectory()) await removeEmptyDirs(path.join(dir, entry.name), false);
  if (!keep) { try { await rmdir(dir); } catch { /* 不是空目录 */ } }
}

export class Engine {
  constructor({ baseDir, credentials, credentialKey, personal, version = '0.0.0', fetchImpl, lookup, now = () => Date.now(), onChange = () => {}, log = () => {} }) {
    mkdirSync(path.join(baseDir, 'cache', 'skills'), { recursive: true });
    // 用真实路径：DSH 报上来的技能位置是真实路径，登记的目录要是写成短文件名（如 QIANQI~1）或经过联接，
    // 鲸翼比较时对不上，会把团队技能当成不属于扩展而滤掉。
    const root = realpathSync.native(baseDir);
    this.baseDir = root;
    this.cacheDir = path.join(root, 'cache');
    this.tmpDir = path.join(root, 'tmp');
    // 技能缓存目录在登记扩展时交给鲸翼；DSH 会监听这个目录，同步时往里增删技能就行。
    this.skillsDir = path.join(this.cacheDir, 'skills');
    this.stateFile = path.join(root, 'state.json');
    this.credentials = credentials;
    this.credentialKey = credentialKey;
    this.personal = personal;
    this.version = version;
    this.net = { fetchImpl: fetchImpl ?? globalThis.fetch, lookup };
    this.now = now;
    this.onChange = onChange;
    this.log = log;
    this.state = null;
    this.notes = new Map();
    this.experts = [];
    this.syncing = null;
    this.closed = false;
    this.lifetime = new AbortController();
  }

  // ---------- 启动和收尾 ----------

  async start() {
    try { this.state = JSON.parse(await readFile(this.stateFile, 'utf8')); }
    catch { this.state = null; }
    if (this.state && this.state.version !== 1) this.state = null;
    await this.rebuild();
    if (this.state?.status === 'connected') this.sync().catch(error => this.log(`启动时同步失败：${error.message}`));
    this.timer = setInterval(() => {
      if (this.state?.status === 'connected') this.sync().catch(error => this.log(`定时同步失败：${error.message}`));
    }, SYNC_INTERVAL);
    this.timer.unref?.();
  }

  close() {
    this.closed = true;
    this.lifetime.abort(new Error('鲸翼企业版已关闭'));
    clearInterval(this.timer);
  }

  checkOpen() { if (this.closed) throw fail('CLOSED', '鲸翼企业版已关闭，请重新启用'); }

  async saveState() {
    if (this.state) await writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2), this.tmpDir);
    else await rm(this.stateFile, { force: true });
  }

  async token() {
    const record = await this.credentials.readRecord(this.credentialKey);
    return record?.kind === 'grant' && typeof record.payload?.token === 'string' ? record.payload.token : null;
  }

  async storeToken(token, origin) {
    await this.credentials.modifyRecord(this.credentialKey, async () => ({ kind: 'grant', payload: { token, server: origin } }));
  }

  // ---------- 状态 ----------

  status() {
    const s = this.state;
    if (!s) return { state: 'disconnected', version: this.version };
    const offline = s.status === 'connected' && s.lastError && OFFLINE_CODES.has(s.lastError.code);
    return {
      state: s.status === 'expired' ? 'expired' : offline ? 'offline' : 'connected',
      version: this.version,
      server: s.server.origin,
      encrypted: s.server.encrypted,
      private: s.server.private,
      me: s.me,
      lastOkAt: s.lastOkAt ?? null,
      lastAttemptAt: s.lastAttemptAt ?? null,
      lastError: s.lastError ?? null,
      hidden: Boolean(s.hidden),
      offlineDays: s.me?.org?.offlineDays ?? null,
      items: s.hidden ? [] : (s.items ?? []).map(item => ({
        kind: item.kind, slug: item.slug, title: item.title, description: item.description, revision: item.revision, canMaintain: item.canMaintain,
        files: item.files.map(file => ({ path: file.path, hash: file.hash, size: file.size })),
      })),
    };
  }

  // ---------- 连接 ----------

  async target(address) {
    return inspectAddress(address, { lookup: this.net.lookup });
  }

  async hello(target, signal) {
    const { json } = await request(target, 'GET', '/hello', { signal, fetchImpl: this.net.fetchImpl });
    const parsed = schemas.hello.safeParse(json);
    if (!parsed.success || json.product !== PRODUCT) throw fail('SERVER', '这个地址不是鲸翼企业版服务端，请核对地址');
    const hello = parsed.data;
    if (hello.setupRequired) throw fail('SETUP_REQUIRED', '这个服务端还没初始化，请管理员先打开管理端完成初始化');
    if (hello.protocol > PROTOCOL_VERSION) throw fail('PROTOCOL', `服务端比这个插件新（服务端 ${hello.serverVersion}），请把鲸翼企业版插件升级到同一版`);
    if (hello.protocol < PROTOCOL_VERSION) throw fail('PROTOCOL', `服务端版本太旧（${hello.serverVersion}），请管理员把服务端升级到 ${this.version} 或更新`);
    return hello;
  }

  /** 连接前先看清是哪家企业：返回企业名称、地址、是否加密，给员工确认。 */
  async probe({ address }, signal) {
    const invite = parseInviteLink(address);
    if (invite.ok) {
      const target = await this.target(invite.server.origin);
      const hello = await this.hello(target, signal);
      const { json } = await request(target, 'GET', `/invites/${invite.code}`, { signal, fetchImpl: this.net.fetchImpl });
      const info = schemas.inviteInfo.parse(json);
      return { mode: 'invite', server: target.origin, encrypted: target.encrypted, private: target.private, orgName: hello.orgName, department: info.department, role: info.role, roleName: info.roleName ?? null, expiresAt: info.expiresAt };
    }
    if (/\/join\//.test(address)) throw fail('ADDRESS', invite.reason);
    const target = await this.target(address);
    const hello = await this.hello(target, signal);
    return { mode: 'login', server: target.origin, encrypted: target.encrypted, private: target.private, orgName: hello.orgName };
  }

  async beginConnection(origin) {
    if (this.state?.status === 'connected') {
      if (this.state.server.origin !== origin) throw fail('CONNECTED', `已经连着“${this.state.me?.org?.name ?? this.state.server.origin}”。一个工作台只能连一家企业，先退出团队再加入别的`);
      throw fail('CONNECTED', '已经连上了');
    }
    // 之前登录过期过：换了服务器就把旧的缓存清掉。
    if (this.state && this.state.server.origin !== origin) await this.forget();
  }

  async connected(target, session) {
    await this.storeToken(session.token, target.origin);
    this.state = {
      version: 1, status: 'connected',
      server: { origin: target.origin, encrypted: target.encrypted, private: target.private, hostname: target.hostname },
      me: session.me, lastOkAt: null, lastAttemptAt: null, lastError: null, etag: null, items: [], hidden: false,
    };
    await this.saveState();
    await this.sync();
    return this.status();
  }

  async join({ address, username, displayName, password }, signal) {
    const invite = parseInviteLink(address);
    if (!invite.ok) throw fail('ADDRESS', invite.reason);
    const target = await this.target(invite.server.origin);
    await this.hello(target, signal);
    await this.beginConnection(target.origin);
    const { json } = await request(target, 'POST', '/auth/join', { body: { code: invite.code, username, displayName, password }, signal, fetchImpl: this.net.fetchImpl });
    return this.connected(target, schemas.session.parse(json));
  }

  async login({ address, username, password }, signal) {
    const target = await this.target(address);
    await this.hello(target, signal);
    await this.beginConnection(target.origin);
    const { json } = await request(target, 'POST', '/auth/login', { body: { username, password, client: 'plugin' }, signal, fetchImpl: this.net.fetchImpl });
    return this.connected(target, schemas.session.parse(json));
  }

  /** 退出团队：服务端作废令牌，本机删掉令牌和团队内容；个人内容不动。 */
  async leave() {
    if (!this.state) return this.status();
    const token = await this.token();
    if (token) {
      try { await request(await this.target(this.state.server.origin), 'POST', '/auth/logout', { token, fetchImpl: this.net.fetchImpl, timeoutMs: 4000 }); }
      catch (error) { this.log(`退出时没能通知服务端：${error.message}`); }
    }
    await this.forget();
    return this.status();
  }

  async forget() {
    await this.credentials.deleteRecord(this.credentialKey);
    await this.purgeCache();
    this.state = null;
    await this.saveState();
    await this.rebuild();
    // 团队专家是推给鲸翼的，清完缓存要告诉鲸翼，不然专家团队里还留着。
    this.notify();
  }

  /** 登录失效（过期、被停用、令牌没了）：团队内容撤掉，留下服务器地址方便重新登录。 */
  async expire(error) {
    await this.credentials.deleteRecord(this.credentialKey);
    await this.purgeCache();
    this.state = { ...this.state, status: 'expired', lastError: { code: error.code, message: error.message }, lastAttemptAt: new Date(this.now()).toISOString(), etag: null, items: [], workCache: null };
    await this.saveState();
    await this.rebuild();
    this.notify();
  }

  async purgeCache() {
    await rm(path.join(this.cacheDir, 'knowledge'), { recursive: true, force: true });
    await rm(path.join(this.cacheDir, 'experts'), { recursive: true, force: true });
    // 技能缓存目录本身登记给了鲸翼，留着目录、清空里面。
    for (const entry of await readdir(this.skillsDir).catch(() => [])) await rm(path.join(this.skillsDir, entry), { recursive: true, force: true });
    if (this.state) this.state.etag = null;
  }

  // ---------- 同步 ----------

  sync() {
    if (!this.syncing) this.syncing = this.runSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async runSync() {
    this.checkOpen();
    if (!this.state || this.state.status !== 'connected') return this.status();
    const token = await this.token();
    if (!token) { await this.expire(fail('AUTH_REQUIRED', '本机的登录信息不见了，请重新登录')); return this.status(); }
    const signal = this.lifetime.signal;
    const nowIso = new Date(this.now()).toISOString();
    this.state.lastAttemptAt = nowIso;
    let target, response;
    try {
      target = await this.target(this.state.server.origin);
      response = await request(target, 'GET', '/sync', { token, etag: this.state.hidden ? null : this.state.etag, signal, fetchImpl: this.net.fetchImpl });
      if (response.status !== 304) {
        const manifest = schemas.syncManifest.parse(response.json);
        await this.download(target, token, manifest.items, signal);
        this.state.items = manifest.items;
        this.state.me = manifest.me;
        this.state.etag = response.headers.get('etag');
      }
    } catch (error) {
      if (this.closed) throw error;
      if (AUTH_LOST.has(error.code)) { await this.expire(error); return this.status(); }
      this.state.lastError = { code: error.code ?? 'NETWORK', message: error.message };
      // 离线太久（超过企业设的天数）就先撤掉团队内容，连上后再下载回来。
      const limit = (this.state.me?.org?.offlineDays ?? 7) * DAY;
      if (!this.state.hidden && this.state.lastOkAt && this.now() - Date.parse(this.state.lastOkAt) > limit) {
        await this.purgeCache();
        this.state.hidden = true;
        this.state.workCache = null;
      }
      await this.saveState();
      await this.rebuild();
      this.notify();
      throw error;
    }
    this.state.lastOkAt = nowIso;
    this.state.lastError = null;
    this.state.hidden = false;
    await this.saveState();
    await this.rebuild();
    this.notify();
    return this.status();
  }

  notify() { try { this.onChange(); } catch (error) { this.log(`更新团队内容时出错：${error.message}`); } }

  fileOnDisk(kind, slug, rel) {
    if (!SLUG.test(slug)) throw fail('INTEGRITY', `服务端发来的标识“${slug}”格式不对`);
    const relative = normalizeContentPath(kind, rel);
    const root = path.join(this.cacheDir, KIND_DIRS[kind], slug);
    return { file: path.join(root, ...relative.split('/')), relative };
  }

  /** 按清单把本机缓存对齐：hash 对不上的下载，清单里没有的删掉。 */
  async download(target, token, items, signal) {
    const wanted = new Map();
    for (const item of items) {
      for (const file of item.files) {
        const { file: disk, relative } = this.fileOnDisk(item.kind, item.slug, file.path);
        wanted.set(disk, { ...file, kind: item.kind, slug: item.slug, relative });
      }
    }
    const previous = new Map();
    for (const item of this.state.items ?? []) for (const file of item.files) previous.set(`${item.kind}/${item.slug}/${file.path}`, file.hash);
    const queue = [];
    for (const [disk, file] of wanted) {
      if (previous.get(`${file.kind}/${file.slug}/${file.path}`) === file.hash && !this.state.hidden) {
        try { if (sha256(await readFile(disk)) === file.hash) continue; } catch { /* 文件不在，重新下载 */ }
      }
      queue.push([disk, file]);
    }
    const worker = async () => {
      while (queue.length) {
        signal.throwIfAborted();
        const [disk, file] = queue.shift();
        const url = `/items/${file.kind}/${file.slug}/files/${file.relative.split('/').map(encodeURIComponent).join('/')}`;
        const { buffer } = await request(target, 'GET', url, { token, raw: true, signal, fetchImpl: this.net.fetchImpl, timeoutMs: 60000 });
        if (sha256(buffer) !== file.hash) throw fail('INTEGRITY', `下载的“${file.path}”和清单对不上，可能正好有人在改，稍后再同步一次`);
        await writeAtomic(disk, buffer, this.tmpDir);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    // 清单里没有的文件和目录删掉（被删除、改了可见范围、或换了部门）。
    for (const kind of Object.keys(KIND_DIRS)) {
      const root = path.join(this.cacheDir, KIND_DIRS[kind]);
      for (const rel of await listFiles(root)) {
        const disk = path.join(root, ...rel.split('/'));
        if (!wanted.has(disk)) await rm(disk, { force: true });
      }
      await removeEmptyDirs(root, true);
    }
  }

  /** 按缓存重建团队专家和团队知识，交给鲸翼。 */
  async rebuild() {
    const notes = new Map(), experts = [];
    const items = this.state && this.state.status === 'connected' && !this.state.hidden ? this.state.items ?? [] : [];
    for (const item of items) {
      if (item.kind === 'knowledge') {
        for (const file of item.files) {
          const notePath = `${item.slug}/${file.path}`;
          if (notePath.length > 230) { this.log(`团队笔记路径太长，鲸翼放不下：${notePath}`); continue; }
          try {
            const { file: disk } = this.fileOnDisk('knowledge', item.slug, file.path);
            const content = utf8.decode(await readFile(disk));
            notes.set(notePath, { path: notePath, space: item.title, title: noteTitle(file.path, content), content, lower: content.toLowerCase(), hash: file.hash, absolutePath: disk });
          } catch (error) { this.log(`读不了团队笔记 ${notePath}：${error.message}`); }
        }
      } else if (item.kind === 'expert') {
        try {
          const { file: disk } = this.fileOnDisk('expert', item.slug, 'expert.md');
          const parsed = parseExpertTemplate(await readFile(disk, 'utf8'));
          experts.push({ id: item.slug, revision: item.revision, name: parsed.name, description: parsed.description, prompt: parsed.prompt,
            skills: parsed.skills, readOnly: !item.canMaintain });
        } catch (error) { this.log(`团队专家 ${item.slug} 读不了：${error.message}`); }
      }
    }
    this.notes = notes;
    this.experts = experts;
  }

  expertItems() { return this.experts.map(expert => ({ ...expert })); }

  // ---------- 给鲸翼个人版的两个来源 ----------

  async searchKnowledge(query, { signal } = {}) {
    signal?.throwIfAborted();
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const note of this.notes.values()) {
      const title = `${note.space} / ${note.title}`;
      const haystack = title.toLowerCase() + '\n' + note.lower;
      if (!terms.every(term => haystack.includes(term))) continue;
      const score = terms.reduce((sum, term) => sum + (title.toLowerCase().includes(term) ? 10 : 0) + haystack.split(term).length - 1, 0);
      hits.push({ score, note: { path: note.path, title, excerpt: excerptOf(note.content, terms), hash: note.hash } });
    }
    hits.sort((a, b) => b.score - a.score);
    const limit = 50;
    return { notes: hits.slice(0, limit).map(hit => hit.note), total: hits.length, truncated: hits.length > limit };
  }

  async readKnowledge(notePath, { signal } = {}) {
    signal?.throwIfAborted();
    const note = this.notes.get(notePath);
    if (!note) throw fail('NOT_FOUND', '这篇团队笔记已经不在了：可能被删除、改了可见范围，或者你已退出团队');
    return { path: note.path, content: note.content, hash: note.hash, absolutePath: note.absolutePath };
  }

  /** 维护人在“专家团队”里改团队专家：写回服务端，再同步。 */
  async saveExpert({ id, expectedRevision, expert }, { signal } = {}) {
    this.checkOpen();
    const item = (this.state?.items ?? []).find(entry => entry.kind === 'expert' && entry.slug === id);
    if (!item || this.state.status !== 'connected') throw fail('NOT_FOUND', '这位团队专家已经不在了，请刷新');
    if (!item.canMaintain) throw fail('FORBIDDEN', '你不是这位专家的维护人，只能查看或复制为自己的专家');
    if (item.revision !== expectedRevision) throw fail('CONFLICT', '这位专家刚被别人改过，请关掉后重新打开再改');
    const file = item.files.find(entry => entry.path === 'expert.md');
    const { file: disk } = this.fileOnDisk('expert', id, 'expert.md');
    let avatar = null;
    try { avatar = parseExpertTemplate(await readFile(disk, 'utf8')).avatar; } catch { /* 读不到就不带头像 */ }
    const text = renderExpertTemplate({ name: expert.name, description: expert.description, skills: expert.skills ?? [], avatar, prompt: expert.prompt });
    await this.put('expert', id, 'expert.md', text, file?.hash ?? null, signal);
    const saved = this.experts.find(entry => entry.id === id);
    if (!saved) throw fail('SYNC', '已经保存到服务端，但同步回来时出了问题，请稍后刷新');
    return { ...saved };
  }

  // ---------- 维护团队内容（在「团队」页签里） ----------

  async connectionFor() {
    this.checkOpen();
    if (this.state?.status !== 'connected') throw fail('AUTH_REQUIRED', '还没连上企业，请先登录');
    const token = await this.token();
    if (!token) throw fail('AUTH_REQUIRED', '本机的登录信息不见了，请重新登录');
    return { target: await this.target(this.state.server.origin), token };
  }

  async readFile({ kind, slug, path: rel }, signal) {
    const { target, token } = await this.connectionFor();
    const relative = normalizeContentPath(kind, rel);
    const url = `/items/${kind}/${slug}/files/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const { buffer, headers } = await request(target, 'GET', url, { token, raw: true, signal, fetchImpl: this.net.fetchImpl });
    let content;
    try { content = utf8.decode(buffer); } catch { throw fail('BINARY', `“${relative}”不是文本文件，这里不能编辑；请在管理端上传新的技能压缩包`); }
    return { path: relative, content, hash: headers.get('x-content-hash') ?? sha256(buffer) };
  }

  async put(kind, slug, rel, content, baseHash, signal) {
    const { target, token } = await this.connectionFor();
    const relative = normalizeContentPath(kind, rel);
    const url = `/items/${kind}/${slug}/files/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const { json } = await request(target, 'PUT', url, { token, body: { content, baseHash, encoding: 'utf8' }, signal, fetchImpl: this.net.fetchImpl });
    try { await this.sync(); } catch (error) { this.log(`保存后同步失败：${error.message}`); }
    return json;
  }

  async writeFile({ kind, slug, path: rel, content, baseHash }, signal) {
    const result = await this.put(kind, slug, rel, content, baseHash, signal);
    return { saved: result, status: this.status() };
  }

  async removeFile({ kind, slug, path: rel, baseHash }, signal) {
    const { target, token } = await this.connectionFor();
    const relative = normalizeContentPath(kind, rel);
    const url = `/items/${kind}/${slug}/files/${relative.split('/').map(encodeURIComponent).join('/')}?baseHash=${baseHash}`;
    await request(target, 'DELETE', url, { token, signal, fetchImpl: this.net.fetchImpl });
    try { await this.sync(); } catch (error) { this.log(`删除后同步失败：${error.message}`); }
    return { status: this.status() };
  }

  async personalSearch({ query }, signal) {
    const result = await this.personal.search(query, { signal });
    return { notes: result.notes.filter(note => !String(note.path).startsWith('@')).slice(0, 50).map(note => ({ path: note.path, title: note.title ?? note.path })), total: result.total };
  }

  /** 把自己的一篇个人笔记提交到团队知识空间。只发这一篇，个人知识库原样不动。 */
  async submitPersonal({ notePath, slug, path: rel }, signal) {
    const space = (this.state?.items ?? []).find(item => item.kind === 'knowledge' && item.slug === slug);
    if (!space) throw fail('NOT_FOUND', '这个知识空间不在了，请刷新');
    if (!space.canMaintain) throw fail('FORBIDDEN', `你不是“${space.title}”的维护人，不能往里提交`);
    const note = await this.personal.read(notePath);
    const result = await this.put('knowledge', slug, rel, note.content, null, signal);
    return { saved: result, status: this.status() };
  }

  // ---------- 企业管理：事项和项目 ----------
  // 员工端不整份同步事项，按需查询；只缓存“我的工作”，连不上时拿来看（标明是缓存，不能改）。

  async workRequest(method, url, { body, signal, raw = false } = {}) {
    const { target, token } = await this.connectionFor();
    try {
      const response = await request(target, method, '/work' + url, { token, body, signal, raw, fetchImpl: this.net.fetchImpl });
      return raw ? response.buffer.toString('utf8') : response.json;
    } catch (error) {
      if (!this.closed && AUTH_LOST.has(error.code)) await this.expire(error);
      throw error;
    }
  }

  async mine(signal) {
    try {
      const data = await this.workRequest('GET', '/mine', { signal });
      this.state.workCache = { at: new Date(this.now()).toISOString(), data };
      await this.saveState();
      return { ...data, cached: false };
    } catch (error) {
      const cache = this.state?.status === 'connected' ? this.state.workCache : null;
      if (cache && OFFLINE_CODES.has(error.code)) return { ...cache.data, cached: true, cachedAt: cache.at, problem: error.message };
      throw error;
    }
  }

  async work({ op, id, params = {}, body }, signal) {
    const query = keys => {
      const search = new URLSearchParams();
      for (const key of keys) if (params[key] !== undefined && params[key] !== null && params[key] !== '') search.set(key, String(params[key]));
      const text = search.toString();
      return text ? `?${text}` : '';
    };
    const item = () => { if (!Number.isInteger(id) || id <= 0) throw fail('INVALID_INPUT', '缺少事项编号'); return id; };
    switch (op) {
      case 'context': return this.workRequest('GET', '/context', { signal });
      case 'directory': return this.workRequest('GET', '/directory', { signal });
      case 'mine': return this.mine(signal);
      case 'search': return this.workRequest('GET', '/items' + query(['assigneeId', 'projectId', 'departmentId', 'typeId', 'waitingOn', 'category', 'overdue', 'q', 'limit', 'offset']), { signal });
      case 'get': return this.workRequest('GET', `/items/${item()}`, { signal });
      case 'create': return this.workRequest('POST', '/items', { body, signal });
      case 'update': return this.workRequest('PATCH', `/items/${item()}`, { body, signal });
      case 'comment': return this.workRequest('POST', `/items/${item()}/comments`, { body, signal });
      case 'remove': return this.workRequest('DELETE', `/items/${item()}`, { signal });
      case 'board': return this.workRequest('GET', '/board' + query(['departmentId', 'projectId']), { signal });
      case 'export': return { csv: await this.workRequest('GET', '/export' + query(['assigneeId', 'projectId', 'departmentId', 'category', 'overdue', 'q']), { signal, raw: true }) };
      case 'projects': return this.workRequest('GET', '/projects', { signal });
      case 'createProject': return this.workRequest('POST', '/projects', { body, signal });
      case 'updateProject': return this.workRequest('PATCH', `/projects/${item()}`, { body, signal });
      case 'deleteProject': return this.workRequest('DELETE', `/projects/${item()}`, { signal });
      default: throw fail('INVALID_INPUT', '不认识的事项操作');
    }
  }

  async manage(value, signal) {
    switch (value.action) {
      case 'work': return this.work(value, signal);
      case 'status': return this.status();
      case 'probe': return this.probe(value, signal);
      case 'join': return this.join(value, signal);
      case 'login': return this.login(value, signal);
      case 'sync':
        try { return await this.sync(); }
        catch (error) { if (this.state && !AUTH_LOST.has(error.code)) return this.status(); throw error; }
      case 'leave': return this.leave();
      case 'read': return this.readFile(value, signal);
      case 'write': return this.writeFile(value, signal);
      case 'remove': return this.removeFile(value, signal);
      case 'personalSearch': return this.personalSearch(value, signal);
      case 'submitPersonal': return this.submitPersonal(value, signal);
      default: throw fail('INVALID_INPUT', '不认识的操作');
    }
  }
}

export { KIND_LABELS };
