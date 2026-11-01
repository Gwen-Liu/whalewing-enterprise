// 员工端和服务端共用的常量。接口版本只在改名、删字段或改变行为时加 1，只加字段不变。
export const PRODUCT = 'whalewing-enterprise';
export const PROTOCOL_VERSION = 1;
export const API_PREFIX = '/api/v1';

// 三类团队内容。knowledge 是知识空间，里面放多篇笔记；expert 是一位专家；skill 是一个技能目录。
export const KINDS = Object.freeze(['knowledge', 'expert', 'skill']);
export const KIND_LABELS = Object.freeze({ knowledge: '知识空间', expert: '专家', skill: '技能' });
export const ROLES = Object.freeze(['owner', 'admin', 'member']);
export const ROLE_LABELS = Object.freeze({ owner: '所有者', admin: '管理员', member: '成员' });

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
});

// 员工端离线时缓存还能用几天，以及邀请默认几天有效；管理端可以改。
export const DEFAULTS = Object.freeze({ offlineDays: 7, inviteDays: 7, port: 8730 });
