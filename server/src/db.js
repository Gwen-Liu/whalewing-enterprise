import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 数据库结构的版本。改结构时在 MIGRATIONS 末尾追加一步，不改已有的步骤。
const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES departments(id),
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    department_id INTEGER REFERENCES departments(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    code_hint TEXT NOT NULL,
    department_id INTEGER REFERENCES departments(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('plugin', 'admin')),
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE login_failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, locked_until TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'expert', 'skill')),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    UNIQUE (kind, slug)
  );
  CREATE TABLE files (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    PRIMARY KEY (item_id, path),
    UNIQUE (item_id, path_key)
  );
  CREATE TABLE access (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('view', 'maintain')),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('all', 'department', 'user')),
    subject_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, mode, subject_type, subject_id)
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit(at);
  `,
  // 2：企业管理第二版。所有者 → 管理员（管理员之间平级）；成员挂自定义角色（权限点 + 数据范围）；
  // 部门负责人决定上下级；加事项、事项类型、项目、动态和回收站。
  // 第一版的数据：所有者变管理员，管理员不变，成员挂预置角色“成员”；没用完的邀请也挂“成员”；
  // 团队内容的可见范围和维护人不动。users.role 的 CHECK 里还留着 'owner'，程序不再写它。
  `
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    preset TEXT UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('self', 'managed', 'all')),
    permissions TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO roles (name, preset, scope, permissions, sort, created_at, updated_at) VALUES
    ('负责人', 'lead', 'managed', '["item.create","item.assign","item.adjust","board.view","report.manage","project.manage","export"]', 1,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('成员', 'member', 'self', '["item.create"]', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id);
  UPDATE users SET role = 'admin' WHERE role = 'owner';
  UPDATE users SET role_id = (SELECT id FROM roles WHERE preset = 'member') WHERE role = 'member';
  ALTER TABLE invites ADD COLUMN role_id INTEGER REFERENCES roles(id);
  UPDATE invites SET role_id = (SELECT id FROM roles WHERE preset = 'member') WHERE role = 'member';

  CREATE TABLE department_managers (
    department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (department_id, user_id)
  );
  CREATE INDEX department_managers_user ON department_managers(user_id);

  CREATE TABLE work_item_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    prefix TEXT NOT NULL UNIQUE,
    statuses TEXT NOT NULL,
    fields TEXT NOT NULL DEFAULT '[]',
    sort INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO work_item_types (name, prefix, statuses, fields, sort, created_at, updated_at) VALUES ('任务', 'RW',
    '[{"key":"todo","name":"未开始","category":"todo"},{"key":"doing","name":"进行中","category":"doing"},{"key":"waiting","name":"等待中","category":"waiting"},{"key":"done","name":"已完成","category":"done"},{"key":"cancelled","name":"已取消","category":"cancelled"}]',
    '[]', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER REFERENCES users(id),
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX project_members_user ON project_members(user_id);

  -- 编号 = 类型前缀-年月-序号；删掉的号不再用，所以序号单独记。
  CREATE TABLE work_item_counters (prefix TEXT NOT NULL, period TEXT NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (prefix, period));

  CREATE TABLE work_items (
    id INTEGER PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    type_id INTEGER NOT NULL REFERENCES work_item_types(id),
    project_id INTEGER REFERENCES projects(id),
    title TEXT NOT NULL,
    assignee_id INTEGER NOT NULL REFERENCES users(id),
    creator_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('todo', 'doing', 'waiting', 'done', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
    start_date TEXT,
    due_date TEXT,
    completed_at TEXT,
    progress INTEGER,
    waiting_on INTEGER REFERENCES users(id),
    waiting_note TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    checklist TEXT NOT NULL DEFAULT '[]',
    refs TEXT NOT NULL DEFAULT '[]',
    fields TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    deleted_at TEXT,
    deleted_by INTEGER REFERENCES users(id)
  );
  CREATE INDEX work_items_assignee ON work_items(assignee_id, category);
  CREATE INDEX work_items_project ON work_items(project_id);
  CREATE INDEX work_items_waiting ON work_items(waiting_on);
  CREATE INDEX work_items_due ON work_items(due_date);

  CREATE TABLE work_item_people (
    item_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (item_id, user_id)
  );
  CREATE INDEX work_item_people_user ON work_item_people(user_id);

  CREATE TABLE work_item_events (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    via TEXT NOT NULL DEFAULT 'ui' CHECK (via IN ('ui', 'model', 'import')),
    via_name TEXT,
    kind TEXT NOT NULL,
    changes TEXT,
    comment TEXT
  );
  CREATE INDEX work_item_events_item ON work_item_events(item_id, id);
  `,
];

/** 只给测试用：造一个指定版本的旧数据库，验证升级。 */
export const MIGRATIONS_FOR_TEST = MIGRATIONS;

export const SCHEMA_VERSION = MIGRATIONS.length;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** 打开数据目录里的数据库；需要升级结构时先备份到 backups/ 再升级。 */
export function openDatabase(dataDir, { log = () => {} } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'whalewing-enterprise.db');
  const existed = existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`数据目录是更新版本的服务端写的（数据版本 ${current}，这个程序只认到 ${SCHEMA_VERSION}），请换回新版程序，不要用旧版打开`);
  }
  if (existed && current > 0 && current < SCHEMA_VERSION) {
    const backups = path.join(dataDir, 'backups');
    mkdirSync(backups, { recursive: true });
    const target = path.join(backups, `whalewing-enterprise-${stamp()}-v${current}.db`);
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    log(`数据要从版本 ${current} 升级到 ${SCHEMA_VERSION}，已先备份到 ${target}`);
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}

/** 在一个事务里跑 fn；fn 里抛错就整个回滚。 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 备份：数据库用 VACUUM INTO 拿到一致的副本，正在运行时也能用。 */
export function backupDatabase(db, targetFile) {
  db.exec(`VACUUM INTO '${targetFile.replaceAll("'", "''")}'`);
}
