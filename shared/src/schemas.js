// 接口的请求和返回定义，服务端校验收到的请求、员工端校验收到的返回，用的是同一份。
// 员工端跑在 DSH 里，用的是 DSH 自带的 zod（4.4），这里只用 4.4 就有的写法。
import { z } from 'zod';
import { PRODUCT, KINDS, ROLES, LIMITS, PERMISSIONS, SCOPES, CATEGORIES, PRIORITIES, FIELD_KINDS, WORK_VISIBILITY, WORK_LIMITS } from './protocol.js';
import { SLUG } from './paths.js';

const id = z.number().int().positive();
const time = z.string();
const singleLine = (min, max) => z.string().trim().min(min).max(max).refine(value => !/[\r\n]/.test(value), '不能换行');

export const username = z.string().trim().min(2, '登录名至少 2 个字符').max(32, '登录名最多 32 个字符')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, '登录名只能用字母、数字、点、短横线和下划线，并以字母或数字开头');
export const displayName = singleLine(1, 40);
export const password = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
export const orgName = singleLine(1, 60);
// 助手名称的规则照鲸翼个人版 ctx.whalewing.assistant.registerName：去掉首尾空白后 1–16 个字，一行，不带换行和控制字符。
// 个人版收到不合规的名字会拒收，所以服务端按同一条规则先拦下。
export const assistantName = z.string().trim().min(1, '助手名称不能为空').max(LIMITS.assistantName, `助手名称最长 ${LIMITS.assistantName} 个字`)
  .refine(value => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), '助手名称不能换行，也不能带控制字符');
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
  // 成员加入后挂的角色名，比如“成员”“小组长”。
  roleName: z.string().nullable().optional(),
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

// 这个人在企业管理里能做什么：只用来决定界面上显示哪些入口，真正的判断在服务端。
export const workAccess = z.object({
  admin: z.boolean(),
  roleId: id.nullable(),
  roleName: z.string(),
  scope: z.enum(SCOPES),
  permissions: z.array(z.string()),
  // 他担任负责人的部门（不含下级）。
  managed: z.array(z.object({ id, name: z.string() })),
  // 能不能看团队看板：有“看团队看板”权限，并且数据范围是全部，或者是管理范围且至少管一个部门。
  board: z.boolean(),
});

