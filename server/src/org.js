// 企业、账号、部门、邀请和登录。所有判断都在服务端做，员工端和管理端只负责显示。
import { apiError, DEFAULTS, PROTOCOL_VERSION, PRODUCT } from '@whalewing-enterprise/shared';
import { transaction } from './db.js';
import { burnPasswordCheck, hashPassword, randomToken, sha256, verifyPassword } from './secrets.js';

const now = () => new Date().toISOString();
const addMs = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

export const SESSION_TTL = { plugin: 30 * DAY, admin: 12 * 60 * 60 * 1000 };
const LOCK = { username: 5, ip: 30, ms: 15 * 60 * 1000 };

export class Org {
  constructor(db, { version, audit }) {
    this.db = db;
    this.version = version;
    this.audit = audit;
  }

  // ---------- 企业设置 ----------

  meta(key) { return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key, value) {
    if (value === null || value === undefined) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
  get isSetUp() { return this.meta('org_name') !== null; }

  settings() {
    return {
      orgName: this.meta('org_name'),
      publicUrl: this.meta('public_url'),
      offlineDays: Number(this.meta('offline_days') ?? DEFAULTS.offlineDays),
      inviteDays: Number(this.meta('invite_days') ?? DEFAULTS.inviteDays),
      workVisibility: this.meta('work_visibility') ?? DEFAULTS.workVisibility,
      timeZone: this.meta('time_zone') ?? DEFAULTS.timeZone,
    };
  }

  updateSettings(actor, input) {
    transaction(this.db, () => {
      if (input.orgName !== undefined) this.setMeta('org_name', input.orgName);
      if (input.publicUrl !== undefined) this.setMeta('public_url', input.publicUrl ? input.publicUrl.replace(/\/+$/, '') : null);
      if (input.offlineDays !== undefined) this.setMeta('offline_days', input.offlineDays);
      if (input.inviteDays !== undefined) this.setMeta('invite_days', input.inviteDays);
      if (input.workVisibility !== undefined) this.setMeta('work_visibility', input.workVisibility);
      if (input.timeZone !== undefined) this.setMeta('time_zone', input.timeZone);
      this.audit.record(actor, 'settings.update', '企业设置', input);
    });
    return this.settings();
  }

  hello() {
    return { product: PRODUCT, protocol: PROTOCOL_VERSION, serverVersion: this.version, setupRequired: !this.isSetUp, orgName: this.meta('org_name') };
  }

  async setup(input) {
    if (this.isSetUp) throw apiError('SETUP_DONE');
    const hash = await hashPassword(input.password);
    return transaction(this.db, () => {
      if (this.isSetUp) throw apiError('SETUP_DONE');
      this.setMeta('org_name', input.orgName);
      if (input.publicUrl) this.setMeta('public_url', input.publicUrl.replace(/\/+$/, ''));
      this.setMeta('created_at', now());
      // 初始化时建的第一个账号就是一个普通的管理员；管理员之间平级。
      const user = this.insertUser({ username: input.username, displayName: input.displayName, hash, role: 'admin', roleId: null, departmentId: null });
      this.audit.record(user, 'setup', input.orgName, { username: input.username });
      return user;
    });
  }

  // ---------- 部门 ----------

  departments() {
    return this.db.prepare('SELECT id, name, parent_id AS parentId, sort, created_at AS createdAt FROM departments ORDER BY sort, id').all()
      .map(row => ({ ...row }));
  }
  department(id) {
    const row = this.db.prepare('SELECT id, name, parent_id AS parentId FROM departments WHERE id = ?').get(id);
    return row ? { ...row } : null;
  }
  /** 从这个部门一直往上到最顶层的部门 id，含自己。 */
  ancestors(id) {
    const chain = [];
    const seen = new Set();
    let current = id ? this.department(id) : null;
    while (current && !seen.has(current.id)) {
      seen.add(current.id); chain.push(current);
      current = current.parentId ? this.department(current.parentId) : null;
    }
    return chain;
  }
  departmentPath(id) { return this.ancestors(id).reverse().map(item => item.name); }

  /** 管理端用的部门列表：每个部门带上负责人。 */
  departmentsWithManagers() {
    const managers = this.roles.allManagers();
    return this.departments().map(department => ({ ...department, managerIds: managers.get(department.id) ?? [] }));
  }

  createDepartment(actor, { name, parentId }) {
    return transaction(this.db, () => {
      if (parentId && !this.department(parentId)) throw apiError('NOT_FOUND', '上级部门不存在');
      const sort = this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM departments WHERE parent_id IS ?').get(parentId ?? null).next;
      const { lastInsertRowid } = this.db.prepare('INSERT INTO departments (name, parent_id, sort, created_at) VALUES (?, ?, ?, ?)').run(name, parentId ?? null, sort, now());
      this.audit.record(actor, 'department.create', name, { parentId });
      return this.department(Number(lastInsertRowid));
    });
  }

  updateDepartment(actor, id, input) {
    return transaction(this.db, () => {
      const current = this.department(id);
      if (!current) throw apiError('NOT_FOUND', '部门不存在');
      if (input.parentId !== undefined && input.parentId !== null) {
        if (!this.department(input.parentId)) throw apiError('NOT_FOUND', '上级部门不存在');
        if (this.ancestors(input.parentId).some(item => item.id === id)) throw apiError('INVALID_INPUT', '不能把部门移到它自己或它的下级部门下面');
      }
      if (input.name !== undefined) this.db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(input.name, id);
      if (input.parentId !== undefined) this.db.prepare('UPDATE departments SET parent_id = ? WHERE id = ?').run(input.parentId, id);
      this.audit.record(actor, 'department.update', current.name, input);
      return this.department(id);
    });
  }

  deleteDepartment(actor, id) {
    transaction(this.db, () => {
      const current = this.department(id);
      if (!current) throw apiError('NOT_FOUND', '部门不存在');
      const children = this.db.prepare('SELECT COUNT(*) AS n FROM departments WHERE parent_id = ?').get(id).n;
      const members = this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE department_id = ?').get(id).n;
      const invites = this.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE department_id = ? AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?").get(id, now()).n;
      if (children || members || invites) throw apiError('IN_USE', `部门里还有 ${children} 个下级部门、${members} 个成员、${invites} 个没用完的邀请，先移走或撤销再删除`);
      this.db.prepare("DELETE FROM access WHERE subject_type = 'department' AND subject_id = ?").run(id);
      this.db.prepare('UPDATE invites SET department_id = NULL WHERE department_id = ?').run(id);
      this.db.prepare('DELETE FROM departments WHERE id = ?').run(id);
      this.audit.record(actor, 'department.delete', current.name);
    });
  }

  // ---------- 账号 ----------

  insertUser({ username, displayName, hash, role, roleId, departmentId }) {
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw apiError('EXISTS', `登录名“${username}”已经有人用了`);
    if (departmentId && !this.department(departmentId)) throw apiError('NOT_FOUND', '部门不存在');
    const at = now();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO users (username, display_name, password_hash, role, role_id, department_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'active\', ?, ?)',
    ).run(username, displayName, hash, role, role === 'admin' ? null : roleId ?? null, departmentId ?? null, at, at);
    return this.user(Number(lastInsertRowid));
  }

  user(id) {
    const row = this.db.prepare(`SELECT id, username, display_name AS displayName, role, role_id AS roleId, department_id AS departmentId, status,
      created_at AS createdAt, last_seen_at AS lastSeenAt FROM users WHERE id = ?`).get(id);
    return row ? { ...row } : null;
  }

  users() {
    return this.db.prepare(`SELECT id, username, display_name AS displayName, role, role_id AS roleId, department_id AS departmentId, status,
      created_at AS createdAt, last_seen_at AS lastSeenAt FROM users ORDER BY id`).all().map(row => ({ ...row }));
  }

  publicUser(user) {
    return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, departmentId: user.departmentId, status: user.status };
  }

