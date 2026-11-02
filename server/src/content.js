// 团队内容：知识空间、专家、技能。正文按文件存在 data/content 下，数据库只记版本、权限和修改记录。
import { mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { ApiError, apiError, LIMITS, normalizeContentPath, parseExpertTemplate, pathKey, renderExpertTemplate } from '@whalewing-enterprise/shared';
import { transaction } from './db.js';
import { sha256 } from './secrets.js';

const KIND_DIRS = Object.freeze({ knowledge: 'knowledge', expert: 'experts', skill: 'skills' });
const ROOT_FILE = Object.freeze({ expert: 'expert.md', skill: 'SKILL.md' });
const now = () => new Date().toISOString();
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeText(buffer, what) {
  try { return utf8.decode(buffer); } catch { throw apiError('INVALID_INPUT', `${what}要用 UTF-8 编码的文本`); }
}

/** DSH 认技能时要求开头有 name（小写短横线）和 description；格式不对 DSH 会直接丢掉，所以保存时先查。 */
export function validateSkillFile(text, slug) {
  const source = text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');
  const match = source.match(/^---\n([^]*?)\n---(?:\n|$)/u);
  if (!match) throw apiError('INVALID_INPUT', 'SKILL.md 开头要用两行 --- 包住 name 和 description');
  const name = match[1].match(/^name:[ \t]*(.*?)[ \t]*$/mu)?.[1]?.replace(/^(["'])(.*)\1$/u, '$2');
  if (name !== slug) throw apiError('INVALID_INPUT', `SKILL.md 里的 name 要和技能标识一样，写成 name: ${slug}`);
  if (!/^description:[ \t]*\S/mu.test(match[1])) throw apiError('INVALID_INPUT', 'SKILL.md 要写 description（一句话说明这个技能做什么）');
}

const defaultFiles = {
  knowledge: () => [],
  expert: item => [['expert.md', renderExpertTemplate({
    name: [...item.title].slice(0, 40).join(''),
    description: [...(item.description || item.title)].slice(0, 240).join(''),
    skills: [],
    prompt: `你是${item.title}。\n\n在这里写这位专家负责什么、怎么做事、交付什么。`,
  })]],
  skill: item => [['SKILL.md', `---\nname: ${item.slug}\ndescription: ${JSON.stringify(item.description || item.title)}\n---\n# ${item.title}\n\n在这里写这个技能的做法：什么时候用、按什么步骤做、交付什么。\n`]],
};

export class Content {
  constructor(db, { contentDir, tmpDir, org, audit }) {
    this.db = db;
    this.contentDir = contentDir;
    this.tmpDir = tmpDir;
    this.org = org;
    this.audit = audit;
    this.locks = new Map();
  }

  /** 同一项内容的写入排队做，免得两个人同时保存时都通过了版本检查。 */
  async withLock(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  revision() { return Number(this.org.meta('revision') ?? 0); }
  nextRevision() { const next = this.revision() + 1; this.org.setMeta('revision', next); return next; }

  itemDir(item) { return path.join(this.contentDir, KIND_DIRS[item.kind], item.slug); }
  fileOnDisk(item, rel) {
    const root = this.itemDir(item);
    const target = path.join(root, ...rel.split('/'));
    if (!target.startsWith(root + path.sep)) throw apiError('INVALID_INPUT', '路径超出了这项内容的目录');
    return target;
  }

  // ---------- 权限 ----------

  accessOf(itemId) {
    const result = { view: [], maintain: [] };
    for (const row of this.db.prepare('SELECT mode, subject_type AS type, subject_id AS id FROM access WHERE item_id = ? ORDER BY mode, subject_type, subject_id').all(itemId)) {
      result[row.mode].push(row.type === 'all' ? { type: 'all' } : { type: row.type, id: row.id });
    }
    return result;
  }

  writeAccess(itemId, access) {
    this.db.prepare('DELETE FROM access WHERE item_id = ?').run(itemId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO access (item_id, mode, subject_type, subject_id) VALUES (?, ?, ?, ?)');
    for (const mode of ['view', 'maintain']) {
      for (const subject of access[mode]) {
        if (subject.type === 'department' && !this.org.department(subject.id)) throw apiError('NOT_FOUND', `部门 ${subject.id} 不存在`);
        if (subject.type === 'user' && !this.org.user(subject.id)) throw apiError('NOT_FOUND', `成员 ${subject.id} 不存在`);
        insert.run(itemId, mode, subject.type, subject.type === 'all' ? 0 : subject.id);
      }
    }
  }

  /** 这个人能不能看、能不能改这一项。管理员什么都能；维护人自动能看。可见范围选了部门时，包含它的下级部门。 */
  can(user, item, mode) {
    if (!user || user.status !== 'active') return false;
    if (user.role === 'admin') return true;
    const departments = new Set(this.org.ancestors(user.departmentId).map(department => department.id));
    const rows = this.db.prepare('SELECT mode, subject_type AS type, subject_id AS id FROM access WHERE item_id = ?').all(item.id);
    return rows.some(row => (mode === 'view' || row.mode === 'maintain')
      && (row.type === 'all' || (row.type === 'user' && row.id === user.id) || (row.type === 'department' && departments.has(row.id))));
  }

  // ---------- 内容项 ----------

  item(kind, slug) {
    const row = this.db.prepare(`SELECT id, kind, slug, title, description, revision, created_at AS createdAt, updated_at AS updatedAt, updated_by AS updatedBy
      FROM items WHERE kind = ? AND slug = ?`).get(kind, slug);
    return row ? { ...row } : null;
  }

  /** 看不到的一律说不存在，不让人从报错里猜出有哪些内容。 */
  requireItem(user, kind, slug, mode) {
    const item = this.item(kind, slug);
    if (!item || !this.can(user, item, 'view')) throw apiError('NOT_FOUND');
    if (mode === 'maintain' && !this.can(user, item, 'maintain')) throw apiError('FORBIDDEN', '你不是这项内容的维护人，只能查看');
    return item;
  }

  files(itemId) {
    return this.db.prepare(`SELECT path, hash, size, revision, updated_at AS updatedAt, updated_by AS updatedBy FROM files WHERE item_id = ? ORDER BY path`)
      .all(itemId).map(row => ({ ...row }));
  }

  items(kind) {
    const rows = this.db.prepare(`SELECT id FROM items ${kind ? 'WHERE kind = ?' : ''} ORDER BY kind, title`).all(...(kind ? [kind] : []));
    return rows.map(({ id }) => this.describe(this.db.prepare('SELECT kind, slug FROM items WHERE id = ?').get(id)));
  }

  describe({ kind, slug }) {
    const item = this.item(kind, slug);
    const stats = this.db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files WHERE item_id = ?').get(item.id);
    return { ...item, files: stats.files, bytes: stats.bytes, access: this.accessOf(item.id) };
  }

  async createItem(actor, input) {
    if (this.item(input.kind, input.slug)) throw apiError('EXISTS', `标识“${input.slug}”已经被别的${input.kind === 'knowledge' ? '知识空间' : input.kind === 'expert' ? '专家' : '技能'}用了`);
    const item = transaction(this.db, () => {
      const at = now(), revision = this.nextRevision();
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO items (kind, slug, title, description, revision, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.kind, input.slug, input.title, input.description ?? '', revision, at, at, actor.id);
      this.writeAccess(Number(lastInsertRowid), input.access ?? { view: [{ type: 'all' }], maintain: [] });
      this.audit.record(actor, 'item.create', `${input.kind}/${input.slug}`, { title: input.title });
      return this.item(input.kind, input.slug);
    });
    try {
      for (const [rel, text] of defaultFiles[item.kind](item)) await this.storeFile(actor, item, rel, Buffer.from(text, 'utf8'), null, { audit: false });
    } catch (error) {
      await this.deleteItem(actor, item.kind, item.slug, { audit: false });
      throw error;
    }
    return this.describe(item);
  }

  updateItem(actor, kind, slug, input) {
    transaction(this.db, () => {
      const item = this.item(kind, slug);
      if (!item) throw apiError('NOT_FOUND');
      const revision = this.nextRevision();
      this.db.prepare('UPDATE items SET title = ?, description = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(
        input.title ?? item.title, input.description ?? item.description, revision, now(), actor.id, item.id);
      if (input.access) this.writeAccess(item.id, input.access);
      this.audit.record(actor, 'item.update', `${kind}/${slug}`, input);
    });
    return this.describe({ kind, slug });
  }

  async deleteItem(actor, kind, slug, { audit = true } = {}) {
    const item = this.item(kind, slug);
    if (!item) throw apiError('NOT_FOUND');
    await this.withLock(`${kind}/${slug}`, async () => {
      transaction(this.db, () => {
        this.db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
        this.nextRevision();
        if (audit) this.audit.record(actor, 'item.delete', `${kind}/${slug}`, { title: item.title });
      });
      // 目录是服务端自己建的，里面不会有链接；fs.rm 也不会顺着链接删到外面。
      await rm(this.itemDir(item), { recursive: true, force: true });
    });
  }

  // ---------- 文件 ----------

  async readFile(user, kind, slug, rel) {
    const item = this.requireItem(user, kind, slug, 'view');
    const relative = normalizeContentPath(kind, rel);
    const row = this.db.prepare('SELECT path, hash, size FROM files WHERE item_id = ? AND path = ?').get(item.id, relative);
    if (!row) throw apiError('NOT_FOUND');
    const buffer = await readFile(this.fileOnDisk(item, relative));
    return { buffer, hash: row.hash, path: row.path };
  }

  checkFile(item, rel, buffer) {
    if (item.kind === 'knowledge') {
      if (buffer.length > LIMITS.noteBytes) throw apiError('TOO_LARGE', `一篇笔记最大 ${LIMITS.noteBytes / 1_000_000} MB`);
      decodeText(buffer, '笔记');
    } else if (item.kind === 'expert') {
      if (buffer.length > LIMITS.expertBytes) throw apiError('TOO_LARGE', '专家模板太大');
      parseExpertTemplate(decodeText(buffer, '专家模板'));
    } else {
      if (buffer.length > LIMITS.skillFileBytes) throw apiError('TOO_LARGE', `技能里单个文件最大 ${LIMITS.skillFileBytes / 1_000_000} MB`);
      if (rel === 'SKILL.md') validateSkillFile(decodeText(buffer, 'SKILL.md'), item.slug);
    }
  }

  async writeFile(actor, kind, slug, rel, input) {
    const item = this.requireItem(actor, kind, slug, 'maintain');
    const relative = normalizeContentPath(kind, rel);
    if (kind === 'knowledge' && input.encoding !== 'utf8') throw apiError('INVALID_INPUT', '笔记要按文本提交');
    const buffer = input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content, 'utf8');
    return this.withLock(`${kind}/${slug}`, () => this.storeFile(actor, item, relative, buffer, input.baseHash));
  }

  /** 已经排好队、核对过权限的写入。baseHash 为 null 表示新建。 */
  async storeFile(actor, item, relative, buffer, baseHash, { audit = true } = {}) {
    this.checkFile(item, relative, buffer);
    const existing = this.db.prepare('SELECT path, hash FROM files WHERE item_id = ? AND path_key = ?').get(item.id, pathKey(relative));
    if (existing && existing.path !== relative) throw apiError('EXISTS', `已经有一个只差大小写的文件“${existing.path}”，Windows 上会撞名`);
    if (baseHash === null && existing) throw apiError('CONFLICT', `“${relative}”已经存在，请重新读取后再改`);
    if (baseHash !== null && (!existing || existing.hash !== baseHash)) throw apiError('CONFLICT');
    if (!existing) {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE item_id = ?').get(item.id).n;
      const limit = item.kind === 'skill' ? LIMITS.skillFiles : LIMITS.itemFiles;
      if (count >= limit) throw apiError('TOO_LARGE', `这项内容最多 ${limit} 个文件`);
    }
    const hash = sha256(buffer);
    if (existing && existing.hash === hash) {
      const row = this.db.prepare('SELECT revision FROM files WHERE item_id = ? AND path = ?').get(item.id, relative);
      return { path: relative, hash, size: buffer.length, revision: row.revision };
    }
    const target = this.fileOnDisk(item, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    const temp = path.join(this.tmpDir, randomUUID());
    await writeFile(temp, buffer);
    await rename(temp, target);
    const revision = transaction(this.db, () => {
      const next = this.nextRevision(), at = now();
      this.db.prepare(`INSERT INTO files (item_id, path, path_key, hash, size, revision, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, path) DO UPDATE SET hash = excluded.hash, size = excluded.size, revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(item.id, relative, pathKey(relative), hash, buffer.length, next, at, actor.id);
      this.db.prepare('UPDATE items SET revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(next, at, actor.id, item.id);
      if (audit) this.audit.record(actor, 'file.write', `${item.kind}/${item.slug}/${relative}`, { size: buffer.length, created: !existing });
      return next;
    });
    return { path: relative, hash, size: buffer.length, revision };
  }

  async deleteFile(actor, kind, slug, rel, baseHash) {
    const item = this.requireItem(actor, kind, slug, 'maintain');
    const relative = normalizeContentPath(kind, rel);
    if (ROOT_FILE[kind] === relative) throw apiError('INVALID_INPUT', `${relative} 不能删除；不要这项内容了就删除整项`);
    return this.withLock(`${kind}/${slug}`, () => this.removeFile(actor, item, relative, baseHash));
  }

  async removeFile(actor, item, relative, baseHash, { audit = true } = {}) {
    const existing = this.db.prepare('SELECT hash FROM files WHERE item_id = ? AND path = ?').get(item.id, relative);
    if (!existing) throw apiError('NOT_FOUND');
    if (baseHash !== undefined && baseHash !== null && existing.hash !== baseHash) throw apiError('CONFLICT');
    const target = this.fileOnDisk(item, relative);
    await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    // 顺手删掉变空的上级目录，到这项内容的根目录为止。
    const root = this.itemDir(item);
    for (let dir = path.dirname(target); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try { await rmdir(dir); } catch { break; }
    }
    transaction(this.db, () => {
      const next = this.nextRevision();
      this.db.prepare('DELETE FROM files WHERE item_id = ? AND path = ?').run(item.id, relative);
      this.db.prepare('UPDATE items SET revision = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(next, now(), actor.id, item.id);
      if (audit) this.audit.record(actor, 'file.delete', `${item.kind}/${item.slug}/${relative}`);
    });
  }

  /** 上传技能压缩包：整体替换这个技能的文件。压缩包外面多包了一层目录也认。 */
  async replaceSkillArchive(actor, slug, archive) {
    const item = this.requireItem(actor, 'skill', slug, 'maintain');
    if (archive.length > LIMITS.skillArchiveBytes) throw apiError('TOO_LARGE', `技能压缩包最大 ${LIMITS.skillArchiveBytes / 1_000_000} MB`);
    let total = 0, count = 0, entries;
    try {
      entries = unzipSync(new Uint8Array(archive), {
        filter: file => {
          if (file.name.endsWith('/')) return false;
          count += 1; total += file.originalSize;
          if (count > LIMITS.skillFiles) throw apiError('TOO_LARGE', `技能最多 ${LIMITS.skillFiles} 个文件`);
          if (file.originalSize > LIMITS.skillFileBytes || total > LIMITS.skillArchiveBytes * 2) throw apiError('TOO_LARGE', '压缩包解开后太大');
          return true;
        },
      });
    } catch (error) {
      // fflate 自己的错误也带数字 code，所以按类型判断，只有我们抛的原样往外传。
      if (error instanceof ApiError) throw error;
      throw apiError('INVALID_INPUT', '这不是有效的 zip 压缩包');
    }
    let names = Object.keys(entries).map(name => name.replaceAll('\\', '/'));
    const top = names[0]?.split('/')[0];
    if (top && !names.includes('SKILL.md') && names.every(name => name.startsWith(top + '/'))) names = names.map(name => name.slice(top.length + 1));
    const files = new Map();
    Object.values(entries).forEach((data, index) => {
      const relative = normalizeContentPath('skill', names[index]);
      if ([...files.keys()].some(other => pathKey(other) === pathKey(relative))) throw apiError('INVALID_INPUT', `压缩包里有只差大小写的两个文件：${relative}`);
      files.set(relative, Buffer.from(data));
    });
    if (!files.has('SKILL.md')) throw apiError('INVALID_INPUT', '压缩包的根目录要有 SKILL.md');
    for (const [relative, buffer] of files) this.checkFile(item, relative, buffer);
    return this.withLock(`skill/${slug}`, async () => {
      const current = new Map(this.files(item.id).map(file => [file.path, file.hash]));
      for (const [relative, buffer] of files) await this.storeFile(actor, item, relative, buffer, current.get(relative) ?? null, { audit: false });
      for (const relative of current.keys()) if (!files.has(relative)) await this.removeFile(actor, item, relative, undefined, { audit: false });
      this.audit.record(actor, 'skill.upload', `skill/${slug}`, { files: files.size });
      return this.describe(item);
    });
  }

  // ---------- 同步 ----------

  /** 员工端同步用的清单：这个人能看的全部内容，每个文件带 hash，员工端只下载对不上的。 */
  manifest(user) {
    const items = this.db.prepare('SELECT id, kind, slug, title, description, revision FROM items ORDER BY kind, slug').all()
      .map(row => ({ ...row }))
      .filter(item => this.can(user, item, 'view'))
      .map(item => ({
        kind: item.kind, slug: item.slug, title: item.title, description: item.description, revision: item.revision,
        canMaintain: this.can(user, item, 'maintain'),
        files: this.db.prepare('SELECT path, hash, size FROM files WHERE item_id = ? ORDER BY path').all(item.id).map(row => ({ ...row })),
      }));
    return { revision: this.revision(), items };
  }

  overview() {
    const counts = Object.fromEntries(this.db.prepare('SELECT kind, COUNT(*) AS n FROM items GROUP BY kind').all().map(row => [row.kind, row.n]));
    return { knowledge: counts.knowledge ?? 0, expert: counts.expert ?? 0, skill: counts.skill ?? 0 };
  }
}
