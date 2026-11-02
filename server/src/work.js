// 企业管理：事项、事项类型、项目、动态、回收站、我的工作和团队看板。
// 一种事项 + 类型；状态归到五个大类，统计都按大类算；进度和逾期自动算。
// 看：数据范围里的 + 自己参与的 + 同项目的（企业设置可以改成全员可见）。改：自己负责的，或者范围内并且有对应的权限点。
// 看不到的一律回“不存在”。所有判断都在服务端，小鲸和专家调工具也走这里。
import { apiError, CATEGORY_LABELS, OPEN_CATEGORIES, PRIORITY_LABELS, WORK_LIMITS, schemas } from '@whalewing-enterprise/shared';
import { transaction } from './db.js';

const now = () => new Date().toISOString();
const DAY = 24 * 60 * 60 * 1000;

// ---------- 日期：按企业设置的时区算“今天”“本周” ----------

export function localDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(dateText, days) {
  return new Date(Date.parse(dateText + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
}
export const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);

export function calendar(timeZone, at = Date.now()) {
  const today = localDate(at, timeZone);
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  const weekStart = addDays(today, -((weekday + 6) % 7));
  return { today, weekday, weekStart, weekEnd: addDays(weekStart, 6), period: today.slice(0, 7).replace('-', '') };
}

/** 进度：已完成 100、未开始 0、已取消不算；有检查项时按检查项完成的比例；其余用手填的。 */
export function computeProgress(category, checklist, manual) {
  if (category === 'done') return 100;
  if (category === 'todo') return 0;
  if (category === 'cancelled') return null;
  if (checklist.length) return Math.round(checklist.filter(item => item.done).length / checklist.length * 100);
  return manual ?? 0;
}

const json = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const FIELD_LABELS = Object.freeze({
  title: '标题', status: '状态', priority: '优先级', startDate: '开始日期', dueDate: '截止日期', assigneeId: '负责人', projectId: '项目',
  progress: '进度', waitingOn: '在等谁', waitingNote: '在等什么', content: '内容', checklist: '检查项', refs: '引用资料', fields: '专属字段', collaboratorIds: '协作人',
});
// 改了这几样要另外记进操作记录：谁、什么时候、从什么改成什么、是本人操作还是经模型。
const AUDITED = new Set(['dueDate', 'priority', 'assigneeId']);

function parseType(row) {
  return row ? { id: row.id, name: row.name, prefix: row.prefix, statuses: json(row.statuses, []), fields: json(row.fields, []), sort: row.sort, archived: Boolean(row.archived_at) } : null;
}

/** 给新状态、新字段补上标识；已有的标识不变，事项里存的是标识，所以改名不影响已有事项。 */
function withKeys(list, letter) {
  const used = new Set(list.map(entry => entry.key).filter(Boolean));
  let n = 1;
  return list.map(entry => {
    if (entry.key) return entry;
    while (used.has(`${letter}${n}`)) n += 1;
    const key = `${letter}${n}`;
    used.add(key);
    return { ...entry, key };
  });
}

function checkUnique(list, what) {
  const keys = new Set(), names = new Set();
  for (const entry of list) {
    if (keys.has(entry.key)) throw apiError('INVALID_INPUT', `${what}的标识“${entry.key}”重复了`);
    if (names.has(entry.name)) throw apiError('INVALID_INPUT', `${what}“${entry.name}”写了两次`);
    keys.add(entry.key); names.add(entry.name);
  }
}

export class Work {
  constructor(db, { org, roles, audit, clock = () => Date.now() }) {
    this.db = db;
    this.org = org;
    this.roles = roles;
    this.audit = audit;
    this.clock = clock;
  }

  calendar() { return calendar(this.org.settings().timeZone, this.clock()); }

  /** 一次请求里要用的名字表：人、类型、项目。 */
  lookups() {
    const users = new Map(this.db.prepare('SELECT id, display_name AS name, department_id AS departmentId, status FROM users').all().map(row => [row.id, { ...row }]));
    const types = new Map(this.db.prepare('SELECT * FROM work_item_types').all().map(row => [row.id, parseType(row)]));
    const projects = new Map(this.db.prepare('SELECT id, name, status FROM projects').all().map(row => [row.id, { ...row }]));
    return { users, types, projects, ...this.calendar(), name: id => (id ? users.get(id)?.name ?? '已删除的成员' : null) };
  }

  // ---------- 事项类型（只有管理员能改） ----------

  types({ includeArchived = false } = {}) {
    return this.db.prepare(`SELECT * FROM work_item_types ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY sort, id`).all().map(parseType);
  }
  type(id) { return parseType(this.db.prepare('SELECT * FROM work_item_types WHERE id = ?').get(id)); }
  defaultType() {
    const type = parseType(this.db.prepare('SELECT * FROM work_item_types WHERE archived_at IS NULL ORDER BY sort, id LIMIT 1').get());
    if (!type) throw apiError('INVALID_INPUT', '还没有可用的事项类型，请管理员先在管理端建一个');
    return type;
  }

  normalizeType(input) {
    const statuses = withKeys(input.statuses, 's');
    checkUnique(statuses, '状态');
    const fields = withKeys(input.fields ?? [], 'f');
    checkUnique(fields, '专属字段');
    for (const field of fields) {
      if (field.kind === 'select' && !field.options?.length) throw apiError('INVALID_INPUT', `单选字段“${field.name}”要写几个选项`);
      if (field.kind !== 'select') delete field.options;
    }
    return { statuses, fields };
  }

  checkTypeClash(name, prefix, exceptId = 0) {
    if (name && this.db.prepare('SELECT 1 FROM work_item_types WHERE name = ? AND id != ?').get(name, exceptId)) throw apiError('EXISTS', `已经有叫“${name}”的类型了`);
    if (prefix && this.db.prepare('SELECT 1 FROM work_item_types WHERE prefix = ? AND id != ?').get(prefix, exceptId)) throw apiError('EXISTS', `编号前缀“${prefix}”已经被别的类型用了`);
  }

  createType(actor, input) {
    return transaction(this.db, () => {
      this.checkTypeClash(input.name, input.prefix);
      const { statuses, fields } = this.normalizeType(input);
      const at = now(), sort = this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM work_item_types').get().next;
      const { lastInsertRowid } = this.db.prepare('INSERT INTO work_item_types (name, prefix, statuses, fields, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.name, input.prefix, JSON.stringify(statuses), JSON.stringify(fields), sort, at, at);
      this.audit.record(actor, 'worktype.create', input.name, { prefix: input.prefix, statuses: statuses.map(status => `${status.name}（${CATEGORY_LABELS[status.category]}）`) });
      return this.type(Number(lastInsertRowid));
    });
  }

  updateType(actor, id, input) {
    return transaction(this.db, () => {
      const raw = this.db.prepare('SELECT archived_at FROM work_item_types WHERE id = ?').get(id);
      const current = this.type(id);
      if (!current) throw apiError('NOT_FOUND', '事项类型不存在');
      this.checkTypeClash(input.name, input.prefix, id);
      const archivedAt = input.archived === undefined ? raw.archived_at : input.archived ? raw.archived_at ?? now() : null;
      const merged = this.normalizeType({ statuses: input.statuses ?? current.statuses, fields: input.fields ?? current.fields });
      if (input.statuses) {
        const kept = new Map(merged.statuses.map(status => [status.key, status]));
        for (const old of current.statuses) {
          if (kept.has(old.key)) continue;
          const used = this.db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE type_id = ? AND status = ?').get(id, old.key).n;
          if (used) throw apiError('IN_USE', `还有 ${used} 个事项（含回收站）是“${old.name}”状态，先把它们改成别的状态再删这个状态`);
        }
        // 状态换了大类：已有事项跟着换，完成时间跟着记或清掉。
        for (const status of merged.statuses) {
          const old = current.statuses.find(entry => entry.key === status.key);
          if (!old || old.category === status.category) continue;
          this.db.prepare(`UPDATE work_items SET category = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END
            WHERE type_id = ? AND status = ?`).run(status.category, status.category, now(), id, status.key);
        }
      }
      this.db.prepare('UPDATE work_item_types SET name = ?, prefix = ?, statuses = ?, fields = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(
        input.name ?? current.name, input.prefix ?? current.prefix, JSON.stringify(merged.statuses), JSON.stringify(merged.fields), archivedAt, now(), id);
      if (input.archived === true && !this.db.prepare('SELECT 1 FROM work_item_types WHERE archived_at IS NULL').get()) throw apiError('INVALID_INPUT', '至少要留一个能用的类型');
      this.audit.record(actor, 'worktype.update', current.name, input);
      return this.type(id);
    });
  }

  deleteType(actor, id) {
    transaction(this.db, () => {
      const current = this.type(id);
      if (!current) throw apiError('NOT_FOUND', '事项类型不存在');
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE type_id = ?').get(id).n;
      if (used) throw apiError('IN_USE', `还有 ${used} 个事项（含回收站）是这个类型，不能删除；不想再用可以停用它`);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM work_item_types WHERE archived_at IS NULL AND id != ?').get(id).n === 0) throw apiError('INVALID_INPUT', '至少要留一个能用的类型');
      this.db.prepare('DELETE FROM work_item_types WHERE id = ?').run(id);
      this.audit.record(actor, 'worktype.delete', current.name);
    });
  }

  // ---------- 项目 ----------

  projectRow(raw) {
    if (!raw) return null;
    return {
      id: raw.id, name: raw.name, description: raw.description, ownerId: raw.owner_id, startDate: raw.start_date, endDate: raw.end_date, status: raw.status,
      createdBy: raw.created_by, createdAt: raw.created_at, updatedAt: raw.updated_at,
      memberIds: this.db.prepare('SELECT user_id AS id FROM project_members WHERE project_id = ? ORDER BY user_id').all(raw.id).map(row => row.id),
    };
  }
  project(id) { return this.projectRow(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)); }

  /** 能看到的项目：管理员和全员可见时全部；否则自己负责、建的、参与的，以及范围里有人在做的。 */
  visibleProjectIds(access) {
    if (access.admin || this.org.settings().workVisibility === 'all') return null;
    const me = access.userId;
    const ids = new Set(this.db.prepare(`SELECT id FROM projects WHERE owner_id = ? OR created_by = ?
      UNION SELECT project_id FROM project_members WHERE user_id = ?`).all(me, me, me).map(row => row.id));
    const scope = access.scopeUserIds();
    const rows = scope === null ? this.db.prepare('SELECT DISTINCT project_id AS id FROM work_items WHERE project_id IS NOT NULL AND deleted_at IS NULL').all()
      : this.db.prepare('SELECT DISTINCT project_id AS id FROM work_items WHERE project_id IS NOT NULL AND deleted_at IS NULL AND assignee_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(scope));
    for (const row of rows) ids.add(row.id);
    return ids;
  }

  canManageProject(access, project) {
    return access.admin || (access.can('project.manage') && (project.ownerId === access.userId || project.createdBy === access.userId));
  }

  projects(access, { includeClosed = true } = {}) {
    const visible = this.visibleProjectIds(access);
    const counts = new Map(this.db.prepare(`SELECT project_id AS id, COUNT(*) AS total, SUM(CASE WHEN category IN ('todo','doing','waiting') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN category IN ('todo','doing','waiting') AND due_date < ? THEN 1 ELSE 0 END) AS overdue
      FROM work_items WHERE deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id`).all(this.calendar().today).map(row => [row.id, row]));
    return this.db.prepare(`SELECT * FROM projects ${includeClosed ? '' : "WHERE status = 'active'"} ORDER BY status, id DESC`).all()
      .filter(raw => visible === null || visible.has(raw.id))
      .map(raw => {
        const project = this.projectRow(raw);
        const count = counts.get(project.id);
        return { ...project, items: count?.total ?? 0, open: count?.open ?? 0, overdue: count?.overdue ?? 0, canManage: this.canManageProject(access, project) };
      });
  }

  requireProject(access, id) {
    const project = this.project(id);
    const visible = project ? this.visibleProjectIds(access) : null;
    if (!project || (visible !== null && !visible.has(id))) throw apiError('NOT_FOUND', '项目不存在，或者你没有权限查看');
    return project;
  }

  checkMembers(ids) {
    for (const id of ids) {
      const user = this.org.user(id);
      if (!user) throw apiError('NOT_FOUND', `成员 ${id} 不存在`);
    }
  }

  createProject(access, input) {
    if (!access.can('project.manage')) throw apiError('FORBIDDEN', '你没有“管项目”的权限，请找负责人或管理员建项目');
    if (input.startDate && input.endDate && input.endDate < input.startDate) throw apiError('INVALID_INPUT', '结束日期不能早于开始日期');
    return transaction(this.db, () => {
      const ownerId = input.ownerId ?? access.userId;
      this.checkMembers([ownerId, ...input.memberIds]);
      const at = now();
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO projects (name, description, owner_id, start_date, end_date, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(input.name, input.description ?? '', ownerId, input.startDate ?? null, input.endDate ?? null, access.userId, at, at);
      const id = Number(lastInsertRowid);
      this.writeMembers(id, input.memberIds);
      this.audit.record(access.user, 'project.create', input.name, { owner: this.org.user(ownerId).displayName, members: input.memberIds.length });
      return this.project(id);
    });
  }

  writeMembers(projectId, ids) {
    this.db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const id of ids) insert.run(projectId, id);
  }

  updateProject(access, id, input) {
    return transaction(this.db, () => {
      const project = this.requireProject(access, id);
      if (!this.canManageProject(access, project)) throw apiError('FORBIDDEN', '只有项目负责人、建项目的人（要有“管项目”权限）和管理员能改项目');
      const startDate = input.startDate === undefined ? project.startDate : input.startDate;
      const endDate = input.endDate === undefined ? project.endDate : input.endDate;
      if (startDate && endDate && endDate < startDate) throw apiError('INVALID_INPUT', '结束日期不能早于开始日期');
      const ownerId = input.ownerId === undefined ? project.ownerId : input.ownerId;
      if (ownerId) this.checkMembers([ownerId]);
      if (input.memberIds) this.checkMembers(input.memberIds);
      this.db.prepare('UPDATE projects SET name = ?, description = ?, owner_id = ?, start_date = ?, end_date = ?, status = ?, updated_at = ? WHERE id = ?').run(
        input.name ?? project.name, input.description ?? project.description, ownerId, startDate, endDate, input.status ?? project.status, now(), id);
      if (input.memberIds) this.writeMembers(id, input.memberIds);
      this.audit.record(access.user, 'project.update', project.name, input);
      return this.project(id);
    });
  }

  deleteProject(access, id) {
    transaction(this.db, () => {
      const project = this.requireProject(access, id);
      if (!this.canManageProject(access, project)) throw apiError('FORBIDDEN', '只有项目负责人、建项目的人（要有“管项目”权限）和管理员能删项目');
      const used = this.db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?').get(id).n;
      if (used) throw apiError('IN_USE', `项目里还有 ${used} 个事项（含回收站），不能删除；做完了可以把项目改成“已结束”`);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      this.audit.record(access.user, 'project.delete', project.name);
    });
  }

  // ---------- 看得到哪些事项 ----------

  /** 可见范围的 SQL 条件（事项表别名 w）。 */
  visibility(access) {
    if (access.admin || this.org.settings().workVisibility === 'all') return { sql: '1', params: [] };
    const scope = access.scopeUserIds();
    if (scope === null) return { sql: '1', params: [] };
    const me = access.userId;
    const parts = ['w.assignee_id = ?', 'w.creator_id = ?', 'w.waiting_on = ?',
      'EXISTS (SELECT 1 FROM work_item_people p WHERE p.item_id = w.id AND p.user_id = ?)',
      'w.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)',
      'w.project_id IN (SELECT id FROM projects WHERE owner_id = ?)'];
    const params = [me, me, me, me, me, me];
    if (scope.length > 1) { parts.push('w.assignee_id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(scope)); }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  /** 读一个能看到的事项；看不到、不存在、在回收站里都说不存在。 */
  requireItem(access, id) {
    const vis = this.visibility(access);
    const row = this.db.prepare(`SELECT w.* FROM work_items w WHERE w.id = ? AND w.deleted_at IS NULL AND ${vis.sql}`).get(id, ...vis.params);
    if (!row) throw apiError('NOT_FOUND', '事项不存在，或者你没有权限查看');
    return { ...row };
  }

  collaborators(itemId) { return this.db.prepare('SELECT user_id AS id FROM work_item_people WHERE item_id = ? ORDER BY user_id').all(itemId).map(row => row.id); }

  /** 这个人对这个事项能做什么。 */
  rights(access, row, collaboratorIds = this.collaborators(row.id)) {
    const me = access.userId;
    const owner = row.assignee_id === me;
    const inScope = access.inScope(row.assignee_id);
    const adjust = access.admin || (access.can('item.adjust') && inScope);
    const assign = access.admin || (access.can('item.assign') && inScope);
    const remove = access.admin || (access.can('item.delete') && inScope);
    const participant = owner || row.creator_id === me || row.waiting_on === me || collaboratorIds.includes(me);
    return { edit: owner || adjust, adjust, assign, delete: remove, comment: participant || adjust || assign };
  }

  summarize(row, ctx) {
    const type = ctx.types.get(row.type_id);
    const status = type?.statuses.find(entry => entry.key === row.status);
    const checklist = json(row.checklist, []);
    const overdue = Boolean(row.due_date && row.due_date < ctx.today && OPEN_CATEGORIES.includes(row.category));
    return {
      id: row.id, number: row.number, title: row.title,
      typeId: row.type_id, typeName: type?.name ?? '', projectId: row.project_id, projectName: row.project_id ? ctx.projects.get(row.project_id)?.name ?? '' : null,
      assigneeId: row.assignee_id, assigneeName: ctx.name(row.assignee_id), creatorId: row.creator_id, creatorName: ctx.name(row.creator_id),
      status: row.status, statusName: status?.name ?? row.status, category: row.category, priority: row.priority,
      startDate: row.start_date, dueDate: row.due_date, completedAt: row.completed_at,
      progress: computeProgress(row.category, checklist, row.progress), overdue, overdueDays: overdue ? daysBetween(row.due_date, ctx.today) : 0,
      waitingOn: row.waiting_on, waitingOnName: ctx.name(row.waiting_on), waitingNote: row.waiting_note,
      checklistDone: checklist.filter(item => item.done).length, checklistTotal: checklist.length,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  detail(access, row, ctx = this.lookups()) {
    const collaboratorIds = this.collaborators(row.id);
    const events = this.db.prepare('SELECT * FROM work_item_events WHERE item_id = ? ORDER BY id').all(row.id).map(event => ({
      id: event.id, at: event.at, actorId: event.actor_id, actorName: event.actor_name, via: event.via, viaName: event.via_name, kind: event.kind,
      changes: json(event.changes, []), comment: event.comment,
    }));
    return {
      ...this.summarize(row, ctx),
      progressManual: row.progress, content: row.content, checklist: json(row.checklist, []), refs: json(row.refs, []), fields: json(row.fields, {}),
      collaboratorIds, collaboratorNames: collaboratorIds.map(ctx.name),
      type: ctx.types.get(row.type_id) ?? null,
      rights: this.rights(access, row, collaboratorIds),
      events,
    };
  }

  get(access, id) { return this.detail(access, this.requireItem(access, id)); }

  // ---------- 查 ----------

  /**
   * 按条件查能看到的事项。filters：assigneeId、projectId、departmentId（负责人在这个部门或下级）、
   * category（某个大类，或 open 表示没做完的）、overdue、waitingOn、q（编号或标题里的字）、limit、offset。
   */
  search(access, filters = {}, { inScopeOnly = false } = {}) {
    const ctx = this.lookups();
    const vis = this.visibility(access);
    const where = ['w.deleted_at IS NULL', vis.sql], params = [...vis.params];
    if (inScopeOnly) {
      const scope = access.scopeUserIds();
      if (scope !== null) { where.push('w.assignee_id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(scope)); }
    }
    if (filters.assigneeId) { where.push('w.assignee_id = ?'); params.push(filters.assigneeId); }
    if (filters.projectId) { where.push('w.project_id = ?'); params.push(filters.projectId); }
    if (filters.typeId) { where.push('w.type_id = ?'); params.push(filters.typeId); }
    if (filters.waitingOn) { where.push('w.waiting_on = ?'); params.push(filters.waitingOn); }
    if (filters.departmentId) {
      const departments = [...this.roles.withDescendants([filters.departmentId])];
      where.push('w.assignee_id IN (SELECT id FROM users WHERE department_id IN (SELECT value FROM json_each(?)))');
      params.push(JSON.stringify(departments));
    }
    if (filters.category === 'open') where.push("w.category IN ('todo', 'doing', 'waiting')");
    else if (filters.category) { where.push('w.category = ?'); params.push(filters.category); }
    if (filters.overdue) { where.push("w.category IN ('todo', 'doing', 'waiting') AND w.due_date < ?"); params.push(ctx.today); }
    if (filters.dueBefore) { where.push('w.due_date <= ?'); params.push(filters.dueBefore); }
    if (filters.q) {
      const like = '%' + String(filters.q).replace(/[%_\\]/g, char => '\\' + char) + '%';
      where.push("(w.title LIKE ? ESCAPE '\\' OR w.number LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), WORK_LIMITS.page);
    const offset = Math.max(Number(filters.offset) || 0, 0);
    const sql = `FROM work_items w WHERE ${where.join(' AND ')}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params).n;
    const rows = this.db.prepare(`SELECT w.* ${sql} ORDER BY CASE WHEN w.category IN ('todo','doing','waiting') THEN 0 ELSE 1 END,
      CASE WHEN w.due_date IS NULL THEN 1 ELSE 0 END, w.due_date, CASE w.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, w.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { items: rows.map(row => this.summarize(row, ctx)), total, offset, limit, truncated: offset + rows.length < total };
  }

  /** 我的工作：我负责的没做完的、本周做完的，以及在等我答复的。 */
  mine(access) {
    const ctx = this.lookups();
    const me = access.userId;
    // 本周完成：完成时间按企业时区落在本周。先多取几天，再按本地日期筛。
    const since = new Date(Date.parse(ctx.weekStart + 'T00:00:00Z') - 2 * DAY).toISOString();
    const rows = this.db.prepare(`SELECT w.* FROM work_items w WHERE w.deleted_at IS NULL AND (
        (w.assignee_id = ? AND (w.category IN ('todo','doing','waiting') OR (w.category = 'done' AND w.completed_at >= ?)))
        OR (w.waiting_on = ? AND w.category IN ('todo','doing','waiting')))`).all(me, since, me);
    const timeZone = this.org.settings().timeZone;
    const items = [];
    for (const row of rows) {
      const item = this.summarize(row, ctx);
      const doneThisWeek = row.category === 'done' && row.completed_at && localDate(row.completed_at, timeZone) >= ctx.weekStart;
      if (row.category === 'done' && !doneThisWeek) continue;
      items.push({ ...item, mine: row.assignee_id === me, waitingMe: row.waiting_on === me && OPEN_CATEGORIES.includes(row.category), dueToday: OPEN_CATEGORIES.includes(row.category) && row.due_date === ctx.today, doneThisWeek: Boolean(doneThisWeek) });
    }
    const own = items.filter(item => item.mine);
    return {
      today: ctx.today, weekday: ctx.weekday, weekStart: ctx.weekStart, weekEnd: ctx.weekEnd,
      summary: {
        overdue: own.filter(item => item.overdue).length,
        dueToday: own.filter(item => item.dueToday).length,
        doing: own.filter(item => item.category === 'doing').length,
        waitingMe: items.filter(item => item.waitingMe).length,
        doneThisWeek: own.filter(item => item.doneThisWeek).length,
      },
      items,
    };
  }

  /** 团队看板：先看各下级部门的汇总，点一个部门进去是同样的表，再点一个人看他的事项。 */
  board(access, { departmentId = null, projectId = null, includeSelf = false } = {}) {
    if (!access.board) throw apiError('FORBIDDEN', '你没有看团队看板的权限，或者还不是任何部门的负责人');
    const ctx = this.lookups();
    const departments = this.org.departments();
    const allowed = new Set(access.boardDepartments(departments));
    const wide = access.admin || access.scope === 'all';
    const childrenOf = parent => departments.filter(department => (department.parentId ?? null) === parent);
    const managers = this.roles.allManagers();
    // 管理范围的人看到的最上一层：他管的部门里，上级不在他范围里的那些。
    const roots = wide ? null : departments.filter(department => allowed.has(department.id) && !(department.parentId && allowed.has(department.parentId)));
    let current = departmentId;
    if (current !== null && !allowed.has(current)) throw apiError('NOT_FOUND', '部门不存在，或者不在你的管理范围里');
    if (current === null && roots?.length === 1) current = roots[0].id;
    const childDepartments = current !== null ? childrenOf(current) : wide ? childrenOf(null) : roots;
    const active = [...ctx.users.entries()].filter(([, user]) => user.status === 'active');
    const directMembers = current !== null ? active.filter(([, user]) => user.departmentId === current)
      : wide ? active.filter(([, user]) => !user.departmentId || !departments.some(department => department.id === user.departmentId)) : [];
    const skip = id => !includeSelf && id === access.userId;
    const peopleOf = departmentIdValue => {
      const ids = this.roles.withDescendants([departmentIdValue]);
      return active.filter(([id, user]) => ids.has(user.departmentId) && !skip(id)).map(([id]) => id);
    };
    const groups = childDepartments.map(department => ({ department, people: peopleOf(department.id) }));
    const direct = directMembers.map(([id]) => id).filter(id => !skip(id));
    const everyone = new Set([...groups.flatMap(group => group.people), ...direct]);

    const stats = new Map([...everyone].map(id => [id, { open: 0, doing: 0, overdue: 0, waiting: 0, doneThisWeek: 0, waitingFor: new Set() }]));
    const since = new Date(Date.parse(ctx.weekStart + 'T00:00:00Z') - 2 * DAY).toISOString();
    const timeZone = this.org.settings().timeZone;
    const rows = this.db.prepare(`SELECT assignee_id, category, due_date, completed_at, waiting_on FROM work_items WHERE deleted_at IS NULL
      AND assignee_id IN (SELECT value FROM json_each(?)) ${projectId ? 'AND project_id = ?' : ''}
      AND (category IN ('todo','doing','waiting') OR (category = 'done' AND completed_at >= ?))`)
      .all(JSON.stringify([...everyone]), ...(projectId ? [projectId] : []), since);
    for (const row of rows) {
      const entry = stats.get(row.assignee_id);
      if (!entry) continue;
      if (OPEN_CATEGORIES.includes(row.category)) {
        entry.open += 1;
        if (row.category === 'doing') entry.doing += 1;
        if (row.category === 'waiting') entry.waiting += 1;
        if (row.due_date && row.due_date < ctx.today) {
          entry.overdue += 1;
          // 等待中的照样算逾期，标出在等谁。
          if (row.waiting_on) entry.waitingFor.add(ctx.name(row.waiting_on));
        }
      } else if (row.completed_at && localDate(row.completed_at, timeZone) >= ctx.weekStart) entry.doneThisWeek += 1;
    }
    const sum = ids => ids.reduce((total, id) => {
      const entry = stats.get(id);
      for (const key of ['open', 'doing', 'overdue', 'waiting', 'doneThisWeek']) total[key] += entry[key];
      return total;
    }, { open: 0, doing: 0, overdue: 0, waiting: 0, doneThisWeek: 0 });
    const plain = entry => ({ open: entry.open, doing: entry.doing, overdue: entry.overdue, waiting: entry.waiting, doneThisWeek: entry.doneThisWeek });

    const currentDepartment = current !== null ? departments.find(department => department.id === current) : null;
    const trail = [];
    for (let walk = currentDepartment; walk; walk = walk.parentId ? departments.find(department => department.id === walk.parentId) : null) {
      trail.unshift({ id: walk.id, name: walk.name });
      if (!wide && roots.some(root => root.id === walk.id)) break;
    }
    const visibleProjects = this.projects(access, { includeClosed: false }).map(project => ({ id: project.id, name: project.name }));
    return {
      today: ctx.today, weekStart: ctx.weekStart,
      current: currentDepartment ? { id: currentDepartment.id, name: currentDepartment.name } : null,
      title: currentDepartment?.name ?? (wide ? this.org.settings().orgName ?? '全企业' : '我管理的部门'),
      trail,
      people: everyone.size,
      summary: sum([...everyone]),
      departments: groups.map(({ department, people }) => ({
        id: department.id, name: department.name, people: people.length, managers: (managers.get(department.id) ?? []).map(ctx.name), ...sum(people),
      })),
      members: direct.map(id => ({ id, name: ctx.name(id), ...plain(stats.get(id)), waitingFor: [...stats.get(id).waitingFor] })),
      options: {
        departments: departments.filter(department => allowed.has(department.id)).map(department => ({ id: department.id, name: department.name, parentId: department.parentId })),
        projects: visibleProjects,
      },
      projectId,
    };
  }

  // ---------- 改 ----------

  checkUser(id, what) {
    const user = this.org.user(id);
    if (!user) throw apiError('NOT_FOUND', `${what}不存在`);
    if (user.status !== 'active') throw apiError('INVALID_INPUT', `${what}“${user.displayName}”的账号已停用`);
    return user;
  }

  checkFields(type, values) {
    const result = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      const field = type.fields.find(entry => entry.key === key);
      if (!field) throw apiError('INVALID_INPUT', `“${type.name}”没有专属字段 ${key}`);
      if (value === null || value === '') continue;
      if (field.kind === 'select' && !field.options.includes(value)) throw apiError('INVALID_INPUT', `“${field.name}”只能选：${field.options.join('、')}`);
      if (field.kind === 'date' && !schemas.date.safeParse(value).success) throw apiError('INVALID_INPUT', `“${field.name}”要写成 2026-11-02 这样的日期`);
      result[key] = value;
    }
    return result;
  }

  checkRefs(refs) {
    for (const ref of refs) {
      if (!this.db.prepare("SELECT 1 FROM items WHERE kind = 'knowledge' AND slug = ?").get(ref.slug)) throw apiError('INVALID_INPUT', `引用的知识空间“${ref.slug}”不存在`);
    }
    return refs;
  }

  nextNumber(prefix, period) {
    const { last } = this.db.prepare(`INSERT INTO work_item_counters (prefix, period, last) VALUES (?, ?, 1)
      ON CONFLICT(prefix, period) DO UPDATE SET last = last + 1 RETURNING last`).get(prefix, period);
    return `${prefix}-${period}-${String(last).padStart(3, '0')}`;
  }

  event(itemId, actor, via, kind, { changes = null, comment = null } = {}) {
    this.db.prepare('INSERT INTO work_item_events (item_id, at, actor_id, actor_name, via, via_name, kind, changes, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      itemId, now(), actor?.id ?? null, actor?.displayName ?? null, via?.kind ?? 'ui', via?.name ?? null, kind, changes ? JSON.stringify(changes) : null, comment);
  }

  viaLabel(via) { return via?.kind === 'model' ? (via.name ? `经${via.name}` : '经模型') : via?.kind === 'import' ? '导入' : '本人操作'; }

  /** 新建事项。给自己建要“新建事项”；指给别人要“派事项”，并且那个人在自己的范围里。 */
  create(access, input, { via = { kind: 'ui' } } = {}) {
    return transaction(this.db, () => {
      const type = input.typeId ? this.type(input.typeId) : this.defaultType();
      if (!type) throw apiError('NOT_FOUND', '事项类型不存在');
      if (type.archived) throw apiError('INVALID_INPUT', `类型“${type.name}”已经停用，换一个类型`);
      const assigneeId = input.assigneeId ?? access.userId;
      if (assigneeId === access.userId) {
        if (!access.can('item.create')) throw apiError('FORBIDDEN', '你的角色不能新建事项，请找负责人或管理员');
      } else {
        if (!access.can('item.assign')) throw apiError('FORBIDDEN', '你没有“派事项”的权限，只能给自己建事项');
        if (!access.inScope(assigneeId)) throw apiError('FORBIDDEN', '这个人不在你的管理范围里，不能指给他');
      }
      this.checkUser(assigneeId, '负责人');
      const status = input.status ? type.statuses.find(entry => entry.key === input.status) : type.statuses.find(entry => entry.category === 'todo') ?? type.statuses[0];
      if (!status) throw apiError('INVALID_INPUT', `“${type.name}”没有这个状态，能用的有：${type.statuses.map(entry => `${entry.name}（${entry.key}）`).join('、')}`);
      if (input.projectId) {
        const project = this.requireProject(access, input.projectId);
        if (project.status !== 'active') throw apiError('INVALID_INPUT', `项目“${project.name}”已经结束`);
      }
      if (input.waitingOn) this.checkUser(input.waitingOn, '在等的人');
      for (const id of input.collaboratorIds ?? []) this.checkUser(id, '协作人');
      if (input.startDate && input.dueDate && input.dueDate < input.startDate) throw apiError('INVALID_INPUT', '截止日期不能早于开始日期');
      const fields = this.checkFields(type, input.fields);
      const refs = this.checkRefs(input.refs ?? []);
      const at = now();
      const number = this.nextNumber(type.prefix, this.calendar().period);
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO work_items (number, type_id, project_id, title, assignee_id, creator_id, status, category, priority,
        start_date, due_date, completed_at, progress, waiting_on, waiting_note, content, checklist, refs, fields, revision, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
        number, type.id, input.projectId ?? null, input.title, assigneeId, access.userId, status.key, status.category, input.priority ?? 'medium',
        input.startDate ?? null, input.dueDate ?? null, status.category === 'done' ? at : null,
        ['doing', 'waiting'].includes(status.category) ? input.progress ?? null : null,
        input.waitingOn ?? null, input.waitingNote ?? '', input.content ?? '', JSON.stringify(input.checklist ?? []), JSON.stringify(refs), JSON.stringify(fields), at, at, access.userId);
      const id = Number(lastInsertRowid);
      const insert = this.db.prepare('INSERT OR IGNORE INTO work_item_people (item_id, user_id) VALUES (?, ?)');
      for (const userId of input.collaboratorIds ?? []) insert.run(id, userId);
      this.event(id, access.user, via, 'create');
      if (assigneeId !== access.userId) this.audit.record(access.user, 'work.assign', number, { title: input.title, assignee: this.org.user(assigneeId).displayName, via: this.viaLabel(via) });
      return this.get(access, id);
    });
  }

  /** 改事项：带上读到的修订号；每个字段按权限点核对；变化写进动态，截止日期、优先级、负责人另记操作记录。 */
  update(access, id, input, { via = { kind: 'ui' } } = {}) {
    return transaction(this.db, () => {
      const row = this.requireItem(access, id);
      if (row.revision !== input.baseRevision) throw apiError('CONFLICT', `事项 ${row.number} 刚被别人改过，请重新读取后再改`);
      const collaboratorIds = this.collaborators(id);
      const rights = this.rights(access, row, collaboratorIds);
      const ctx = this.lookups();
      const type = ctx.types.get(row.type_id);
      const need = (allowed, message) => { if (!allowed) throw apiError('FORBIDDEN', message); };
      const changes = [];
      const set = {};
      const change = (field, from, to, column, value) => { changes.push({ field, label: FIELD_LABELS[field], from, to }); set[column] = value; };

      if (input.title !== undefined && input.title !== row.title) { need(rights.edit, '只有负责人或有“调整事项”权限的人能改标题'); change('title', row.title, input.title, 'title', input.title); }
      let category = row.category;
      if (input.status !== undefined && input.status !== row.status) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能改状态');
        const next = type.statuses.find(entry => entry.key === input.status);
        if (!next) throw apiError('INVALID_INPUT', `“${type.name}”没有这个状态，能用的有：${type.statuses.map(entry => `${entry.name}（${entry.key}）`).join('、')}`);
        const previous = type.statuses.find(entry => entry.key === row.status);
        change('status', previous?.name ?? row.status, next.name, 'status', next.key);
        set.category = next.category;
        category = next.category;
        if (next.category === 'done' && row.category !== 'done') set.completed_at = now();
        if (next.category !== 'done') set.completed_at = null;
      }
      const checklist = input.checklist ?? json(row.checklist, []);
      if (input.checklist !== undefined && JSON.stringify(input.checklist) !== row.checklist) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能改检查项');
        const done = input.checklist.filter(item => item.done).length;
        change('checklist', null, `${done}/${input.checklist.length}`, 'checklist', JSON.stringify(input.checklist));
      }
      if (input.progress !== undefined && input.progress !== row.progress) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能改进度');
        // 未开始、已完成的进度是自动的；有检查项时按检查项算，手填的不用。
        if (['doing', 'waiting'].includes(category) && !checklist.length) change('progress', row.progress ?? 0, input.progress, 'progress', input.progress);
      }
      if (input.priority !== undefined && input.priority !== row.priority) {
        need(rights.adjust, '改优先级要有“调整事项”权限，并且这个事项在你的范围里');
        change('priority', PRIORITY_LABELS[row.priority], PRIORITY_LABELS[input.priority], 'priority', input.priority);
      }
      for (const [field, column] of [['startDate', 'start_date'], ['dueDate', 'due_date']]) {
        if (input[field] === undefined || input[field] === row[column]) continue;
        need(rights.adjust, `改${FIELD_LABELS[field]}要有“调整事项”权限，并且这个事项在你的范围里`);
        change(field, row[column], input[field], column, input[field]);
      }
      const start = set.start_date !== undefined ? set.start_date : row.start_date, due = set.due_date !== undefined ? set.due_date : row.due_date;
      if (start && due && due < start) throw apiError('INVALID_INPUT', '截止日期不能早于开始日期');
      if (input.assigneeId !== undefined && input.assigneeId !== row.assignee_id) {
        need(rights.assign, '改负责人要有“派事项”权限，并且这个事项在你的范围里');
        if (!access.inScope(input.assigneeId)) throw apiError('FORBIDDEN', '新的负责人不在你的管理范围里');
        this.checkUser(input.assigneeId, '负责人');
        change('assigneeId', ctx.name(row.assignee_id), ctx.name(input.assigneeId), 'assignee_id', input.assigneeId);
      }
      if (input.projectId !== undefined && input.projectId !== row.project_id) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能换项目');
        if (input.projectId) {
          const project = this.requireProject(access, input.projectId);
          if (project.status !== 'active') throw apiError('INVALID_INPUT', `项目“${project.name}”已经结束`);
        }
        change('projectId', row.project_id ? ctx.projects.get(row.project_id)?.name : null, input.projectId ? ctx.projects.get(input.projectId)?.name : null, 'project_id', input.projectId);
      }
      if (input.waitingOn !== undefined && input.waitingOn !== row.waiting_on) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能改“在等谁”');
        if (input.waitingOn) this.checkUser(input.waitingOn, '在等的人');
        change('waitingOn', ctx.name(row.waiting_on), ctx.name(input.waitingOn), 'waiting_on', input.waitingOn);
      }
      if (input.waitingNote !== undefined && input.waitingNote !== row.waiting_note) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能改“在等什么”');
        change('waitingNote', row.waiting_note, input.waitingNote, 'waiting_note', input.waitingNote);
      }
      if (input.content !== undefined && input.content !== row.content) { need(rights.edit, '只有负责人或有“调整事项”权限的人能改内容'); change('content', null, null, 'content', input.content); }
      if (input.refs !== undefined && JSON.stringify(input.refs) !== row.refs) {
        need(rights.edit, '只有负责人或有“调整事项”权限的人能改引用资料');
        change('refs', null, input.refs.map(ref => ref.title ?? ref.path).join('、'), 'refs', JSON.stringify(this.checkRefs(input.refs)));
      }
      if (input.fields !== undefined) {
        const fields = this.checkFields(type, input.fields);
        if (JSON.stringify(fields) !== row.fields) { need(rights.edit, '只有负责人或有“调整事项”权限的人能改专属字段'); change('fields', null, null, 'fields', JSON.stringify(fields)); }
      }
      let people = null;
      if (input.collaboratorIds !== undefined) {
        const next = [...new Set(input.collaboratorIds)].sort((a, b) => a - b);
        if (!sameList(next, collaboratorIds)) {
          need(rights.edit || rights.assign, '只有负责人或有“调整事项”“派事项”权限的人能改协作人');
          for (const userId of next.filter(userId => !collaboratorIds.includes(userId))) this.checkUser(userId, '协作人');
          changes.push({ field: 'collaboratorIds', label: FIELD_LABELS.collaboratorIds, from: collaboratorIds.map(ctx.name).join('、'), to: next.map(ctx.name).join('、') });
          people = next;
        }
      }
      if (input.comment !== undefined) need(rights.comment || rights.edit, '你不能在这个事项里写动态');
      if (!changes.length && input.comment === undefined) return this.detail(access, row, ctx);

      if (changes.length || people) {
        const columns = Object.keys(set);
        const assignments = [...columns.map(column => `${column} = ?`), 'revision = revision + 1', 'updated_at = ?', 'updated_by = ?'];
        this.db.prepare(`UPDATE work_items SET ${assignments.join(', ')} WHERE id = ?`).run(...columns.map(column => set[column]), now(), access.userId, id);
        if (people) {
          this.db.prepare('DELETE FROM work_item_people WHERE item_id = ?').run(id);
          const insert = this.db.prepare('INSERT INTO work_item_people (item_id, user_id) VALUES (?, ?)');
          for (const userId of people) insert.run(id, userId);
        }
      }
      this.event(id, access.user, via, changes.length ? 'update' : 'comment', { changes: changes.length ? changes : null, comment: input.comment ?? null });
      const sensitive = changes.filter(entry => AUDITED.has(entry.field));
      if (sensitive.length) {
        this.audit.record(access.user, sensitive.some(entry => entry.field === 'assigneeId') ? 'work.assign' : 'work.adjust', row.number,
          { title: row.title, changes: sensitive.map(entry => `${entry.label}：${entry.from ?? '无'} → ${entry.to ?? '无'}`), via: this.viaLabel(via) });
      }
      return this.get(access, id);
    });
  }

  comment(access, id, text, { via = { kind: 'ui' } } = {}) {
    return transaction(this.db, () => {
      const row = this.requireItem(access, id);
      const rights = this.rights(access, row);
      if (!rights.comment) throw apiError('FORBIDDEN', '只有负责人、协作人、创建人、被等的人，以及范围内能调整事项的人能写动态');
      this.event(id, access.user, via, 'comment', { comment: text });
      return this.get(access, id);
    });
  }

  /** 删除先进回收站，管理员能恢复；彻底删除只能在服务器上用命令行。模型不能删。 */
  remove(access, id) {
    transaction(this.db, () => {
      const row = this.requireItem(access, id);
      if (!this.rights(access, row).delete) throw apiError('FORBIDDEN', '删除要有“删除事项”权限，并且这个事项在你的范围里');
      this.db.prepare('UPDATE work_items SET deleted_at = ?, deleted_by = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), access.userId, now(), id);
      this.event(id, access.user, { kind: 'ui' }, 'delete');
      this.audit.record(access.user, 'work.delete', row.number, { title: row.title });
    });
  }

  trash() {
    const ctx = this.lookups();
    return this.db.prepare('SELECT * FROM work_items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500').all()
      .map(row => ({ ...this.summarize(row, ctx), deletedAt: row.deleted_at, deletedBy: row.deleted_by, deletedByName: ctx.name(row.deleted_by) }));
  }

  restore(access, id) {
    return transaction(this.db, () => {
      if (!access.admin) throw apiError('FORBIDDEN', '只有管理员能从回收站恢复');
      const row = this.db.prepare('SELECT * FROM work_items WHERE id = ? AND deleted_at IS NOT NULL').get(id);
      if (!row) throw apiError('NOT_FOUND', '回收站里没有这个事项');
      this.db.prepare('UPDATE work_items SET deleted_at = NULL, deleted_by = NULL, revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), id);
      this.event(id, access.user, { kind: 'ui' }, 'restore');
      this.audit.record(access.user, 'work.restore', row.number, { title: row.title });
      return this.get(access, id);
    });
  }

  /** 服务器上用命令行彻底删除回收站里的事项（超级管理员的操作，不在网页里）。 */
  purgeTrash({ olderThanDays = 0 } = {}) {
    return transaction(this.db, () => {
      const before = new Date(this.clock() - olderThanDays * DAY).toISOString();
      const rows = this.db.prepare('SELECT id, number, title FROM work_items WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(before);
      for (const row of rows) this.db.prepare('DELETE FROM work_items WHERE id = ?').run(row.id);
      if (rows.length) this.audit.record(null, 'work.purge', `${rows.length} 个事项`, { numbers: rows.map(row => row.number).slice(0, 200) });
      return rows.length;
    });
  }

  // ---------- 导入、导出 ----------

  /** 从表格导入：逐行校验，说清哪一行有什么问题；有问题时默认一个都不建，选了“跳过有问题的行”才只建好的。 */
  importRows(access, { rows, dryRun, skipInvalid }) {
    if (!access.admin) throw apiError('FORBIDDEN', '只有管理员能导入事项');
    const ctx = this.lookups();
    const problems = [], valid = [];
    rows.forEach((raw, index) => {
      const parsed = schemas.importRow.safeParse(raw);
      const fail = message => problems.push({ row: index + 1, message });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(`${issue.path.length ? FIELD_LABELS[issue.path[0]] ?? issue.path.join('.') : ''}${issue.path.length ? '：' : ''}${issue.message}`);
      }
      const row = parsed.data;
      const type = ctx.types.get(row.typeId);
      if (!type || type.archived) return fail('类型不存在或已停用');
      const status = type.statuses.find(entry => entry.key === row.status);
      if (!status) return fail(`“${type.name}”没有状态 ${row.status}`);
      const assignee = ctx.users.get(row.assigneeId);
      if (!assignee) return fail('负责人不存在');
      if (assignee.status !== 'active') return fail(`负责人“${assignee.name}”的账号已停用`);
      if (row.projectId && !ctx.projects.has(row.projectId)) return fail('项目不存在');
      if (row.startDate && row.dueDate && row.dueDate < row.startDate) return fail('截止日期早于开始日期');
      valid.push({ ...row, type, statusEntry: status });
    });
    if (dryRun || (problems.length && !skipInvalid)) return { created: 0, valid: valid.length, problems };
    return transaction(this.db, () => {
      const at = now(), period = ctx.period;
      for (const row of valid) {
        const number = this.nextNumber(row.type.prefix, period);
        const category = row.statusEntry.category;
        const { lastInsertRowid } = this.db.prepare(`INSERT INTO work_items (number, type_id, project_id, title, assignee_id, creator_id, status, category, priority,
          start_date, due_date, completed_at, progress, waiting_note, content, revision, created_at, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
          number, row.typeId, row.projectId ?? null, row.title, row.assigneeId, access.userId, row.status, category, row.priority ?? 'medium',
          row.startDate ?? null, row.dueDate ?? null, category === 'done' && row.completedAt ? `${row.completedAt}T12:00:00.000Z` : null,
          ['doing', 'waiting'].includes(category) ? row.progress ?? null : null, row.waitingNote ?? '', row.content ?? '', at, at, access.userId);
        this.event(Number(lastInsertRowid), access.user, { kind: 'import' }, 'import', { comment: row.sourceNumber ? `从表格导入，原编号 ${row.sourceNumber}` : '从表格导入' });
      }
      this.audit.record(access.user, 'work.import', `${valid.length} 个事项`, { skipped: problems.length });
      return { created: valid.length, valid: valid.length, problems };
    });
  }

  /** 导出范围内的事项，给 Excel 打开的 CSV（带 BOM）。 */
  exportCsv(access, filters) {
    if (!access.can('export')) throw apiError('FORBIDDEN', '你没有“导出”的权限');
    const items = [];
    for (let offset = 0; ; offset += WORK_LIMITS.page) {
      const page = this.search(access, { ...filters, limit: WORK_LIMITS.page, offset }, { inScopeOnly: true });
      items.push(...page.items);
      if (!page.truncated || items.length >= 20_000) break;
    }
    const header = ['编号', '标题', '类型', '项目', '负责人', '状态', '大类', '优先级', '开始日期', '截止日期', '完成时间', '进度', '逾期天数', '在等谁', '在等什么', '创建人', '创建时间', '更新时间'];
    const cell = value => {
      let text = value === null || value === undefined ? '' : String(value);
      // 防止表格软件把开头是 = + - @ 的内容当公式执行。
      if (/^[=+\-@]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const lines = [header, ...items.map(item => [item.number, item.title, item.typeName, item.projectName, item.assigneeName, item.statusName, CATEGORY_LABELS[item.category],
      PRIORITY_LABELS[item.priority], item.startDate, item.dueDate, item.completedAt, item.progress === null ? '' : `${item.progress}%`, item.overdueDays || '',
      item.waitingOnName, item.waitingNote, item.creatorName, item.createdAt, item.updatedAt])];
    this.audit.record(access.user, 'work.export', `${items.length} 个事项`, filters);
    return '﻿' + lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  overview() {
    const today = this.calendar().today;
    const row = this.db.prepare(`SELECT SUM(CASE WHEN deleted_at IS NULL AND category IN ('todo','doing','waiting') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN deleted_at IS NULL AND category IN ('todo','doing','waiting') AND due_date < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed FROM work_items`).get(today);
    const projects = this.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'active'").get().n;
    return { open: row.open ?? 0, overdue: row.overdue ?? 0, trashed: row.trashed ?? 0, projects };
  }
}
