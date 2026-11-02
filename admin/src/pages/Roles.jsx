import { useCallback, useEffect, useState } from 'react';
import { PERMISSIONS, PERMISSION_HINTS, PERMISSION_LABELS, SCOPE_LABELS, SCOPES } from '@whalewing-enterprise/shared/protocol';
import { useApp } from '../context.js';
import { ActionMenu, AddCard, ConfirmDialog, Drawer, Empty, Field, PageHeader, useToast } from '../ui.jsx';

const SCOPE_HINTS = {
  self: '只管自己负责的事项',
  managed: '他担任负责人的部门，连同下级部门。还不是任何部门的负责人时，实际只能管自己',
  all: '全企业，比如管理办公室',
};

export function RolesPage() {
  const { call, directory, refreshDirectory } = useApp();
  const notify = useToast();
  const [roles, setRoles] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call('GET', '/admin/roles').then(data => setRoles(data.roles)).catch(error => notify(error.message, { kind: 'error', action: { label: '重试', run: load } })), [call, notify]);
  useEffect(() => { load(); }, [load]);

  const run = async (task, success) => {
    setBusy(true);
    try { const result = await task(); await Promise.all([load(), refreshDirectory()]); if (success) notify(success); return result; }
    catch (error) { notify(error.message, { kind: 'error' }); throw error; }
    finally { setBusy(false); }
  };
  if (!roles) return <PageHeader title="角色与权限" summary="正在读取…" />;
  const members = role => directory.users.filter(user => user.role === 'member' && user.roleId === role.id && user.status === 'active');

  return (
    <>
      <PageHeader title="角色与权限" summary="角色 = 一组权限点 + 一个数据范围。按企业自己的叫法建：负责人、小组长、组员、项目经理……管理员不挂角色，系统里的事都能做。" />
      <p className="notice">管组织和人员、管角色、事项类型、企业设置、从回收站恢复，这些只给管理员，不能分给角色。上下级不在角色里配：来自部门树和部门负责人（在“组织与人员”里设）。</p>
      <div className="grid cards">
        {roles.map(role => (
          <article key={role.id} className="card item-card" role="button" tabIndex={0} onClick={() => setDrawer({ role })} onKeyDown={event => { if (event.key === 'Enter') setDrawer({ role }); }}>
            <div className="item-card-head">
              <h3>{role.name}{role.preset && <span className="tag tag-muted">预置</span>}</h3>
              <ActionMenu label={`${role.name}的操作`} items={[
                { label: '编辑', run: () => setDrawer({ role }) },
                { label: '删除角色', danger: true, run: () => setConfirm({ title: '删除角色', danger: true, confirmLabel: '删除角色',
                  message: `删除角色“${role.name}”。还有人或没用完的邀请用着它时删不了，要先给他们换个角色。`,
                  action: () => run(() => call('DELETE', `/admin/roles/${role.id}`), '角色已删除') }) },
              ]} />
            </div>
            <span className="access">数据范围：{SCOPE_LABELS[role.scope]}</span>
            <span className="muted clamp">{role.permissions.length ? role.permissions.map(permission => PERMISSION_LABELS[permission]).join('、') : '没有勾任何权限点'}</span>
            <span className="muted small">{role.members} 人用着这个角色</span>
            {role.notManaging > 0 && <span className="tag tag-warn" style={{ marginLeft: 0, justifySelf: 'start' }}>其中 {role.notManaging} 人还不是任何部门的负责人，实际只能管自己</span>}
          </article>
        ))}
        <AddCard label="新建角色" onClick={() => setDrawer({ role: null })} />
      </div>
      {!roles.length && <Empty>还没有角色。新建成员和发邀请前，先建一个角色。</Empty>}
      {drawer && <RoleDrawer busy={busy} role={drawer.role} members={drawer.role ? members(drawer.role) : []} onClose={() => setDrawer(null)}
        onSubmit={input => run(() => drawer.role ? call('PATCH', `/admin/roles/${drawer.role.id}`, input) : call('POST', '/admin/roles', input), drawer.role ? '已保存修改' : '角色已建好').then(() => setDrawer(null), () => {})} />}
      {confirm && <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => confirm.action().then(() => setConfirm(null), () => {})} />}
    </>
  );
}

function RoleDrawer({ busy, role, members, onClose, onSubmit }) {
  const [form, setForm] = useState({ name: role?.name ?? '', scope: role?.scope ?? 'self', permissions: role?.permissions ?? ['item.create'] });
  const dirty = role ? JSON.stringify(form) !== JSON.stringify({ name: role.name, scope: role.scope, permissions: role.permissions }) : Boolean(form.name);
  const toggle = permission => setForm({ ...form, permissions: form.permissions.includes(permission) ? form.permissions.filter(entry => entry !== permission) : PERMISSIONS.filter(entry => entry === permission || form.permissions.includes(entry)) });
  return (
    <Drawer title={role ? `编辑角色 ${role.name}` : '新建角色'} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || !form.name.trim()} onClick={() => onSubmit({ name: form.name.trim(), scope: form.scope, permissions: form.permissions })}>{role ? '保存修改' : '建好角色'}</button>,
    ]}>
      <Field label="角色名称" hint="按企业自己的叫法，比如小组长、项目经理"><input value={form.name} maxLength={24} onChange={event => setForm({ ...form, name: event.target.value })} autoFocus={!role} /></Field>
      <Field group label="数据范围" hint="能管谁的事项。看得到的还包括自己参与的和同项目的；企业设置可以改成全员可见。">
        {SCOPES.map(scope => (
          <label key={scope} className="check">
            <input type="radio" name="scope" checked={form.scope === scope} onChange={() => setForm({ ...form, scope })} />
            <span className="check-hint"><span>{SCOPE_LABELS[scope]}</span><span className="muted small">{SCOPE_HINTS[scope]}</span></span>
          </label>
        ))}
      </Field>
      <Field group label="权限点" hint="改了马上生效，员工不用重新登录。">
        {PERMISSIONS.map(permission => (
          <label key={permission} className="check">
            <input type="checkbox" checked={form.permissions.includes(permission)} onChange={() => toggle(permission)} />
            <span className="check-hint"><span>{PERMISSION_LABELS[permission]}</span><span className="muted small">{PERMISSION_HINTS[permission]}</span></span>
          </label>
        ))}
      </Field>
      {role && <Field group label={`谁有这个角色（${members.length} 人）`}><span className="muted">{members.length ? members.map(user => user.displayName).join('、') : '还没有人。到“组织与人员”里给成员换角色。'}</span></Field>}
    </Drawer>
  );
}
