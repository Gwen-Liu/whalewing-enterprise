// 接口的请求和返回定义，服务端校验收到的请求、员工端校验收到的返回，用的是同一份。
// 员工端跑在 DSH 里，用的是 DSH 自带的 zod（4.4），这里只用 4.4 就有的写法。
import { z } from 'zod';
import { PRODUCT, KINDS, ROLES, LIMITS } from './protocol.js';
import { SLUG } from './paths.js';

const id = z.number().int().positive();
const time = z.string();
const singleLine = (min, max) => z.string().trim().min(min).max(max).refine(value => !/[\r\n]/.test(value), '不能换行');

export const username = z.string().trim().min(2, '登录名至少 2 个字符').max(32, '登录名最多 32 个字符')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, '登录名只能用字母、数字、点、短横线和下划线，并以字母或数字开头');
export const displayName = singleLine(1, 40);
export const password = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
export const orgName = singleLine(1, 60);
export const slug = z.string().regex(SLUG, '标识只能用小写字母、数字和短横线，最长 64 个字符');
export const kind = z.enum(KINDS);
export const role = z.enum(ROLES);
export const publicUrl = z.string().trim().max(200).refine(value => {
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.search && !url.hash && !url.username; }
  catch { return false; }
}, '对外地址要写成 https://域名 的形式');

// ---------- 公开 ----------

export const hello = z.object({
  product: z.literal(PRODUCT),
  protocol: z.number().int(),
  serverVersion: z.string(),
  setupRequired: z.boolean(),
  orgName: z.string().nullable(),
});

export const inviteInfo = z.object({
  orgName: z.string(),
  department: z.string().nullable(),
  role,
  expiresAt: time,
});

export const setupInput = z.strictObject({
  setupCode: z.string().trim().min(1).max(32),
  orgName,
  username,
  displayName,
  password,
  publicUrl: publicUrl.optional(),
});

// ---------- 登录 ----------

export const loginInput = z.strictObject({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
  client: z.enum(['plugin', 'admin']),
});

export const joinInput = z.strictObject({
  code: z.string().trim().min(16).max(100),
  username,
  displayName,
  password,
});

export const changePasswordInput = z.strictObject({ oldPassword: z.string().min(1).max(128), newPassword: password });

export const userPublic = z.object({
  id,
  username: z.string(),
  displayName: z.string(),
  role,
  departmentId: id.nullable(),
  status: z.enum(['active', 'disabled']),
});

export const me = z.object({
  user: userPublic,
  department: z.object({ id, name: z.string(), path: z.array(z.string()) }).nullable(),
  org: z.object({ name: z.string(), offlineDays: z.number().int().positive() }),
});

export const session = z.object({ token: z.string().min(20), expiresAt: time, me });

// ---------- 同步 ----------

export const syncFile = z.object({ path: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() });
export const syncItem = z.object({
  kind,
  slug,
  title: z.string(),
  description: z.string(),
  revision: z.number().int().nonnegative(),
  canMaintain: z.boolean(),
  files: z.array(syncFile).max(LIMITS.itemFiles),
});
export const syncManifest = z.object({
  revision: z.number().int().nonnegative(),
  generatedAt: time,
  me,
  items: z.array(syncItem),
});

// ---------- 维护内容 ----------

export const writeFileInput = z.strictObject({
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  // 新建写 null；修改写读到的那一版的 hash，对不上服务端就拒收。
  baseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export const writeFileResult = z.object({ path: z.string(), hash: z.string(), size: z.number().int(), revision: z.number().int() });

// ---------- 管理 ----------

export const subject = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('all') }),
  z.strictObject({ type: z.literal('department'), id }),
  z.strictObject({ type: z.literal('user'), id }),
]);
export const access = z.strictObject({
  view: z.array(subject).max(200),
  maintain: z.array(subject).max(200),
});

export const itemInput = z.strictObject({
  kind,
  slug,
  title: singleLine(1, LIMITS.title),
  description: z.string().trim().max(LIMITS.description).default(''),
  access: access.optional(),
});
export const itemUpdate = z.strictObject({
  title: singleLine(1, LIMITS.title).optional(),
  description: z.string().trim().max(LIMITS.description).optional(),
  access: access.optional(),
});

export const departmentInput = z.strictObject({ name: singleLine(1, 40), parentId: id.nullable() });
export const departmentUpdate = z.strictObject({ name: singleLine(1, 40).optional(), parentId: id.nullable().optional() });

export const createUserInput = z.strictObject({
  username,
  displayName,
  password,
  role: z.enum(['admin', 'member']),
  departmentId: id.nullable(),
});
export const userUpdate = z.strictObject({
  displayName: displayName.optional(),
  role: z.enum(['admin', 'member']).optional(),
  departmentId: id.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const resetPasswordInput = z.strictObject({ password });

export const inviteInput = z.strictObject({
  departmentId: id.nullable(),
  role: z.enum(['admin', 'member']).default('member'),
  maxUses: z.number().int().min(1).max(500).default(1),
  days: z.number().int().min(1).max(90).optional(),
});

export const settingsUpdate = z.strictObject({
  orgName: orgName.optional(),
  publicUrl: publicUrl.nullable().optional(),
  offlineDays: z.number().int().min(1).max(90).optional(),
  inviteDays: z.number().int().min(1).max(90).optional(),
});
