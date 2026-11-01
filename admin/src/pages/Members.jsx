import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../context.js';
import { ActionMenu, ConfirmDialog, copyText, Drawer, Empty, Field, formatTime, Modal, PageHeader, useToast } from '../ui.jsx';

const ROLE = { owner: '所有者', admin: '管理员', member: '成员' };

/** 部门按树排好，带缩进层级，选部门的下拉框和左边的树都用它。 */
export function departmentTree(departments) {
  const children = new Map();
  for (const department of departments) {
    const key = department.parentId ?? 0;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(department);
  }
  const result = [];
  const walk = (parent, depth) => { for (const department of children.get(parent) ?? []) { result.push({ ...department, depth }); walk(department.id, depth + 1); } };
  walk(0, 0);
  return result;
}

export function DepartmentSelect({ value, onChange, departments, emptyLabel = '不属于任何部门', exclude }) {
  const tree = departmentTree(departments);
  const hidden = new Set();
  if (exclude) {
    // 移动部门时不能选它自己和它的下级。
    hidden.add(exclude);
    let grew = true;
    while (grew) { grew = false; for (const department of departments) if (department.parentId && hidden.has(department.parentId) && !hidden.has(department.id)) { hidden.add(department.id); grew = true; } }
  }
  return (
    <select value={value ?? ''} onChange={event => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{emptyLabel}</option>
      {tree.filter(department => !hidden.has(department.id)).map(department => (
        <option key={department.id} value={department.id}>{'　'.repeat(department.depth)}{department.name}</option>
      ))}
    </select>
  );
}

export function MembersPage() {
  const { call, directory, refreshDirectory, me } = useApp();
  const notify = useToast();
  const [tab, setTab] = useState('members');
  const [selected, setSelected] = useState('all');
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [inviteResult, setInviteResult] = useState(null);
  const [invites, setInvites] = useState([]);
  const [busy, setBusy] = useState(false);
  const { departments, users } = directory;
  const isOwner = me.user.role === 'owner';

  const loadInvites = useCallback(() => call('GET', '/admin/invites').then(data => setInvites(data.invites)).catch(error => notify(error.message, { kind: 'error' })), [call, notify]);
  useEffect(() => { loadInvites(); }, [loadInvites]);

  const departmentName = useMemo(() => new Map(departments.map(department => [department.id, department.name])), [departments]);
  const inSelected = useMemo(() => {
    if (selected === 'all') return () => true;
    if (selected === 'none') return user => !user.departmentId;
    const ids = new Set([selected]);
    let grew = true;
    while (grew) { grew = false; for (const department of departments) if (department.parentId && ids.has(department.parentId) && !ids.has(department.id)) { ids.add(department.id); grew = true; } }
    return user => ids.has(user.departmentId);
  }, [selected, departments]);
  const shown = users.filter(inSelected).filter(user => !query.trim() || `${user.displayName} ${user.username}`.toLowerCase().includes(query.trim().toLowerCase()));

  const run = async (task, success) => {
    setBusy(true);
    try { const result = await task(); await refreshDirectory(); if (success) notify(success); return result; }
    catch (error) { notify(error.message, { kind: 'error' }); throw error; }
    finally { setBusy(false); }
  };

  const tree = departmentTree(departments);
  const selectedName = selected === 'all' ? '全部成员' : selected === 'none' ? '没有部门的成员' : departmentName.get(selected);

  return (
    <>
      <PageHeader title="成员" summary={`${users.filter(user => user.status === 'active').length} 人在用 · ${departments.length} 个部门 · ${invites.filter(invite => invite.active).length} 个邀请还能用`}
        actions={<>
          <button type="button" onClick={() => setDrawer({ type: 'user' })}>新建账号</button>
          <button type="button" className="primary" onClick={() => setDrawer({ type: 'invite' })}>邀请成员</button>
        </>} />
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>成员和部门</button>
        <button type="button" role="tab" aria-selected={tab === 'invites'} className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}>邀请记录</button>
      </div>

      {tab === 'members' ? (
        <div className="split">
          <aside className="tree card" aria-label="部门">
            {[{ id: 'all', name: '全部成员', depth: 0 }, ...tree, { id: 'none', name: '没有部门的成员', depth: 0 }].map(department => (
              <div key={department.id} className={`tree-row${selected === department.id ? ' active' : ''}`} style={{ paddingLeft: 10 + department.depth * 16 }}>
                <button type="button" className="tree-name" onClick={() => setSelected(department.id)}>{department.name}</button>
                {typeof department.id === 'number' && <ActionMenu label={`${department.name}的操作`} items={[
                  { label: '新建下级部门', run: () => setDrawer({ type: 'department', parentId: department.id }) },
                  { label: '改名或移动', run: () => setDrawer({ type: 'department', department }) },
                  { label: '删除部门', danger: true, run: () => setConfirm({ title: '删除部门', message: `删除“${department.name}”。部门里还有成员、下级部门或没用完的邀请时删不了，要先移走。`, confirmLabel: '删除部门', danger: true,
                    action: () => run(() => call('DELETE', `/admin/departments/${department.id}`), '部门已删除').then(() => setSelected('all')) }) },
                ]} />}
              </div>
            ))}
            <button type="button" className="tree-add" onClick={() => setDrawer({ type: 'department', parentId: null })}>＋ 新建部门</button>
          </aside>
          <section className="list card">
            <div className="list-head">
              <h2>{selectedName}<span className="muted">（{shown.length} 人）</span></h2>
              <input type="search" placeholder="找名字或登录名" value={query} onChange={event => setQuery(event.target.value)} aria-label="找成员" />
            </div>
            {shown.length ? (
              <div className="table-wrap"><table>
                <thead><tr><th>名字</th><th>登录名</th><th>部门</th><th>身份</th><th>最近连接</th><th aria-label="操作" /></tr></thead>
                <tbody>{shown.map(user => (
                  <tr key={user.id} className={user.status === 'disabled' ? 'disabled' : ''}>
                    <td>{user.displayName}{user.status === 'disabled' && <span className="tag tag-muted">已停用</span>}</td>
                    <td className="mono">{user.username}</td>
                    <td>{user.departmentId ? departmentName.get(user.departmentId) : <span className="muted">—</span>}</td>
                    <td>{ROLE[user.role]}</td>
                    <td className="muted">{formatTime(user.lastSeenAt)}</td>
                    <td className="cell-actions"><ActionMenu label={`${user.displayName}的操作`} items={[
                      { label: '编辑', run: () => setDrawer({ type: 'user', user }) },
                      user.role !== 'owner' && { label: '重置密码', run: () => setDrawer({ type: 'password', user }) },
                      user.role !== 'owner' && user.id !== me.user.id && user.status === 'active' && (user.role === 'member' || isOwner) && { label: '停用账号', danger: true,
                        run: () => setConfirm({ title: '停用账号', message: `停用“${user.displayName}”后，他在所有电脑上马上退出登录，下次连上时本机的团队内容会被撤掉。他的个人内容不受影响，以后可以再启用。`, confirmLabel: '停用账号', danger: true,
                          action: () => run(() => call('PATCH', `/admin/users/${user.id}`, { status: 'disabled' }), '已停用') }) },
                      user.status === 'disabled' && { label: '重新启用', run: () => run(() => call('PATCH', `/admin/users/${user.id}`, { status: 'active' }), '已重新启用') },
                    ]} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <Empty>{users.length ? '没有符合的成员。' : '还没有成员。点右上角“邀请成员”发一条邀请链接给员工。'}</Empty>}
          </section>
        </div>
      ) : (
        <section className="list card">
          {invites.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>邀请</th><th>加入部门</th><th>身份</th><th>已用 / 上限</th><th>有效期到</th><th>状态</th><th aria-label="操作" /></tr></thead>
              <tbody>{invites.map(invite => (
                <tr key={invite.id} className={invite.active ? '' : 'disabled'}>
                  <td className="mono">{invite.hint}…</td>
                  <td>{invite.departmentId ? departmentName.get(invite.departmentId) ?? '已删除的部门' : <span className="muted">—</span>}</td>
                  <td>{ROLE[invite.role]}</td>
                  <td>{invite.uses} / {invite.maxUses}</td>
                  <td className="muted">{formatTime(invite.expiresAt)}</td>
                  <td>{invite.active ? <span className="tag">能用</span> : <span className="tag tag-muted">{invite.revokedAt ? '已撤销' : invite.uses >= invite.maxUses ? '名额用完' : '已过期'}</span>}</td>
                  <td className="cell-actions">{invite.active && <ActionMenu label="邀请的操作" items={[{ label: '撤销邀请', danger: true,
                    run: () => setConfirm({ title: '撤销邀请', message: '撤销后这条链接马上失效，已经加入的人不受影响。', confirmLabel: '撤销邀请', danger: true,
                      action: () => run(() => call('DELETE', `/admin/invites/${invite.id}`), '邀请已撤销').then(loadInvites) }) }]} />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty>还没发过邀请。</Empty>}
          <p className="muted small">邀请链接只在发出时显示一次，服务端不保存原文；丢了就撤销再发一条。</p>
        </section>
      )}

      {drawer?.type === 'invite' && <InviteDrawer busy={busy} departments={departments} isOwner={isOwner} defaultDepartment={typeof selected === 'number' ? selected : null}
        onClose={() => setDrawer(null)} onSubmit={input => run(() => call('POST', '/admin/invites', input)).then(result => { setDrawer(null); setInviteResult(result); loadInvites(); })} />}
      {drawer?.type === 'user' && <UserDrawer busy={busy} user={drawer.user} departments={departments} isOwner={isOwner} defaultDepartment={typeof selected === 'number' ? selected : null}
        onClose={() => setDrawer(null)} onSubmit={input => run(() => drawer.user ? call('PATCH', `/admin/users/${drawer.user.id}`, input) : call('POST', '/admin/users', input), drawer.user ? '已保存修改' : '账号已建好，把登录名和密码告诉员工').then(() => setDrawer(null))} />}
      {drawer?.type === 'password' && <PasswordDrawer busy={busy} user={drawer.user} onClose={() => setDrawer(null)}
        onSubmit={password => run(() => call('POST', `/admin/users/${drawer.user.id}/password`, { password }), '密码已重置，他需要用新密码重新登录').then(() => setDrawer(null))} />}
      {drawer?.type === 'department' && <DepartmentDrawer busy={busy} department={drawer.department} parentId={drawer.parentId} departments={departments}
        onClose={() => setDrawer(null)} onSubmit={input => run(() => drawer.department ? call('PATCH', `/admin/departments/${drawer.department.id}`, input) : call('POST', '/admin/departments', input), drawer.department ? '已保存修改' : '部门已建好').then(() => setDrawer(null))} />}
      {inviteResult && <InviteResult result={inviteResult} onClose={() => setInviteResult(null)} />}
      {confirm && <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => confirm.action().then(() => setConfirm(null), () => {})} />}
    </>
  );
}

function InviteDrawer({ busy, departments, isOwner, defaultDepartment, onClose, onSubmit }) {
  const [form, setForm] = useState({ departmentId: defaultDepartment, role: 'member', maxUses: 1, days: 7 });
  return (
    <Drawer title="邀请成员" busy={busy} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy} onClick={() => onSubmit({ ...form, maxUses: Number(form.maxUses), days: Number(form.days) })}>生成邀请链接</button>,
    ]}>
      <p className="muted">生成一条邀请链接发给员工。员工在鲸翼「团队」页签粘贴后，自己设置登录名和密码。</p>
      <Field label="加入哪个部门"><DepartmentSelect value={form.departmentId} departments={departments} onChange={departmentId => setForm({ ...form, departmentId })} /></Field>
      <Field label="身份" hint={isOwner ? '管理员能进管理端、管所有内容。' : '只有所有者能邀请管理员。'}>
        <select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}>
          <option value="member">成员</option>
          {isOwner && <option value="admin">管理员</option>}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="能用几次" hint="一条链接发给一群人时调大"><input type="number" min={1} max={500} value={form.maxUses} onChange={event => setForm({ ...form, maxUses: event.target.value })} /></Field>
        <Field label="几天内有效"><input type="number" min={1} max={90} value={form.days} onChange={event => setForm({ ...form, days: event.target.value })} /></Field>
      </div>
    </Drawer>
  );
}

function InviteResult({ result, onClose }) {
  const notify = useToast();
  return (
    <Modal title="邀请链接" onClose={onClose} footer={<>
      <button type="button" onClick={onClose}>关闭</button>
      <button type="button" className="primary" onClick={async () => {
        const copied = await copyText(result.link);
        notify(copied ? '链接已复制' : '没能复制，请手动选中链接复制', { kind: copied ? 'success' : 'error' });
      }}>复制链接</button>
    </>}>
      <p>把这条链接发给员工（{result.invite.maxUses > 1 ? `能用 ${result.invite.maxUses} 次` : '只能用一次'}，{formatTime(result.invite.expiresAt)} 前有效）：</p>
      <p className="copy-box mono">{result.link}</p>
      <p className="muted small">关掉之后就看不到这条链接了，服务端只存它的指纹。</p>
    </Modal>
  );
}

function UserDrawer({ busy, user, departments, isOwner, defaultDepartment, onClose, onSubmit }) {
  const [form, setForm] = useState(user ? { displayName: user.displayName, departmentId: user.departmentId, role: user.role } : { username: '', displayName: '', password: '', departmentId: defaultDepartment, role: 'member' });
  const dirty = user ? form.displayName !== user.displayName || form.departmentId !== user.departmentId || form.role !== user.role : Boolean(form.username || form.displayName || form.password);
  const submit = () => {
    if (!user) return onSubmit(form);
    const input = { displayName: form.displayName, departmentId: form.departmentId };
    if (user.role !== 'owner' && form.role !== user.role) input.role = form.role;
    return onSubmit(input);
  };
  return (
    <Drawer title={user ? `编辑 ${user.displayName}` : '新建账号'} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy} onClick={submit}>{user ? '保存修改' : '创建账号'}</button>,
    ]}>
      {!user && <p className="muted">直接替员工建好账号，再把登录名和密码告诉他。更推荐用“邀请成员”，让员工自己设密码。</p>}
      <Field label="名字"><input value={form.displayName} maxLength={40} onChange={event => setForm({ ...form, displayName: event.target.value })} /></Field>
      {!user && <Field label="登录名" hint="字母、数字、点、短横线和下划线"><input value={form.username} maxLength={32} onChange={event => setForm({ ...form, username: event.target.value })} /></Field>}
      {!user && <Field label="初始密码" hint="至少 8 位"><input type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></Field>}
      <Field label="部门"><DepartmentSelect value={form.departmentId} departments={departments} onChange={departmentId => setForm({ ...form, departmentId })} /></Field>
      {user?.role === 'owner' ? <Field label="身份"><input value="所有者（不能改）" disabled /></Field> : (
        <Field label="身份" hint={isOwner ? '' : '只有所有者能设置管理员。'}>
          <select value={form.role} disabled={!isOwner} onChange={event => setForm({ ...form, role: event.target.value })}>
            <option value="member">成员</option><option value="admin">管理员</option>
          </select>
        </Field>
      )}
    </Drawer>
  );
}

