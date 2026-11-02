// 管理端的事项页面：全局看板（和员工端团队看板同一份数据）、项目、回收站，以及事项抽屉。
// 管理员是系统里的最高权限：能调整任何人的事项（截止日期、优先级、负责人），改动都进动态和操作记录。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORY_LABELS, PRIORITY_LABELS } from '@whalewing-enterprise/shared/protocol';
import { useApp } from '../context.js';
import { ActionMenu, ConfirmDialog, Drawer, downloadText, Empty, Field, formatTime, PageHeader, PeoplePicker, useToast } from '../ui.jsx';
import { departmentTree } from './Members.jsx';

/** 状态名和大类名一样时只写一次。 */
const statusLabel = status => status.name === CATEGORY_LABELS[status.category] ? status.name : `${status.name}（${CATEGORY_LABELS[status.category]}）`;

const daysText = (item, today) => {
  if (item.category === 'done') return item.completedAt ? `${item.completedAt.slice(5, 10)} 完成` : '已完成';
  if (item.category === 'cancelled') return '已取消';
  if (!item.dueDate) return '没有截止日期';
  if (item.overdue) return `逾期 ${item.overdueDays} 天`;
  return item.dueDate === today ? '今天到期' : `${item.dueDate} 到期`;
};

function ItemTable({ items, today, onOpen, showAssignee = true }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>编号</th><th>标题</th>{showAssignee && <th>负责人</th>}<th>状态</th><th>截止</th><th>进度</th></tr></thead>
      <tbody>{items.map(item => (
        <tr key={item.id}>
          <td className="mono nowrap">{item.number}</td>
          <td><button type="button" className="link" onClick={() => onOpen(item)}>{item.title}</button>{item.projectName && <span className="tag tag-muted">{item.projectName}</span>}
            {item.waitingOnName && <span className="muted small"> · 在等 {item.waitingOnName}</span>}</td>
          {showAssignee && <td className="nowrap">{item.assigneeName}</td>}
          <td className="nowrap">{item.statusName}{item.statusName !== CATEGORY_LABELS[item.category] && <span className="muted small">·{CATEGORY_LABELS[item.category]}</span>}</td>
          <td className="nowrap" style={item.overdue ? { color: 'var(--danger)' } : undefined}>{daysText(item, today)}</td>
          <td className="nowrap muted">{item.progress === null ? '—' : `${item.progress}%`}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

const EDIT_KEYS = ['status', 'priority', 'startDate', 'dueDate', 'assigneeId', 'projectId', 'waitingOn', 'waitingNote'];
const pick = item => Object.fromEntries(EDIT_KEYS.map(key => [key, item[key] ?? null]));

/** 事项抽屉：详情、动态；管理员能调整状态、截止日期、优先级、负责人、项目，能放进回收站。 */
export function WorkItemDrawer({ id, onClose, onChanged }) {
  const { call, directory } = useApp();
  const notify = useToast();
  const [item, setItem] = useState(null);
  const [form, setForm] = useState(null);
  const [comment, setComment] = useState('');
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(() => call('GET', `/work/items/${id}`).then(data => { setItem(data); setForm(pick(data)); }), [call, id]);
  useEffect(() => {
    load().catch(error => { notify(error.message, { kind: 'error' }); onClose(); });
    call('GET', '/work/projects').then(data => setProjects(data.projects)).catch(() => {});
  }, [load, call, notify, onClose]);
  if (!item) return <Drawer title="正在读取事项…" onClose={onClose}><p className="muted">正在读取…</p></Drawer>;
  const changes = Object.fromEntries(EDIT_KEYS.filter(key => JSON.stringify(form[key]) !== JSON.stringify(item[key] ?? null)).map(key => [key, form[key]]));
  const dirty = Object.keys(changes).length > 0 || Boolean(comment.trim());
  const save = async () => {
    setBusy(true);
    try {
      const saved = Object.keys(changes).length
        ? await call('PATCH', `/work/items/${item.id}`, { baseRevision: item.revision, ...changes, ...(comment.trim() ? { comment: comment.trim() } : {}) })
        : await call('POST', `/work/items/${item.id}/comments`, { text: comment.trim() });
      setItem(saved); setForm(pick(saved)); setComment('');
      notify(`已保存 ${saved.number}`);
      onChanged?.();
    } catch (error) {
      notify(error.message, { kind: 'error', ...(error.code === 'CONFLICT' ? { action: { label: '重新读取', run: () => { load().catch(() => {}); } } } : {}) });
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await call('DELETE', `/work/items/${item.id}`); notify(`${item.number} 已放进回收站`); onChanged?.(); onClose(); }
    catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(false); setDeleting(false); }
  };
  const active = directory.users.filter(user => user.status === 'active' || user.id === item.assigneeId);
  return (
    <Drawer title={`${item.number} ${item.title}`} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="delete" type="button" className="danger" disabled={busy} onClick={() => setDeleting(true)}>放进回收站</button>,
      <button key="save" type="button" className="primary" disabled={busy || !dirty} onClick={save}>保存修改</button>,
    ]}>
      <p className="muted">{item.typeName} · 负责人 {item.assigneeName} · 创建人 {item.creatorName ?? '—'}{item.collaboratorNames.length ? ` · 协作人 ${item.collaboratorNames.join('、')}` : ''}</p>
      <div className="form-grid">
        <Field label="状态"><select value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}>
          {(item.type?.statuses ?? []).map(status => <option key={status.key} value={status.key}>{statusLabel(status)}</option>)}
        </select></Field>
        <Field label="优先级"><select value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value })}>
          {Object.entries(PRIORITY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></Field>
        <Field label="开始日期"><input type="date" value={form.startDate ?? ''} onChange={event => setForm({ ...form, startDate: event.target.value || null })} /></Field>
        <Field label="截止日期"><input type="date" value={form.dueDate ?? ''} onChange={event => setForm({ ...form, dueDate: event.target.value || null })} /></Field>
        <Field label="负责人"><select value={form.assigneeId} onChange={event => setForm({ ...form, assigneeId: Number(event.target.value) })}>
          {active.map(user => <option key={user.id} value={user.id}>{user.displayName}（{user.username}）</option>)}
        </select></Field>
        <Field label="项目"><select value={form.projectId ?? ''} onChange={event => setForm({ ...form, projectId: event.target.value ? Number(event.target.value) : null })}>
          <option value="">不属于任何项目</option>
          {projects.filter(project => project.status === 'active' || project.id === item.projectId).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></Field>
        <Field label="在等谁"><select value={form.waitingOn ?? ''} onChange={event => setForm({ ...form, waitingOn: event.target.value ? Number(event.target.value) : null })}>
          <option value="">不在等人</option>
          {directory.users.filter(user => user.status === 'active').map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}
        </select></Field>
        <Field label="在等什么"><input value={form.waitingNote ?? ''} maxLength={200} onChange={event => setForm({ ...form, waitingNote: event.target.value })} /></Field>
      </div>
      <p className="muted small">进度 {item.progress === null ? '—' : `${item.progress}%`}（已完成 100%、未开始 0，有检查项时按检查项算）{item.checklist.length ? ` · 检查项 ${item.checklistDone}/${item.checklistTotal}` : ''}</p>
      {item.content && <pre className="prompt">{item.content}</pre>}
      <Field label="写一句动态（可选）" hint="和这次修改一起记进动态"><textarea rows={2} value={comment} maxLength={2000} onChange={event => setComment(event.target.value)} /></Field>
      <section className="section" style={{ marginTop: 0 }}>
        <h2>动态</h2>
        <ul className="timeline">{item.events.map(event => (
          <li key={event.id}>
            <span className="muted">{formatTime(event.at)}</span>
            <span>{event.actorName ?? '系统'}{event.via === 'model' ? `（${event.viaName ? `经${event.viaName}` : '经模型'}）` : event.via === 'import' ? '（导入）' : ''}</span>
            <span>{[eventText(event), event.comment && `“${event.comment}”`].filter(Boolean).join(' ')}</span>
          </li>
        ))}</ul>
      </section>
      {deleting && <ConfirmDialog title="放进回收站" danger confirmLabel="放进回收站" cancelLabel="不删了" busy={busy}
        message={`把 ${item.number}「${item.title}」放进回收站。在“回收站”里能恢复；彻底删除只能在服务器上用命令行。`} onConfirm={remove} onCancel={() => setDeleting(false)} />}
    </Drawer>
  );
}

function eventText(event) {
  const kinds = { create: '建了这个事项', import: '从表格导入', delete: '放进了回收站', restore: '从回收站恢复', comment: '' };
  if (event.kind in kinds) return kinds[event.kind];
  return (event.changes ?? []).map(change => change.from === null && change.to === null ? `改了${change.label}` : `${change.label}：${change.from || '无'} → ${change.to || '无'}`).join('；');
}

// ---------- 全局看板 ----------

export function BoardPage() {
  const { call, directory } = useApp();
  const notify = useToast();
  const [departmentId, setDepartmentId] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [data, setData] = useState(null);
  const [person, setPerson] = useState(null);
  const [itemId, setItemId] = useState(null);
  const load = useCallback(() => {
    const params = new URLSearchParams({ ...(departmentId ? { departmentId: String(departmentId) } : {}), ...(projectId ? { projectId: String(projectId) } : {}) });
    return call('GET', `/work/board?${params}`).then(setData).catch(error => notify(error.message, { kind: 'error', action: { label: '重试', run: load } }));
  }, [call, notify, departmentId, projectId]);
  useEffect(() => { load(); }, [load]);
  const tree = useMemo(() => departmentTree(directory.departments), [directory.departments]);
  const exportCsv = async () => {
    const params = new URLSearchParams({ ...(data?.current ? { departmentId: String(data.current.id) } : {}), ...(projectId ? { projectId: String(projectId) } : {}) });
    const response = await fetch(`/api/v1/work/export?${params}`, { credentials: 'same-origin' });
    if (!response.ok) { notify('导出失败，请刷新后再试', { kind: 'error' }); return; }
    downloadText(await response.text(), `事项-${data.title}-${data.today}.csv`);
    notify('已导出表格');
  };
  if (!data) return <PageHeader title="全局看板" summary="正在读取…" />;
  const cards = [
    { label: '没做完', value: data.summary.open }, { label: '进行中', value: data.summary.doing },
    { label: '逾期', value: data.summary.overdue }, { label: '等待中', value: data.summary.waiting }, { label: '本周完成', value: data.summary.doneThisWeek },
  ];
  return (
    <>
      <PageHeader title="全局看板" summary="和员工端的团队看板同一份数据：先看各部门的汇总，点部门进去，再点人看他的事项。管理员默认看全企业。"
        actions={<button type="button" onClick={exportCsv}>导出表格</button>} />
      <div className="row filters">
        <label className="row" style={{ gap: 6 }}><span className="muted nowrap">范围</span>
          <select value={departmentId ?? ''} onChange={event => setDepartmentId(event.target.value ? Number(event.target.value) : null)} style={{ width: 'auto' }}>
            <option value="">全企业</option>
            {tree.map(department => <option key={department.id} value={department.id}>{'　'.repeat(department.depth)}{department.name}</option>)}
          </select></label>
        <label className="row" style={{ gap: 6 }}><span className="muted nowrap">项目</span>
          <select value={projectId ?? ''} onChange={event => setProjectId(event.target.value ? Number(event.target.value) : null)} style={{ width: 'auto' }}>
            <option value="">全部</option>
            {data.options.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
      </div>
      <h2 style={{ marginBottom: 10 }}>{data.trail.length ? data.trail.map((entry, index) => (
        <span key={entry.id}>{index > 0 && ' / '}{index < data.trail.length - 1 ? <button type="button" className="link" onClick={() => setDepartmentId(entry.id)}>{entry.name}</button> : entry.name}</span>
      )) : data.title}<span className="muted" style={{ fontWeight: 400 }}> · {data.people} 人</span></h2>
      <div className="grid stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 14 }}>
        {cards.map(card => <div key={card.label} className="card stat"><span className="muted">{card.label}</span><strong>{card.value}</strong></div>)}
      </div>
      {data.departments.length > 0 && (
        <section className="list card" style={{ marginBottom: 14 }}>
          <div className="table-wrap"><table>
            <thead><tr><th>部门</th><th>负责人</th><th>人数</th><th>进行中</th><th>逾期</th><th>等待中</th><th>本周完成</th></tr></thead>
            <tbody>{data.departments.map(row => (
              <tr key={row.id}>
                <td><button type="button" className="link" onClick={() => setDepartmentId(row.id)}>{row.name}</button></td>
                <td className="muted">{row.managers.join('、') || '还没设'}</td>
                <td>{row.people}</td><td>{row.doing}</td><td style={row.overdue ? { color: 'var(--danger)' } : undefined}>{row.overdue}</td><td>{row.waiting}</td><td>{row.doneThisWeek}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      {data.members.length > 0 && (
        <section className="list card">
          <div className="table-wrap"><table>
            <thead><tr><th>{data.current ? '直属成员' : '没有部门的人'}</th><th>进行中</th><th>逾期</th><th>等待中</th><th>本周完成</th></tr></thead>
            <tbody>{data.members.map(row => (
              <tr key={row.id}>
                <td><button type="button" className="link" onClick={() => setPerson(row)}>{row.name}</button>{row.waitingFor.length > 0 && <span className="muted small"> · 在等 {row.waitingFor.join('、')}</span>}</td>
                <td>{row.doing}</td><td style={row.overdue ? { color: 'var(--danger)' } : undefined}>{row.overdue}</td><td>{row.waiting}</td><td>{row.doneThisWeek}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      {!data.departments.length && !data.members.length && <Empty>这里还没有人。在“组织与人员”里建部门、把成员调进来后，这里会显示他们的事项。</Empty>}
      {person && !itemId && <PersonDrawer person={person} projectId={projectId} today={data.today} onClose={() => setPerson(null)} onOpen={item => setItemId(item.id)} />}
      {itemId && <WorkItemDrawer id={itemId} onClose={() => setItemId(null)} onChanged={load} />}
    </>
  );
}

function PersonDrawer({ person, projectId, today, onClose, onOpen }) {
  const { call } = useApp();
  const notify = useToast();
  const [items, setItems] = useState(null);
  useEffect(() => {
    const params = new URLSearchParams({ assigneeId: String(person.id), category: 'open', limit: '200', ...(projectId ? { projectId: String(projectId) } : {}) });
    call('GET', `/work/items?${params}`).then(data => setItems(data.items)).catch(error => notify(error.message, { kind: 'error' }));
  }, [call, notify, person.id, projectId]);
  return (
    <Drawer title={`${person.name}手上的事项`} onClose={onClose} cancelLabel="关闭">
      {!items ? <p className="muted">正在读取…</p> : items.length ? <ItemTable items={items} today={today} onOpen={onOpen} showAssignee={false} /> : <p className="muted">没有没做完的事项。</p>}
    </Drawer>
  );
}

// ---------- 项目 ----------

export function ProjectsPage() {
  const { call, directory } = useApp();
  const notify = useToast();
  const [projects, setProjects] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call('GET', '/work/projects').then(data => setProjects(data.projects)).catch(error => notify(error.message, { kind: 'error', action: { label: '重试', run: load } })), [call, notify]);
  useEffect(() => { load(); }, [load]);
  const name = id => directory.users.find(user => user.id === id)?.displayName ?? '—';
  const run = async (task, success) => {
    setBusy(true);
    try { const result = await task(); await load(); if (success) notify(success); return result; }
    catch (error) { notify(error.message, { kind: 'error' }); throw error; }
    finally { setBusy(false); }
  };
  if (!projects) return <PageHeader title="项目" summary="正在读取…" />;
  return (
    <>
      <PageHeader title="项目" summary="一组事项属于同一个项目。项目成员能看项目里的全部事项，跨部门合作用项目成员，不用改组织。负责人角色勾了“管项目”也能在员工端建项目。"
        actions={<button type="button" className="primary" onClick={() => setDrawer({ project: null })}>新建项目</button>} />
      <section className="list card">
        {projects.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>项目</th><th>负责人</th><th>成员</th><th>没做完</th><th>逾期</th><th>起止</th><th>状态</th><th aria-label="操作" /></tr></thead>
            <tbody>{projects.map(project => (
              <tr key={project.id} className={project.status === 'closed' ? 'disabled' : ''}>
                <td><button type="button" className="link" onClick={() => setDrawer({ project })}>{project.name}</button></td>
                <td>{name(project.ownerId)}</td>
                <td>{project.memberIds.length}</td>
                <td>{project.open}</td>
                <td style={project.overdue ? { color: 'var(--danger)' } : undefined}>{project.overdue}</td>
                <td className="muted nowrap">{project.startDate ?? '?'} 到 {project.endDate ?? '?'}</td>
                <td>{project.status === 'closed' ? <span className="tag tag-muted">已结束</span> : <span className="tag">进行中</span>}</td>
                <td className="cell-actions"><ActionMenu label={`${project.name}的操作`} items={[
                  { label: '编辑', run: () => setDrawer({ project }) },
                  { label: '删除项目', danger: true, run: () => setConfirm({ title: '删除项目', danger: true, confirmLabel: '删除项目',
                    message: `删除项目“${project.name}”。项目里还有事项（包括回收站里的）时删不了，可以改成“已结束”。`,
                    action: () => run(() => call('DELETE', `/work/projects/${project.id}`), '项目已删除') }) },
                ]} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>还没有项目。点右上角“新建项目”。</Empty>}
      </section>
      {drawer && <ProjectDrawer busy={busy} project={drawer.project} onClose={() => setDrawer(null)}
        onSubmit={input => run(() => drawer.project ? call('PATCH', `/work/projects/${drawer.project.id}`, input) : call('POST', '/work/projects', input), drawer.project ? '项目已保存' : '项目已建好').then(() => setDrawer(null), () => {})} />}
      {confirm && <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => confirm.action().then(() => setConfirm(null), () => {})} />}
    </>
  );
}

function ProjectDrawer({ busy, project, onClose, onSubmit }) {
  const { directory } = useApp();
  const users = directory.users.filter(user => user.status === 'active' || project?.memberIds.includes(user.id));
  const departmentName = id => directory.departments.find(department => department.id === id)?.name;
  const initial = { name: project?.name ?? '', description: project?.description ?? '', ownerId: project?.ownerId ?? null, startDate: project?.startDate ?? '', endDate: project?.endDate ?? '', memberIds: project?.memberIds ?? [], status: project?.status ?? 'active' };
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const submit = () => onSubmit({
    name: form.name.trim(), description: form.description.trim(), ...(form.ownerId ? { ownerId: form.ownerId } : {}),
    startDate: form.startDate || null, endDate: form.endDate || null, memberIds: form.memberIds, ...(project ? { status: form.status } : {}),
  });
  return (
    <Drawer title={project ? `项目 ${project.name}` : '新建项目'} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || !form.name.trim()} onClick={submit}>{project ? '保存修改' : '建好项目'}</button>,
    ]}>
      <Field label="项目名称"><input value={form.name} maxLength={60} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="介绍（可选）"><textarea rows={3} value={form.description} maxLength={240} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
      <div className="form-grid">
        <Field label="项目负责人" hint="不选就是你自己"><select value={form.ownerId ?? ''} onChange={event => setForm({ ...form, ownerId: event.target.value ? Number(event.target.value) : null })}>
          <option value="">我自己</option>
          {users.map(user => <option key={user.id} value={user.id}>{user.displayName}（{user.username}）</option>)}
        </select></Field>
        {project && <Field label="状态"><select value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}><option value="active">进行中</option><option value="closed">已结束（不能再加事项）</option></select></Field>}
        <Field label="开始日期"><input type="date" value={form.startDate ?? ''} onChange={event => setForm({ ...form, startDate: event.target.value })} /></Field>
        <Field label="结束日期"><input type="date" value={form.endDate ?? ''} onChange={event => setForm({ ...form, endDate: event.target.value })} /></Field>
      </div>
      <PeoplePicker label="项目成员" hint="项目成员能看项目里的全部事项" users={users} value={form.memberIds} onChange={memberIds => setForm({ ...form, memberIds })} departmentName={departmentName} />
    </Drawer>
  );
}

// ---------- 回收站 ----------

export function TrashPage() {
  const { call } = useApp();
  const notify = useToast();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => call('GET', '/admin/work/trash').then(data => setItems(data.items)).catch(error => notify(error.message, { kind: 'error' })), [call, notify]);
  useEffect(() => { load(); }, [load]);
  const restore = async item => {
    setBusy(item.id);
    try { await call('POST', `/admin/work/items/${item.id}/restore`); notify(`${item.number} 已恢复，负责人和协作人又能看到了`); await load(); }
    catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHeader title="回收站" summary="删除的事项先放在这里，管理员能恢复。彻底删除只能在服务器上用命令行（whalewing-enterprise-server purge-trash），网页里不做。" />
      <section className="list card">
        {!items ? <p className="muted">正在读取…</p> : items.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>编号</th><th>标题</th><th>负责人</th><th>谁删的</th><th>删除时间</th><th aria-label="操作" /></tr></thead>
            <tbody>{items.map(item => (
              <tr key={item.id}>
                <td className="mono nowrap">{item.number}</td><td>{item.title}</td><td>{item.assigneeName}</td><td>{item.deletedByName ?? '—'}</td>
                <td className="muted nowrap">{formatTime(item.deletedAt)}</td>
                <td className="nowrap"><button type="button" disabled={busy === item.id} onClick={() => restore(item)}>恢复</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>回收站是空的。</Empty>}
      </section>
    </>
  );
}
