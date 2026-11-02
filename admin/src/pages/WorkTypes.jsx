import { useCallback, useEffect, useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, FIELD_KIND_LABELS, FIELD_KINDS } from '@whalewing-enterprise/shared/protocol';
import { useApp } from '../context.js';
import { ActionMenu, AddCard, ConfirmDialog, Drawer, Field, PageHeader, useToast } from '../ui.jsx';

const BLANK_STATUSES = [
  { name: '未开始', category: 'todo' }, { name: '进行中', category: 'doing' }, { name: '等待中', category: 'waiting' },
  { name: '已完成', category: 'done' }, { name: '已取消', category: 'cancelled' },
];

export function WorkTypesPage() {
  const { call } = useApp();
  const notify = useToast();
  const [types, setTypes] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call('GET', '/admin/work-types').then(data => setTypes(data.types)).catch(error => notify(error.message, { kind: 'error', action: { label: '重试', run: load } })), [call, notify]);
  useEffect(() => { load(); }, [load]);
  const run = async (task, success) => {
    setBusy(true);
    try { const result = await task(); await load(); if (success) notify(success); return result; }
    catch (error) { notify(error.message, { kind: 'error' }); throw error; }
    finally { setBusy(false); }
  };
  if (!types) return <PageHeader title="事项类型" summary="正在读取…" />;
  const now = new Date();
  const period = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return (
    <>
      <PageHeader title="事项类型" summary="一种事项 + 类型。类型只决定编号前缀、状态叫法和几个专属字段；每个状态归到五个大类之一，所以各类型叫法不同，看板照样能合起来统计。" />
      <div className="grid cards">
        {types.map(type => (
          <article key={type.id} className="card item-card" role="button" tabIndex={0} style={type.archived ? { opacity: 0.65 } : undefined}
            onClick={() => setDrawer({ type })} onKeyDown={event => { if (event.key === 'Enter') setDrawer({ type }); }}>
            <div className="item-card-head">
              <h3>{type.name}<span className="tag tag-mono" style={{ marginLeft: 6 }}>{type.prefix}</span>{type.archived && <span className="tag tag-muted">已停用</span>}</h3>
              <ActionMenu label={`${type.name}的操作`} items={[
                { label: '编辑', run: () => setDrawer({ type }) },
                { label: type.archived ? '重新启用' : '停用', run: () => run(() => call('PATCH', `/admin/work-types/${type.id}`, { archived: !type.archived }), type.archived ? '已重新启用' : '已停用：不能再用它建事项，已有的事项不受影响') },
                { label: '删除类型', danger: true, run: () => setConfirm({ title: '删除事项类型', danger: true, confirmLabel: '删除类型',
                  message: `删除“${type.name}”。还有事项（包括回收站里的）是这个类型时删不了，可以停用它。`,
                  action: () => run(() => call('DELETE', `/admin/work-types/${type.id}`), '类型已删除') }) },
              ]} />
            </div>
            <span className="muted small">编号形如 {type.prefix}-{period}-001</span>
            <div className="chips">{type.statuses.map(status => <span key={status.key} className="chip" style={{ paddingRight: 10 }}>{status.name}{status.name !== CATEGORY_LABELS[status.category] && <span className="muted">·{CATEGORY_LABELS[status.category]}</span>}</span>)}</div>
            {type.fields.length > 0 && <span className="muted small">专属字段：{type.fields.map(field => `${field.name}（${FIELD_KIND_LABELS[field.kind]}）`).join('、')}</span>}
          </article>
        ))}
        <AddCard label="新建类型" onClick={() => setDrawer({ type: null })} />
      </div>
      {drawer && <TypeDrawer busy={busy} type={drawer.type} onClose={() => setDrawer(null)}
        onSubmit={input => run(() => drawer.type ? call('PATCH', `/admin/work-types/${drawer.type.id}`, input) : call('POST', '/admin/work-types', input), drawer.type ? '已保存修改' : '类型已建好').then(() => setDrawer(null), () => {})} />}
      {confirm && <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => confirm.action().then(() => setConfirm(null), () => {})} />}
    </>
  );
}