function PasswordDrawer({ busy, user, onClose, onSubmit }) {
  const [password, setPassword] = useState('');
  return (
    <Drawer title={`重置 ${user.displayName} 的密码`} busy={busy} dirty={Boolean(password)} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || password.length < 8} onClick={() => onSubmit(password)}>重置密码</button>,
    ]}>
      <p className="muted">重置后他在所有电脑上都要用新密码重新登录。</p>
      <Field label="新密码" hint="至少 8 位"><input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
    </Drawer>
  );
}

function DepartmentDrawer({ busy, department, parentId, departments, onClose, onSubmit }) {
  const [name, setName] = useState(department?.name ?? '');
  const [parent, setParent] = useState(department ? department.parentId : parentId);
  const dirty = department ? name !== department.name || parent !== department.parentId : Boolean(name);
  return (
    <Drawer title={department ? `修改部门 ${department.name}` : '新建部门'} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || !name.trim()} onClick={() => onSubmit({ name: name.trim(), parentId: parent })}>{department ? '保存修改' : '创建部门'}</button>,
    ]}>
      <Field label="部门名称"><input value={name} maxLength={40} onChange={event => setName(event.target.value)} autoFocus /></Field>
      <Field label="上级部门" hint="可见范围选了某个部门时，它的下级部门也都能看。">
        <DepartmentSelect value={parent} departments={departments} emptyLabel="没有上级（最顶层）" exclude={department?.id} onChange={setParent} />
      </Field>
    </Drawer>
  );
}
