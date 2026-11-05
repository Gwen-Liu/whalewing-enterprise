import { useEffect, useState } from 'react';
import { DEFAULT_ASSISTANT_NAME, LIMITS } from '@whalewing-enterprise/shared/protocol';
import { useApp } from '../context.js';
import { Field, PageHeader, useToast } from '../ui.jsx';

const formOf = data => ({ orgName: data.orgName, publicUrl: data.publicUrl ?? '', offlineDays: data.offlineDays, inviteDays: data.inviteDays, workVisibility: data.workVisibility, timeZone: data.timeZone, assistantName: data.assistantName ?? '' });

export function SettingsPage() {
  const { call, reload } = useApp();
  const notify = useToast();
  const [saved, setSaved] = useState(null), [form, setForm] = useState(null), [busy, setBusy] = useState(false);
  const [passwords, setPasswords] = useState({ oldPassword: '', newPassword: '', confirm: '' });

  useEffect(() => {
    call('GET', '/admin/settings').then(data => {
      const value = formOf(data);
      setSaved(value); setForm(value);
    }).catch(error => notify(error.message, { kind: 'error' }));
  }, [call, notify]);
  if (!form) return <PageHeader title="设置" summary="正在读取…" />;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const save = async event => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await call('PATCH', '/admin/settings', { orgName: form.orgName.trim(), publicUrl: form.publicUrl.trim() || null, offlineDays: Number(form.offlineDays), inviteDays: Number(form.inviteDays), workVisibility: form.workVisibility, timeZone: form.timeZone.trim(), assistantName: form.assistantName.trim() || null });
      const value = formOf(data);
      setSaved(value); setForm(value);
      notify('已保存修改');
      if (value.orgName !== saved.orgName || value.assistantName !== saved.assistantName) reload();
    } catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(false); }
  };
  const changePassword = async event => {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirm) return notify('两次输入的新密码不一样', { kind: 'error' });
    setBusy(true);
    try {
      await call('POST', '/me/password', { oldPassword: passwords.oldPassword, newPassword: passwords.newPassword });
      setPasswords({ oldPassword: '', newPassword: '', confirm: '' });
      notify('密码已修改，其他地方的登录都已退出');
    } catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="设置" summary="企业名称、员工连接用的地址、离线和邀请的期限、助手名称，以及事项默认谁能看。" />
      <form className="card section form" onSubmit={save}>
        <h2>企业</h2>
        <Field label="企业名称" hint="员工加入时看到“你将加入：企业名称”。"><input value={form.orgName} maxLength={60} onChange={event => setForm({ ...form, orgName: event.target.value })} /></Field>
        <Field label="对外地址" hint="员工连接用的地址，例如 https://team.example.com，用来生成邀请链接。外网地址必须是 https；只在公司内网用的可以是 http://内网地址:端口。">
          <input value={form.publicUrl} placeholder="https://" onChange={event => setForm({ ...form, publicUrl: event.target.value })} />
        </Field>
        <div className="form-grid">
          <Field label="离线可用天数" hint="员工连不上服务端时，本机缓存的团队内容还能用几天。离职员工的账号停用后，最多再保留这么久。">
            <input type="number" min={1} max={90} value={form.offlineDays} onChange={event => setForm({ ...form, offlineDays: event.target.value })} />
          </Field>
          <Field label="邀请默认有效天数"><input type="number" min={1} max={90} value={form.inviteDays} onChange={event => setForm({ ...form, inviteDays: event.target.value })} /></Field>
        </div>
        <h2>助手</h2>
        <Field label="助手名称" hint={`员工鲸翼里的「${DEFAULT_ASSISTANT_NAME.full}」统一换成这个名字：助手面板、专家团队、新会话页和给模型的说明都跟着换，原来写「${DEFAULT_ASSISTANT_NAME.short}」的地方也用这个全名。留空就用「${DEFAULT_ASSISTANT_NAME.full}」。最多 ${LIMITS.assistantName} 个字，一行。员工端下次同步时换上（打开 DSH、每 10 分钟，或在「团队」页签点刷新）。`}>
          <input value={form.assistantName} maxLength={LIMITS.assistantName} placeholder={DEFAULT_ASSISTANT_NAME.full} onChange={event => setForm({ ...form, assistantName: event.target.value })} />
        </Field>
        <h2>事项</h2>
        <Field group label="事项默认谁能看" hint="能改的范围不受影响：改别人的事项仍然要在自己的数据范围里，并且有对应的权限点。">
          <label className="check"><input type="radio" name="visibility" checked={form.workVisibility === 'scope'} onChange={() => setForm({ ...form, workVisibility: 'scope' })} />
            <span className="check-hint"><span>数据范围里的 + 自己参与的 + 同项目的</span><span className="muted small">推荐。组长看自己组的，组员看自己负责、协作、在等自己的，以及同项目的事项</span></span></label>
          <label className="check"><input type="radio" name="visibility" checked={form.workVisibility === 'all'} onChange={() => setForm({ ...form, workVisibility: 'all' })} />
            <span className="check-hint"><span>全员可见</span><span className="muted small">适合人少、讲透明的团队：每个人都能看所有事项</span></span></label>
        </Field>
        <Field label="时区" hint="决定“今天”“本周”、逾期和事项编号里的年月。默认北京时间 Asia/Shanghai。"><input value={form.timeZone} maxLength={64} onChange={event => setForm({ ...form, timeZone: event.target.value })} /></Field>
        <div className="row end">{dirty && <span className="tag tag-warn">有未保存的修改</span>}<button type="submit" className="primary" disabled={busy || !dirty}>保存修改</button></div>
      </form>
      <form className="card section form" onSubmit={changePassword}>
        <h2>我的密码</h2>
        <div className="form-grid">
          <Field label="原密码"><input type="password" autoComplete="current-password" value={passwords.oldPassword} onChange={event => setPasswords({ ...passwords, oldPassword: event.target.value })} /></Field>
          <span />
          <Field label="新密码" hint="至少 8 位"><input type="password" autoComplete="new-password" value={passwords.newPassword} onChange={event => setPasswords({ ...passwords, newPassword: event.target.value })} /></Field>
          <Field label="再输一次新密码"><input type="password" autoComplete="new-password" value={passwords.confirm} onChange={event => setPasswords({ ...passwords, confirm: event.target.value })} /></Field>
        </div>
        <div className="row end"><button type="submit" className="primary" disabled={busy || !passwords.oldPassword || passwords.newPassword.length < 8}>修改密码</button></div>
      </form>
    </>
  );
}
