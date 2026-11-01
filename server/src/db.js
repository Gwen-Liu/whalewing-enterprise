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
];

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
