// 员工端界面共用的小工具。组件和样式只用鲸翼工作台公开的 workbench.ui 和 ww-* 类，颜色只借 DSH 的变量。
import * as React from 'react';
import { assistantNames } from '@whalewing-enterprise/shared/protocol';
import { input } from './contract.js';

export const ROLE = { admin: '管理员', member: '成员' };

/** 界面上怎么称呼小鲸：鲸翼里现在用的是企业起的名字就用它（全名，没有简称），否则是“小鲸助手”“小鲸”。 */
export const assistantOf = status => assistantNames(status?.assistantName);

export async function call(remote, raw, signal) {
  const value = input.parse(raw);
  signal?.throwIfAborted();
  const reply = await remote.manage(value, signal);
  signal?.throwIfAborted();
  if (reply?.ok !== true) throw Object.assign(new Error(reply?.error?.message || '没有拿到结果，请刷新后再试'), { code: reply?.error?.code });
  return reply.value;
}

export const ago = value => {
  if (!value) return '还没同步过';
  const diff = Date.now() - Date.parse(value);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
};

export function Field({ label, hint, children }) {
  return <label className="ww-field" style={{ display: 'grid', gap: 4 }}><span>{label}</span>{children}{hint && <span className="ww-muted" style={{ fontSize: 12 }}>{hint}</span>}</label>;
}

/** 一组控件（单选、复选）用分组容器，免得点说明文字误触第一个控件。 */
export function Group({ label, hint, children }) {
  return <div className="ww-field" role="group" aria-label={label} style={{ display: 'grid', gap: 4 }}><span>{label}</span>{children}{hint && <span className="ww-muted" style={{ fontSize: 12 }}>{hint}</span>}</div>;
}

export const inputStyle = { width: '100%', boxSizing: 'border-box' };

// DSH 的颜色变量，跟随皮肤；括号里是没有皮肤变量时的兜底色。
export const COLORS = {
  border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
  layer: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
  muted: 'var(--dsw-alias-label-secondary, inherit)',
  brand: 'var(--dsw-alias-brand-primary, #1677c8)',
  danger: 'var(--dsw-alias-state-error-primary, #d1242f)',
  warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
  success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
};