  me(user) {
    const settings = this.settings();
    const department = user.departmentId ? this.department(user.departmentId) : null;
    return {
      user: this.publicUser(user),
      department: department ? { id: department.id, name: department.name, path: this.departmentPath(department.id) } : null,
      org: { name: settings.orgName ?? '', offlineDays: settings.offlineDays, workVisibility: settings.workVisibility, timeZone: settings.timeZone },
      access: this.roles.access(user).describe(id => this.department(id)?.name),
    };
  }

  activeAdmins() { return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n; }

  async createUser(actor, input) {
    const hash = await hashPassword(input.password);
    return transaction(this.db, () => {
      const roleId = input.role === 'admin' ? null : this.roles.resolveMemberRole(input.roleId).id;
      const user = this.insertUser({ ...input, roleId, hash });
      this.audit.record(actor, 'user.create', input.username, { role: input.role, roleName: input.role === 'admin' ? '管理员' : this.roles.role(roleId).name, departmentId: input.departmentId });
      return user;
    });
  }

  /**
   * 管理员之间平级：都能任命、停用别的管理员。最后一个启用的管理员不能被停用或降成成员；
   * 自己不能停用自己、不能把自己降成成员（免得把自己关在外面，请另一位管理员来做）。
   */
  updateUser(actor, id, input) {
    return transaction(this.db, () => {
      const target = this.user(id);
      if (!target) throw apiError('NOT_FOUND', '成员不存在');
      const demoting = target.role === 'admin' && input.role === 'member';
      const disabling = target.status === 'active' && input.status === 'disabled';
      if (target.id === actor.id && disabling) throw apiError('FORBIDDEN', '不能停用自己。需要的话请另一位管理员来做');
      if (target.id === actor.id && demoting) throw apiError('FORBIDDEN', '不能把自己改成成员。需要的话请另一位管理员来做');
      if (target.role === 'admin' && target.status === 'active' && (demoting || disabling) && this.activeAdmins() <= 1) {
        throw apiError('FORBIDDEN', '这是最后一个启用的管理员，不能停用或改成成员。先任命另一位管理员');
      }
      if (input.departmentId && !this.department(input.departmentId)) throw apiError('NOT_FOUND', '部门不存在');
      const role = input.role ?? target.role;
      let roleId = target.roleId;
      if (role === 'admin') roleId = null;
      else if (input.roleId !== undefined || target.role === 'admin' || !roleId) roleId = this.roles.resolveMemberRole(input.roleId ?? null).id;
      const fields = [], values = [];
      if (input.displayName !== undefined) { fields.push('display_name = ?'); values.push(input.displayName); }
      if (input.role !== undefined) { fields.push('role = ?'); values.push(input.role); }
      if (roleId !== target.roleId) { fields.push('role_id = ?'); values.push(roleId); }
      if (input.departmentId !== undefined) { fields.push('department_id = ?'); values.push(input.departmentId); }
      if (input.status !== undefined) { fields.push('status = ?'); values.push(input.status); }
      if (!fields.length) return target;
      fields.push('updated_at = ?'); values.push(now());
      this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
      // 停用和改身份马上生效：作废这个人所有已登录的地方。只换角色不用重新登录，权限每次请求现算。
      if (input.status === 'disabled' || (input.role !== undefined && input.role !== target.role)) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.audit.record(actor, 'user.update', target.username, { ...input, ...(roleId !== target.roleId && roleId ? { roleName: this.roles.role(roleId).name } : {}) });
      return this.user(id);
    });
  }

