// 角色和数据范围：角色 = 一组权限点 + 一个数据范围；上下级来自部门树和部门负责人。
// 管理员是系统里的最高权限，什么都能做；成员能做什么看他挂的角色。所有判断都在服务端做。
import { apiError, PERMISSIONS, SCOPE_LABELS } from '@whalewing-enterprise/shared';
import { transaction } from './db.js';

const now = () => new Date().toISOString();

/** 一个人在企业管理里的权限。每个请求现算，改了角色、部门、负责人马上生效。 */
export class Access {
  constructor({ user, admin, role, scope, permissions, managedRoots, managedSet, departmentOf }) {
    this.user = user;
    this.admin = admin;
    this.role = role;
    this.scope = scope;
    this.permissions = new Set(permissions);
    this.managedRoots = managedRoots;
    this.managedSet = managedSet;
    this.departmentOf = departmentOf;
  }

  get userId() { return this.user.id; }
  can(permission) { return this.admin || this.permissions.has(permission); }

  /** 这个人是不是在我的数据范围里。自己永远算在内。 */
  inScope(userId) {
    if (userId === this.user.id || this.admin || this.scope === 'all') return true;
    if (this.scope !== 'managed') return false;
    const department = this.departmentOf.get(userId);
    return department !== null && department !== undefined && this.managedSet.has(department);
  }

  /** 范围里的人：null 表示全企业。 */
  scopeUserIds() {
    if (this.admin || this.scope === 'all') return null;
    const ids = new Set([this.user.id]);
    if (this.scope === 'managed') for (const [userId, department] of this.departmentOf.entries()) if (department !== null && this.managedSet.has(department)) ids.add(userId);
    return [...ids];
  }

  /** 能不能看团队看板：有权限点，并且范围是全部，或者至少管一个部门。 */
  get board() {
    if (this.admin) return true;
    if (!this.permissions.has('board.view')) return false;
    return this.scope === 'all' || (this.scope === 'managed' && this.managedRoots.length > 0);
  }

  /** 看板上能选的部门：全部范围是整棵树，管理范围是他管的那些部门和下级。 */
  boardDepartments(allDepartments) {
    if (this.admin || this.scope === 'all') return allDepartments.map(department => department.id);
    if (this.scope === 'managed') return allDepartments.filter(department => this.managedSet.has(department.id)).map(department => department.id);
    return [];
  }

  describe(departmentName) {
    return {
      admin: this.admin,
      roleId: this.role?.id ?? null,
      roleName: this.admin ? '管理员' : this.role?.name ?? '没有角色',
      scope: this.scope,
      permissions: this.admin ? [...PERMISSIONS] : PERMISSIONS.filter(permission => this.permissions.has(permission)),
      managed: this.managedRoots.map(id => ({ id, name: departmentName(id) ?? '' })),
      board: this.board,
    };
  }
}

export class Roles {
  constructor(db, { org, audit }) {
    this.db = db;
    this.org = org;
    this.audit = audit;
  }

  // ---------- 角色 ----------

