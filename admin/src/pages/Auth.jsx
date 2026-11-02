import { useState } from 'react';
import { api } from '../api.js';
import { Field, Logo } from '../ui.jsx';

function AuthFrame({ title, summary, children }) {
  return (
    <div className="auth">
      <div className="auth-card card">
        <div className="brand brand-large"><Logo size={34} /><div><strong>鲸翼企业版</strong><span className="muted">管理端</span></div></div>
        <h1>{title}</h1>
        {summary && <p className="muted">{summary}</p>}
        {children}
      </div>
    </div>
  );
}

export function SetupPage({ onDone }) {
  const [form, setForm] = useState({ setupCode: '', orgName: '', displayName: '', username: '', password: '', confirm: '', publicUrl: '' });
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const submit = async event => {
    event.preventDefault();
    if (form.password !== form.confirm) return setProblem('两次输入的密码不一样');
    setBusy(true); setProblem('');
    try {
      const { confirm, publicUrl, ...rest } = form;
      await api('POST', '/setup', { ...rest, ...(publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {}) });
      onDone();
    } catch (error) { setProblem(error.message); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title="初始化企业" summary="第一次打开管理端：填企业名称，建第一个管理员。管理员可以有多个，之后可以再任命；员工靠邀请加入。">
      <form className="form" onSubmit={submit}>
        <Field label="初始化码" hint="在服务端的启动日志里，或者数据目录的 setup-code.txt 里。">
          <input value={form.setupCode} onChange={set('setupCode')} placeholder="例如 1234-5678" autoComplete="off" required />
        </Field>
        <Field label="企业名称" hint="员工加入时会看到“你将加入：企业名称”。"><input value={form.orgName} onChange={set('orgName')} maxLength={60} required /></Field>
        <div className="form-grid">
          <Field label="你的名字"><input value={form.displayName} onChange={set('displayName')} maxLength={40} required /></Field>
          <Field label="登录名" hint="字母、数字、点、短横线"><input value={form.username} onChange={set('username')} autoComplete="username" maxLength={32} required /></Field>
        </div>
        <div className="form-grid">
          <Field label="密码" hint="至少 8 位"><input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={8} required /></Field>
          <Field label="再输一次密码"><input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required /></Field>
        </div>
        <Field label="对外地址（可以以后再填）" hint="员工连接用的地址，例如 https://team.example.com；用来生成邀请链接。不填就用你现在打开的地址。">
          <input value={form.publicUrl} onChange={set('publicUrl')} placeholder="https://" />
        </Field>
        {problem && <p className="form-problem" role="alert">{problem}</p>}
        <button type="submit" className="primary wide" disabled={busy}>{busy ? '正在初始化…' : '完成初始化'}</button>
      </form>
    </AuthFrame>
  );
}

export function LoginPage({ orgName, problem: initial, onDone }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(initial ?? '');
  const submit = async event => {
    event.preventDefault();
    setBusy(true); setProblem('');
    try { await api('POST', '/auth/login', { username, password, client: 'admin' }); onDone(); }
    catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  };
  return (
    <AuthFrame title={orgName ? `登录 ${orgName}` : '登录管理端'} summary="管理员用自己的账号登录。员工请在鲸翼的「团队」页签登录。">
      <form className="form" onSubmit={submit}>
        <Field label="登录名"><input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoFocus required /></Field>
        <Field label="密码"><input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></Field>
        {problem && <p className="form-problem" role="alert">{problem}</p>}
        <button type="submit" className="primary wide" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
      </form>
    </AuthFrame>
  );
}
