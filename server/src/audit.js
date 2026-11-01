// 管理操作记录：谁在什么时候改了成员、权限和团队内容。只记管理动作，不记员工的会话。
export const ACTION_LABELS = Object.freeze({
  'setup': '初始化企业',
  'settings.update': '修改企业设置',
  'department.create': '新建部门',
  'department.update': '修改部门',
  'department.delete': '删除部门',
  'user.create': '新建成员',
  'user.update': '修改成员',
  'user.password': '修改密码',
  'invite.create': '发出邀请',
  'invite.revoke': '撤销邀请',
  'invite.use': '通过邀请加入',
  'item.create': '新建团队内容',
  'item.update': '修改团队内容设置',
  'item.delete': '删除团队内容',
  'file.write': '保存团队内容文件',
  'file.delete': '删除团队内容文件',
  'skill.upload': '上传技能压缩包',
});

const SECRET_KEYS = /password|token|code/i;

function scrub(detail) {
  if (!detail || typeof detail !== 'object') return detail ?? null;
  return Object.fromEntries(Object.entries(detail).filter(([key]) => !SECRET_KEYS.test(key)));
}

export class Audit {
  constructor(db) { this.db = db; }

  record(actor, action, target, detail) {
    this.db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
      new Date().toISOString(), actor?.id ?? null, actor ? `${actor.displayName}（${actor.username}）` : null,
      action, target ?? null, detail === undefined ? null : JSON.stringify(scrub(detail)));
  }

  list({ limit = 50, before, action, actorId } = {}) {
    const where = [], values = [];
    if (before) { where.push('id < ?'); values.push(before); }
    if (action) { where.push('action LIKE ?'); values.push(action.replace(/[%_]/g, '') + '%'); }
    if (actorId) { where.push('actor_id = ?'); values.push(actorId); }
    const sql = `SELECT id, at, actor_id AS actorId, actor_name AS actorName, action, target, detail FROM audit
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...values, Math.min(Math.max(limit, 1), 200)).map(row => ({
      ...row, label: ACTION_LABELS[row.action] ?? row.action, detail: row.detail ? JSON.parse(row.detail) : null,
    }));
  }
}