function TypeDrawer({ busy, type, onClose, onSubmit }) {
  const initial = { name: type?.name ?? '', prefix: type?.prefix ?? '', statuses: type?.statuses ?? BLANK_STATUSES, fields: (type?.fields ?? []).map(field => ({ ...field, optionsText: (field.options ?? []).join('、') })) };
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const setStatus = (index, patch) => setForm({ ...form, statuses: form.statuses.map((status, i) => i === index ? { ...status, ...patch } : status) });
  const setField = (index, patch) => setForm({ ...form, fields: form.fields.map((field, i) => i === index ? { ...field, ...patch } : field) });
  const move = (index, step) => {
    const next = [...form.statuses];
    const [entry] = next.splice(index, 1);
    next.splice(index + step, 0, entry);
    setForm({ ...form, statuses: next });
  };
  const submit = () => onSubmit({
    name: form.name.trim(), prefix: form.prefix.trim().toUpperCase(),
    statuses: form.statuses.map(({ key, name, category }) => ({ ...(key ? { key } : {}), name: name.trim(), category })),
    fields: form.fields.map(({ key, name, kind, optionsText }) => ({ ...(key ? { key } : {}), name: name.trim(), kind,
      ...(kind === 'select' ? { options: optionsText.split(/[、,，\n]/).map(option => option.trim()).filter(Boolean) } : {}) })),
  });
  return (
    <Drawer title={type ? `编辑类型 ${type.name}` : '新建事项类型'} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || !form.name.trim() || !form.prefix.trim() || !form.statuses.length} onClick={submit}>{type ? '保存修改' : '建好类型'}</button>,
    ]}>
      <div className="form-grid">
        <Field label="类型名称" hint="比如开发、实施、跟踪"><input value={form.name} maxLength={20} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="编号前缀" hint="1 到 6 个大写字母或数字，比如 KF。改了只影响以后的新编号"><input value={form.prefix} maxLength={6} onChange={event => setForm({ ...form, prefix: event.target.value.toUpperCase() })} /></Field>
      </div>
      <Field group label="状态" hint="新事项默认用第一个归到“未开始”的状态。还有事项在用的状态不能删；改了状态归的大类，已有事项跟着改。">
        {form.statuses.map((status, index) => (
          <div key={status.key ?? `new-${index}`} className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={status.name} maxLength={20} aria-label={`第 ${index + 1} 个状态的名字`} onChange={event => setStatus(index, { name: event.target.value })} />
            <select value={status.category} aria-label={`“${status.name}”归到哪个大类`} style={{ width: 120, flex: 'none' }} onChange={event => setStatus(index, { category: event.target.value })}>
              {CATEGORIES.map(category => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
            </select>
            <button type="button" className="icon" aria-label={`把“${status.name}”往前挪`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="icon" aria-label={`删掉“${status.name}”`} disabled={form.statuses.length <= 1} onClick={() => setForm({ ...form, statuses: form.statuses.filter((_, i) => i !== index) })}>×</button>
          </div>
        ))}
        {form.statuses.length < 12 && <div><button type="button" onClick={() => setForm({ ...form, statuses: [...form.statuses, { name: '', category: 'doing' }] })}>＋ 加一个状态</button></div>}
      </Field>
      <Field group label="专属字段（最多 5 个）" hint="这个类型自己才有的几项，比如“模块”“上线日期”。单选的选项用顿号隔开。">
        {form.fields.map((field, index) => (
          <div key={field.key ?? `new-${index}`} className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={field.name} maxLength={20} placeholder="字段名" aria-label={`第 ${index + 1} 个字段的名字`} onChange={event => setField(index, { name: event.target.value })} />
            <select value={field.kind} style={{ width: 90, flex: 'none' }} aria-label={`“${field.name}”的类型`} onChange={event => setField(index, { kind: event.target.value })}>
              {FIELD_KINDS.map(kind => <option key={kind} value={kind}>{FIELD_KIND_LABELS[kind]}</option>)}
            </select>
            {field.kind === 'select' && <input value={field.optionsText} placeholder="前端、后端" aria-label={`“${field.name}”的选项`} onChange={event => setField(index, { optionsText: event.target.value })} />}
            <button type="button" className="icon" aria-label={`删掉“${field.name}”`} onClick={() => setForm({ ...form, fields: form.fields.filter((_, i) => i !== index) })}>×</button>
          </div>
        ))}
        {form.fields.length < 5 && <div><button type="button" onClick={() => setForm({ ...form, fields: [...form.fields, { name: '', kind: 'text', optionsText: '' }] })}>＋ 加一个字段</button></div>}
      </Field>
    </Drawer>
  );
}
