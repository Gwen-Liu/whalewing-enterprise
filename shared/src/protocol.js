// 员工端和服务端共用的常量。接口版本只在改名、删字段或改变行为时加 1，只加字段不变。
// 2：去掉“所有者”，管理员之间平级；成员挂自定义角色（权限点 + 数据范围）；加了事项和项目。
export const PRODUCT = 'whalewing-enterprise';
export const PROTOCOL_VERSION = 2;
export const API_PREFIX = '/api/v1';

// 这一版员工端适配的 DSH 版本（和员工端 package.json 的 engines.dsh 一致），以及要的鲸翼个人版最低版本：
// 专家来源、知识来源（0.2.1-rc.5.2 起）和助手名称（0.2.1-rc.5.4 起）三样接口；DSH 0.2.2-rc.1 上能加载的个人版从 0.2.2-rc.1.1 起。
// 员工端启动时按它报“个人版太旧”，服务端的邀请说明页按它写要装哪一版。
export const DSH_VERSION = '0.2.2-rc.1';
export const PERSONAL_MIN_VERSION = '0.2.2-rc.1.1';

// 三类团队内容。knowledge 是知识空间，里面放多篇笔记；expert 是一位专家；skill 是一个技能目录。
export const KINDS = Object.freeze(['knowledge', 'expert', 'skill']);
export const KIND_LABELS = Object.freeze({ knowledge: '知识空间', expert: '专家', skill: '技能' });

// 系统里只有两种身份：管理员（最高，可以有多个）和成员。成员能做什么由他挂的角色决定。
// 超级管理员不在系统里：是项目维护者，或者管服务器的人，在系统之外（代码、服务器、数据库）。
export const ROLES = Object.freeze(['admin', 'member']);
export const ROLE_LABELS = Object.freeze({ admin: '管理员', member: '成员' });

// 权限点故意只有这几个。管组织和人员、管角色、事项类型、企业设置、从回收站恢复只给管理员，不在这里。
export const PERMISSIONS = Object.freeze(['item.create', 'item.assign', 'item.adjust', 'item.delete', 'board.view', 'report.manage', 'project.manage', 'export']);
export const PERMISSION_LABELS = Object.freeze({
  'item.create': '新建事项',
  'item.assign': '派事项',
  'item.adjust': '调整事项',
  'item.delete': '删除事项',
  'board.view': '看团队看板',
  'report.manage': '管填报',
  'project.manage': '管项目',
  'export': '导出',
});
export const PERMISSION_HINTS = Object.freeze({
  'item.create': '给自己建事项',
  'item.assign': '给范围内的人建事项、改事项的负责人',
  'item.adjust': '改范围内事项的截止日期、优先级、状态',
  'item.delete': '把范围内的事项放进回收站',
  'board.view': '看范围内的汇总和每个人的事项',
  'report.manage': '给范围内的人建日报、周报这类填报表（填报第三版上线）',
  'project.manage': '建项目、管项目成员',
  'export': '把范围内的事项导出成表格',
});

// 数据范围：能管谁的事项。管理范围 = 他担任负责人的部门，连同下级部门。
export const SCOPES = Object.freeze(['self', 'managed', 'all']);
export const SCOPE_LABELS = Object.freeze({ self: '仅本人', managed: '管理范围', all: '全部' });

// 事项的五个状态大类。各类型的状态叫法可以不同，统计都按大类算。
export const CATEGORIES = Object.freeze(['todo', 'doing', 'waiting', 'done', 'cancelled']);
export const CATEGORY_LABELS = Object.freeze({ todo: '未开始', doing: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' });
export const OPEN_CATEGORIES = Object.freeze(['todo', 'doing', 'waiting']);
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const PRIORITY_LABELS = Object.freeze({ high: '高', medium: '中', low: '低' });
export const FIELD_KINDS = Object.freeze(['select', 'text', 'date']);
export const FIELD_KIND_LABELS = Object.freeze({ select: '单选', text: '文本', date: '日期' });

// 事项默认谁能看：scope = 数据范围里的 + 自己参与的 + 同项目的；all = 全员可见。
export const WORK_VISIBILITY = Object.freeze(['scope', 'all']);

// 助手名称：鲸翼自带的助手默认叫“小鲸助手”，简称“小鲸”。企业在企业设置里起的名字没有简称，
// 原来写“小鲸”的地方也用全名（和鲸翼个人版的规则一样）。
export const DEFAULT_ASSISTANT_NAME = Object.freeze({ full: '小鲸助手', short: '小鲸' });
export const assistantNames = custom => custom ? { full: custom, short: custom } : DEFAULT_ASSISTANT_NAME;

export const LIMITS = Object.freeze({
  noteBytes: 1_000_000,
  expertBytes: 65_536,
  skillFileBytes: 5_000_000,
  skillArchiveBytes: 20_000_000,
  skillFiles: 200,
  itemFiles: 5000,
  pathChars: 240,
  segmentChars: 120,
  title: 60,
  description: 240,
  // 和鲸翼个人版 ctx.whalewing.assistant.registerName 的上限一样。
  assistantName: 16,
});

export const WORK_LIMITS = Object.freeze({
  title: 120,
  content: 20_000,
  checklist: 50,
  checklistText: 200,
  comment: 2000,
  waitingNote: 200,
  statuses: 12,
  fields: 5,
  options: 20,
  collaborators: 20,
  refs: 20,
  // 模型一次调用最多改这么多个事项。
  batch: 20,
  importRows: 2000,
  page: 200,
});

// 员工端离线时缓存还能用几天，以及邀请默认几天有效；管理端可以改。
// 时区决定“今天”“本周”和编号里的年月，默认北京时间。
export const DEFAULTS = Object.freeze({ offlineDays: 7, inviteDays: 7, port: 8730, timeZone: 'Asia/Shanghai', workVisibility: 'scope' });
