// 团队专家用的是和鲸翼个人版完全相同的专家模板格式（个人版 features/experts/template.js，Apache-2.0）：
// 开头用 --- 包住 name、description、skills、avatar，下面的正文是提示词。
// 这里按同样的规则重写一份，服务端保存前和员工端使用前都用它校验，三边认的是同一种文件。
//
// ---
// name: 售前专家
// description: 招投标响应、客户方案和汇报材料。
// skills:
//   - whalewing-writing
// avatar: preset-01
// ---
// 正文……

export const expertLimits = Object.freeze({ chars: 65536, name: 40, description: 240, prompt: 32000, skills: 40 });
const keys = ['name', 'description', 'skills', 'avatar'];
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function templateError(message) {
  return Object.assign(new Error(`专家模板格式不对：${message}`), { code: 'INVALID_INPUT' });
}

const unquote = value => /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;

export function parseExpertTemplate(text) {
  if (typeof text !== 'string' || !text.trim()) throw templateError('文件是空的');
  if (text.length > expertLimits.chars) throw templateError(`超过 ${expertLimits.chars} 个字符`);
  const source = text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');
  const match = source.match(/^---\n([^]*?)\n---(?:\n([^]*))?$/u);
  if (!match) throw templateError('开头要用两行 --- 包住名称、介绍和技能');
  const fields = {};
  let list = null;
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(\S.*)$/u);
    if (item) {
      if (!list) throw templateError(`“${line.trim()}”不在 skills: 下面`);
      list.push(unquote(item[1].trim()));
      continue;
    }
    const pair = line.match(/^([a-z]+):(.*)$/u);
    if (!pair || !keys.includes(pair[1])) throw templateError(`看不懂这一行：${line.trim()}（只认 ${keys.join('、')}）`);
    const [, key, raw] = pair;
    if (Object.hasOwn(fields, key)) throw templateError(`${key} 写了两次`);
    if (key === 'skills') {
      if (raw.trim()) throw templateError('skills 要逐行写成“  - 技能名”');
      fields.skills = list = [];
    } else { fields[key] = unquote(raw.trim()); list = null; }
  }
  const prompt = (match[2] ?? '').trim();
  const { name = '', description = '', skills = [], avatar } = fields;
  if (!name || [...name].length > expertLimits.name) throw templateError(`name 需要 1 到 ${expertLimits.name} 个字`);
  if (!description || [...description].length > expertLimits.description) throw templateError(`description 需要 1 到 ${expertLimits.description} 个字`);
  if (!prompt || prompt.length > expertLimits.prompt) throw templateError(`正文（提示词）需要 1 到 ${expertLimits.prompt} 个字`);
  if (skills.length > expertLimits.skills) throw templateError(`技能最多 ${expertLimits.skills} 项`);
  for (const skill of skills) if (!skillName.test(skill) || skill.length > 100) throw templateError(`技能名“${skill}”只能用小写字母、数字和连字符`);
  if (new Set(skills).size !== skills.length) throw templateError('技能有重复');
  if (avatar !== undefined && avatar !== '' && !/^[a-z0-9-]{1,40}$/u.test(avatar)) throw templateError('avatar 只能写头像标识（例如 preset-01）');
  return { name, description, prompt, skills, avatar: avatar || null };
}

// 解析时只去掉最外面一对引号，所以直接包一层双引号就行，里面有引号也不用转义。
const quoteIfNeeded = value => /[:#]|^["']/u.test(value) ? `"${value}"` : value;

/** 把专家字段写回模板文件；管理端表单保存时用。 */
export function renderExpertTemplate({ name, description, skills = [], avatar, prompt }) {
  const lines = ['---', `name: ${quoteIfNeeded(name)}`, `description: ${quoteIfNeeded(description)}`];
  if (skills.length) { lines.push('skills:'); for (const skill of skills) lines.push(`  - ${skill}`); }
  if (avatar) lines.push(`avatar: ${avatar}`);
  lines.push('---', prompt.trim(), '');
  const text = lines.join('\n');
  parseExpertTemplate(text);
  return text;
}