export const me = z.object({
  user: userPublic,
  department: z.object({ id, name: z.string(), path: z.array(z.string()) }).nullable(),
  org: z.object({
    name: z.string(),
    offlineDays: z.number().int().positive(),
    workVisibility: z.enum(WORK_VISIBILITY).optional(),
    timeZone: z.string().optional(),
    // 企业起的助手名称，null 表示不改名。员工端不在这里校验：名字不合规只是不改名，不能让整次同步失败。
    assistantName: z.string().nullable().optional(),
  }),
  access: workAccess.optional(),
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
  role: z.enum(ROLES),
  // 成员挂的角色；不填用预置的“成员”。管理员不挂角色。
  roleId: id.nullable().optional(),
  departmentId: id.nullable(),
});
export const userUpdate = z.strictObject({
  displayName: displayName.optional(),
  role: z.enum(ROLES).optional(),
  roleId: id.nullable().optional(),
  departmentId: id.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const resetPasswordInput = z.strictObject({ password });

export const inviteInput = z.strictObject({
  departmentId: id.nullable(),
  role: z.enum(ROLES).default('member'),
  roleId: id.nullable().optional(),
  maxUses: z.number().int().min(1).max(500).default(1),
  days: z.number().int().min(1).max(90).optional(),
});

export const settingsUpdate = z.strictObject({
  orgName: orgName.optional(),
  publicUrl: publicUrl.nullable().optional(),
  offlineDays: z.number().int().min(1).max(90).optional(),
  inviteDays: z.number().int().min(1).max(90).optional(),
  workVisibility: z.enum(WORK_VISIBILITY).optional(),
  timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, '时区要写成 Asia/Shanghai 这样的写法').optional(),
  // null 表示不改名，员工的鲸翼里用“小鲸助手”。
  assistantName: assistantName.nullable().optional(),
});

function isTimeZone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

// ---------- 角色和部门负责人 ----------

export const roleInput = z.strictObject({
  name: singleLine(1, 24),
  scope: z.enum(SCOPES),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});
export const roleUpdate = z.strictObject({
  name: singleLine(1, 24).optional(),
  scope: z.enum(SCOPES).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
});
export const managersInput = z.strictObject({ userIds: z.array(id).max(20) });

// ---------- 事项 ----------

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期要写成 2026-11-02 这样').refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '没有这一天');
// 经谁改的：界面上点的是 ui；小鲸或专家通过 team_work 工具改的是 model，name 写专家名（知道的话）。
export const via = z.strictObject({ kind: z.enum(['ui', 'model']), name: singleLine(1, 40).optional() });
export const checklistItem = z.strictObject({ text: singleLine(1, WORK_LIMITS.checklistText), done: z.boolean().default(false) });
export const knowledgeRef = z.strictObject({ slug, path: z.string().min(1).max(LIMITS.pathChars), title: z.string().max(200).optional() });
const fieldValue = z.union([z.string().max(500), z.null()]);

const itemFields = {
  title: singleLine(1, WORK_LIMITS.title),
  projectId: id.nullable(),
  assigneeId: id,
  status: z.string().min(1).max(24),
  priority: z.enum(PRIORITIES),
  startDate: date.nullable(),
  dueDate: date.nullable(),
  progress: z.number().int().min(0).max(100).nullable(),
  waitingOn: id.nullable(),
  waitingNote: z.string().trim().max(WORK_LIMITS.waitingNote),
  content: z.string().max(WORK_LIMITS.content),
  checklist: z.array(checklistItem).max(WORK_LIMITS.checklist),
  refs: z.array(knowledgeRef).max(WORK_LIMITS.refs),
  fields: z.record(z.string().max(24), fieldValue),
  collaboratorIds: z.array(id).max(WORK_LIMITS.collaborators),
};
const optionalFields = Object.fromEntries(Object.entries(itemFields).map(([key, schema]) => [key, schema.optional()]));

export const workItemCreate = z.strictObject({
  ...optionalFields,
  title: itemFields.title,
  typeId: id.optional(),
  via: via.optional(),
});
export const workItemUpdate = z.strictObject({
  ...optionalFields,
  // 读到的那一版的修订号；对不上就拒收，免得覆盖别人刚改的。
  baseRevision: z.number().int().positive(),
  comment: z.string().trim().min(1).max(WORK_LIMITS.comment).optional(),
  via: via.optional(),
});
export const workComment = z.strictObject({ text: z.string().trim().min(1).max(WORK_LIMITS.comment), via: via.optional() });

const key = z.string().regex(/^[a-z0-9_-]{1,24}$/);
const typeName = singleLine(1, 20);
const typePrefix = z.string().trim().regex(/^[A-Z][A-Z0-9]{0,5}$/, '编号前缀用 1 到 6 个大写字母或数字，以字母开头，例如 KF');
const typeStatuses = z.array(z.strictObject({ key: key.optional(), name: singleLine(1, 20), category: z.enum(CATEGORIES) })).min(1, '至少要有一个状态').max(WORK_LIMITS.statuses);
const typeFields = z.array(z.strictObject({
  key: key.optional(),
  name: singleLine(1, 20),
  kind: z.enum(FIELD_KINDS),
  options: z.array(singleLine(1, 40)).max(WORK_LIMITS.options).optional(),
})).max(WORK_LIMITS.fields, `专属字段最多 ${WORK_LIMITS.fields} 个`);
export const workTypeInput = z.strictObject({ name: typeName, prefix: typePrefix, statuses: typeStatuses, fields: typeFields.default([]) });
export const workTypeUpdate = z.strictObject({
  name: typeName.optional(),
  prefix: typePrefix.optional(),
  statuses: typeStatuses.optional(),
  fields: typeFields.optional(),
  archived: z.boolean().optional(),
});

export const projectInput = z.strictObject({
  name: singleLine(1, 60),
  description: z.string().trim().max(LIMITS.description).default(''),
  ownerId: id.nullable().optional(),
  startDate: date.nullable().optional(),
  endDate: date.nullable().optional(),
  memberIds: z.array(id).max(500).default([]),
});
export const projectUpdate = z.strictObject({
  name: singleLine(1, 60).optional(),
  description: z.string().trim().max(LIMITS.description).optional(),
  ownerId: id.nullable().optional(),
  startDate: date.nullable().optional(),
  endDate: date.nullable().optional(),
  memberIds: z.array(id).max(500).optional(),
  status: z.enum(['active', 'closed']).optional(),
});

// 从表格导入：管理端在浏览器里把列对到字段、把旧状态对到新状态，发过来的是整理好的行。
export const importRow = z.strictObject({
  title: itemFields.title,
  typeId: id,
  status: z.string().min(1).max(24),
  assigneeId: id,
  priority: z.enum(PRIORITIES).optional(),
  projectId: id.nullable().optional(),
  startDate: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  // 旧系统里的完成日期；不填时，导入的已完成事项不算进“本周完成”。
  completedAt: date.nullable().optional(),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  content: z.string().max(WORK_LIMITS.content).optional(),
  waitingNote: z.string().trim().max(WORK_LIMITS.waitingNote).optional(),
  sourceNumber: z.string().trim().max(60).optional(),
});
export const importInput = z.strictObject({
  // 每一行原样带上，服务端逐行校验，说清哪一行有什么问题。
  rows: z.array(z.unknown()).min(1).max(WORK_LIMITS.importRows),
  dryRun: z.boolean().default(false),
  skipInvalid: z.boolean().default(false),
});