  async resetPassword(actor, id, password) {
    const target = this.user(id);
    if (!target) throw apiError('NOT_FOUND', '成员不存在');
    // 管理员之间平级，谁都能重置别人的密码（包括别的管理员），都记进操作记录。
    const hash = await hashPassword(password);
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.audit.record(actor, 'user.password', target.username);
    });
  }

  async changeOwnPassword(user, oldPassword, newPassword, keepSessionHash) {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!row || !(await verifyPassword(oldPassword, row.password_hash))) throw apiError('AUTH_INVALID', '原密码不对');
    const hash = await hashPassword(newPassword);
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), user.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, keepSessionHash ?? '');
      this.audit.record(user, 'user.password', user.username, { self: true });
    });
  }

  // ---------- 登录 ----------

  lockState(key) {
    const row = this.db.prepare('SELECT count, locked_until FROM login_failures WHERE key = ?').get(key);
    return row && row.locked_until && row.locked_until > now() ? row.locked_until : null;
  }

  recordFailure(key, limit) {
    const row = this.db.prepare('SELECT count, updated_at FROM login_failures WHERE key = ?').get(key);
    const fresh = row && Date.parse(row.updated_at) > Date.now() - LOCK.ms;
    const count = fresh ? row.count + 1 : 1;
    const locked = count >= limit ? addMs(LOCK.ms) : null;
    this.db.prepare(`INSERT INTO login_failures (key, count, locked_until, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until, updated_at = excluded.updated_at`)
      .run(key, locked ? 0 : count, locked, now());
  }

  async login({ username, password, client }, ip) {
    if (!this.isSetUp) throw apiError('SETUP_REQUIRED');
    const userKey = 'u:' + username.toLowerCase(), ipKey = 'ip:' + ip;
    if (this.lockState(userKey) || this.lockState(ipKey)) throw apiError('AUTH_LOCKED');
    const row = this.db.prepare('SELECT id, password_hash, status, role FROM users WHERE username = ?').get(username);
    const ok = row ? await verifyPassword(password, row.password_hash) : (await burnPasswordCheck(password), false);
    if (!ok) {
      this.recordFailure(userKey, LOCK.username);
      this.recordFailure(ipKey, LOCK.ip);
      throw apiError('AUTH_INVALID');
    }
    this.db.prepare('DELETE FROM login_failures WHERE key = ?').run(userKey);
    if (row.status !== 'active') throw apiError('ACCOUNT_DISABLED');
    if (client === 'admin' && row.role === 'member') throw apiError('FORBIDDEN', '这个账号不是管理员，不能登录管理端；员工请在鲸翼的「团队」页签登录');
    return this.createSession(row.id, client);
  }

  createSession(userId, kind) {
    const token = randomToken();
    const at = now(), expiresAt = addMs(SESSION_TTL[kind]);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, kind, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, kind, at, at, expiresAt);
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, userId);
    const user = this.user(userId);
    return { token, expiresAt, me: this.me(user) };
  }

  /** 按令牌找到登录的人；过期、停用都按对应原因拒绝。用过的令牌往后顺延有效期。 */
  authenticate(token, kind) {
    if (!token) throw apiError('AUTH_REQUIRED');
    const hash = sha256(token);
    const row = this.db.prepare('SELECT id, user_id, kind, last_used_at, expires_at FROM sessions WHERE token_hash = ?').get(hash);
    if (!row || row.kind !== kind) throw apiError('AUTH_EXPIRED');
    if (row.expires_at <= now()) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      throw apiError('AUTH_EXPIRED');
    }
    const user = this.user(row.user_id);
    if (!user || user.status !== 'active') throw apiError('ACCOUNT_DISABLED');
    if (kind === 'admin' && user.role === 'member') throw apiError('FORBIDDEN');
    // 一小时最多顺延一次，免得每个请求都写库。
    if (Date.parse(row.last_used_at) < Date.now() - 60 * 60 * 1000) {
      const at = now();
      this.db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(at, addMs(SESSION_TTL[kind]), row.id);
      this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, user.id);
    }
    return { user, tokenHash: hash };
  }

  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); }

  pruneSessions() {
    const at = now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at);
    this.db.prepare('DELETE FROM login_failures WHERE updated_at <= ? AND (locked_until IS NULL OR locked_until <= ?)').run(addMs(-LOCK.ms), at);
  }

  // ---------- 邀请 ----------

  createInvite(actor, input) {
    if (input.departmentId && !this.department(input.departmentId)) throw apiError('NOT_FOUND', '部门不存在');
    const code = randomToken(24);
    const days = input.days ?? this.settings().inviteDays;
    const expiresAt = addMs(days * DAY);
    return transaction(this.db, () => {
      const roleId = input.role === 'admin' ? null : this.roles.resolveMemberRole(input.roleId).id;
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO invites (code_hash, code_hint, department_id, role, role_id, max_uses, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(code), code.slice(0, 6), input.departmentId ?? null, input.role, roleId, input.maxUses, expiresAt, actor.id, now());
      this.audit.record(actor, 'invite.create', `邀请 ${code.slice(0, 6)}…`, { departmentId: input.departmentId, role: input.role, roleName: roleId ? this.roles.role(roleId).name : '管理员', maxUses: input.maxUses, days });
      return { ...this.invite(Number(lastInsertRowid)), code };
    });
  }

  invite(id) {
    const row = this.db.prepare(`SELECT id, code_hint AS hint, department_id AS departmentId, role, role_id AS roleId, max_uses AS maxUses, uses,
      expires_at AS expiresAt, created_at AS createdAt, revoked_at AS revokedAt FROM invites WHERE id = ?`).get(id);
    return row ? { ...row, active: !row.revokedAt && row.uses < row.maxUses && row.expiresAt > now() } : null;
  }

  invites() {
    return this.db.prepare('SELECT id FROM invites ORDER BY id DESC LIMIT 200').all().map(row => this.invite(row.id));
  }

  revokeInvite(actor, id) {
    const invite = this.invite(id);
    if (!invite) throw apiError('NOT_FOUND', '邀请不存在');
    this.db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
    this.audit.record(actor, 'invite.revoke', `邀请 ${invite.hint}…`);
    return this.invite(id);
  }

  findInvite(code) {
    const row = this.db.prepare('SELECT id FROM invites WHERE code_hash = ?').get(sha256(code));
    if (!row) throw apiError('INVITE_INVALID');
    const invite = this.invite(row.id);
    if (!invite.active) throw apiError('INVITE_EXPIRED');
    return invite;
  }

  inviteInfo(code) {
    if (!this.isSetUp) throw apiError('SETUP_REQUIRED');
    const invite = this.findInvite(code);
    const department = invite.departmentId ? this.departmentPath(invite.departmentId).join(' / ') : null;
    const roleName = invite.role === 'admin' ? '管理员' : this.roles.role(invite.roleId)?.name ?? this.roles.presetMember()?.name ?? null;
    return { orgName: this.meta('org_name'), department, role: invite.role, roleName, expiresAt: invite.expiresAt };
  }

  async join(input) {
    if (!this.isSetUp) throw apiError('SETUP_REQUIRED');
    this.findInvite(input.code);
    const hash = await hashPassword(input.password);
    return transaction(this.db, () => {
      const invite = this.findInvite(input.code);
      // 邀请里的角色被删掉了就用预置的“成员”，不让邀请链接因此失效。
      const roleId = invite.role === 'admin' ? null : (this.roles.role(invite.roleId) ?? this.roles.resolveMemberRole(null)).id;
      const user = this.insertUser({ username: input.username, displayName: input.displayName, hash, role: invite.role, roleId, departmentId: invite.departmentId });
      this.db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
      this.audit.record(user, 'invite.use', `邀请 ${invite.hint}…`, { username: input.username });
      return this.createSession(user.id, 'plugin');
    });
  }
}