  row(raw) {
    return raw ? { id: raw.id, name: raw.name, preset: raw.preset, scope: raw.scope, permissions: JSON.parse(raw.permissions), sort: raw.sort } : null;
  }
  role(id) { return id ? this.row(this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id)) : null; }
  presetMember() { return this.row(this.db.prepare("SELECT * FROM roles WHERE preset = 'member'").get()); }

  list() {
    const counts = new Map(this.db.prepare("SELECT role_id AS id, COUNT(*) AS n FROM users WHERE role = 'member' AND status = 'active' GROUP BY role_id").all().map(row => [row.id, row.n]));
    const managers = new Set(this.db.prepare('SELECT DISTINCT user_id AS id FROM department_managers').all().map(row => row.id));
    const leadless = new Map(this.db.prepare("SELECT id, role_id FROM users WHERE role = 'member' AND status = 'active'").all()
      .filter(row => !managers.has(row.id)).reduce((map, row) => map.set(row.role_id, (map.get(row.role_id) ?? 0) + 1), new Map()));
    return this.db.prepare('SELECT * FROM roles ORDER BY sort, id').all().map(raw => {
      const role = this.row(raw);
      // 角色是“管理范围”但人还不是任何部门的负责人：实际上只能管自己，管理端提示。
      return { ...role, members: counts.get(role.id) ?? 0, notManaging: role.scope === 'managed' ? leadless.get(role.id) ?? 0 : 0 };
    });
  }

  checkName(name, exceptId) {
    const clash = this.db.prepare('SELECT id FROM roles WHERE name = ? AND id != ?').get(name, exceptId ?? 0);
    if (clash) throw apiError('EXISTS', `已经有叫“${name}”的角色了`);
  }

  create(actor, input) {
    return transaction(this.db, () => {
      this.checkName(input.name);
      const sort = this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM roles').get().next;
      const at = now();
      const { lastInsertRowid } = this.db.prepare('INSERT INTO roles (name, preset, scope, permissions, sort, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)')
        .run(input.name, input.scope, JSON.stringify(unique(input.permissions)), sort, at, at);
      this.audit.record(actor, 'role.create', input.name, { scope: SCOPE_LABELS[input.scope], permissions: input.permissions });
      return this.role(Number(lastInsertRowid));
    });
  }

  update(actor, id, input) {
    return transaction(this.db, () => {
      const current = this.role(id);
      if (!current) throw apiError('NOT_FOUND', '角色不存在');
      if (input.name !== undefined) this.checkName(input.name, id);
      this.db.prepare('UPDATE roles SET name = ?, scope = ?, permissions = ?, updated_at = ? WHERE id = ?').run(
        input.name ?? current.name, input.scope ?? current.scope, JSON.stringify(unique(input.permissions ?? current.permissions)), now(), id);
      this.audit.record(actor, 'role.update', current.name, { ...input, ...(input.scope ? { scope: SCOPE_LABELS[input.scope] } : {}) });
      return this.role(id);
    });
  }

  remove(actor, id) {
    transaction(this.db, () => {
      const current = this.role(id);
      if (!current) throw apiError('NOT_FOUND', '角色不存在');
      const users = this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(id).n;
      const invites = this.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE role_id = ? AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?').get(id, now()).n;
      if (users || invites) throw apiError('IN_USE', `还有 ${users} 个人、${invites} 个没用完的邀请用着“${current.name}”，先给他们换个角色、撤销邀请再删除`);
      this.db.prepare('UPDATE invites SET role_id = NULL WHERE role_id = ?').run(id);
      this.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
      this.audit.record(actor, 'role.delete', current.name);
    });
  }

  /** 新建成员、发邀请时用哪个角色：给了就核对存在，没给用预置的“成员”。 */
  resolveMemberRole(roleId) {
    if (roleId) {
      const role = this.role(roleId);
      if (!role) throw apiError('NOT_FOUND', '角色不存在，可能刚被删掉了，请刷新');
      return role;
    }
    const preset = this.presetMember() ?? this.row(this.db.prepare('SELECT * FROM roles ORDER BY sort, id LIMIT 1').get());
    if (!preset) throw apiError('INVALID_INPUT', '还没有任何角色。请先在“角色与权限”里建一个角色');
    return preset;
  }

  // ---------- 部门负责人 ----------

  managersOf(departmentId) {
    return this.db.prepare('SELECT user_id AS id FROM department_managers WHERE department_id = ? ORDER BY user_id').all(departmentId).map(row => row.id);
  }

  allManagers() {
    const map = new Map();
    for (const row of this.db.prepare('SELECT department_id AS d, user_id AS u FROM department_managers ORDER BY user_id').all()) {
      if (!map.has(row.d)) map.set(row.d, []);
      map.get(row.d).push(row.u);
    }
    return map;
  }

  setManagers(actor, departmentId, userIds) {
    return transaction(this.db, () => {
      const department = this.org.department(departmentId);
      if (!department) throw apiError('NOT_FOUND', '部门不存在');
      const ids = unique(userIds);
      for (const userId of ids) if (!this.org.user(userId)) throw apiError('NOT_FOUND', `成员 ${userId} 不存在`);
      this.db.prepare('DELETE FROM department_managers WHERE department_id = ?').run(departmentId);
      const insert = this.db.prepare('INSERT INTO department_managers (department_id, user_id) VALUES (?, ?)');
      for (const userId of ids) insert.run(departmentId, userId);
      this.audit.record(actor, 'department.managers', department.name, { managers: ids.map(userId => this.org.user(userId).displayName) });
      return ids;
    });
  }

  // ---------- 权限 ----------

  /** 部门 id 连同所有下级部门。 */
  withDescendants(ids) {
    const departments = this.org.departments();
    const result = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const department of departments) if (department.parentId && result.has(department.parentId) && !result.has(department.id)) { result.add(department.id); grew = true; }
    }
    return result;
  }

  access(user) {
    const managedRoots = this.db.prepare('SELECT department_id AS id FROM department_managers WHERE user_id = ? ORDER BY department_id').all(user.id).map(row => row.id);
    const departmentOf = new Map(this.db.prepare('SELECT id, department_id AS d FROM users').all().map(row => [row.id, row.d]));
    if (user.role === 'admin') {
      return new Access({ user, admin: true, role: null, scope: 'all', permissions: PERMISSIONS, managedRoots, managedSet: null, departmentOf });
    }
    const role = this.role(user.roleId);
    const scope = role?.scope ?? 'self';
    return new Access({
      user, admin: false, role, scope, permissions: role?.permissions ?? [], managedRoots,
      managedSet: scope === 'managed' ? this.withDescendants(managedRoots) : new Set(), departmentOf,
    });
  }
}

function unique(values) { return [...new Set(values)]; }
