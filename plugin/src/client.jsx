// 浏览器入口：在鲸翼工作台加一个「团队」页签。
// 组件和样式只用鲸翼工作台公开的 workbench.ui 和 ww-* 类，颜色跟随 DSH 皮肤。
import * as React from 'react';
import { featureId } from '../identity.js';
import { contract, input, namespace } from './contract.js';

const { useCallback, useEffect, useMemo, useRef, useState } = React;
export const inject = ['slots', 'locale', 'remote'];

const ROLE = { owner: '所有者', admin: '管理员', member: '成员' };

async function call(remote, raw, signal) {
  const value = input.parse(raw);
  signal?.throwIfAborted();
  const reply = await remote.manage(value, signal);
  signal?.throwIfAborted();
  if (reply?.ok !== true) throw Object.assign(new Error(reply?.error?.message || '没有拿到结果，请刷新后再试'), { code: reply?.error?.code });
  return reply.value;
}

const ago = value => {
  if (!value) return '还没同步过';
  const diff = Date.now() - Date.parse(value);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
};

function Field({ label, hint, children }) {
  return <label className="ww-field" style={{ display: 'grid', gap: 4 }}><span>{label}</span>{children}{hint && <span className="ww-muted" style={{ fontSize: 12 }}>{hint}</span>}</label>;
}

const inputStyle = { width: '100%', boxSizing: 'border-box' };

// ---------- 没连接：加入或登录 ----------

function ConnectView({ status, run, workbench }) {
  const { Modal } = workbench.ui;
  const [address, setAddress] = useState(status.state === 'expired' ? status.server : '');
  const [probe, setProbe] = useState(null);
  const [form, setForm] = useState({ displayName: '', username: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const next = () => run(async (remote, signal) => {
    setBusy(true);
    try { setProbe(await call(remote, { action: 'probe', address: address.trim() }, signal)); } finally { setBusy(false); }
  });
  const submit = () => run(async (remote, signal) => {
    if (probe.mode === 'invite' && form.password !== form.confirm) throw new Error('两次输入的密码不一样');
    setBusy(true);
    try {
      const raw = probe.mode === 'invite'
        ? { action: 'join', address: address.trim(), username: form.username.trim(), displayName: form.displayName.trim(), password: form.password }
        : { action: 'login', address: probe.server, username: form.username.trim(), password: form.password };
      await call(remote, raw, signal);
      setProbe(null);
      workbench.notify(`已加入“${probe.orgName}”，团队内容已同步`, { kind: 'success' });
    } finally { setBusy(false); }
  }, { refresh: true });

  return (
    <>
      {status.state === 'expired' && (
        <section className="ww-section" style={{ borderColor: 'var(--dsw-alias-status-danger, #d1242f)' }}>
          <strong>登录已失效</strong>
          <p className="ww-muted">{status.lastError?.message ?? '请重新登录'}。本机的团队内容已经撤掉，你的个人知识、技能和会话都还在。</p>
        </section>
      )}
      <section className="ww-section" style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
        <h2 style={{ margin: 0 }}>{status.state === 'expired' ? '重新登录' : '加入企业'}</h2>
        <p className="ww-muted">粘贴管理员发给你的邀请链接；已经有账号的，填企业服务器地址登录。连上后，团队知识、团队专家和团队技能会出现在鲸翼原来的页面里。</p>
        <Field label="邀请链接或服务器地址" hint="例如 https://team.example.com/join/…… 或 https://team.example.com">
          <input style={inputStyle} value={address} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && address.trim()) next(); }} />
        </Field>
        <div className="ww-row"><button type="button" className="ww-primary" disabled={busy || !address.trim()} onClick={next}>{busy && !probe ? '正在连接…' : '下一步'}</button></div>
      </section>
      {probe && (
        <Modal title={`你将加入：${probe.orgName}`} busy={busy} onClose={() => setProbe(null)}>
          <div style={{ display: 'grid', gap: 10 }}>
            <p>服务器 <code>{probe.server}</code>{probe.encrypted ? '（加密连接）' : ''}</p>
            {!probe.encrypted && <p className="ww-muted">这是内网地址，连接没有加密。只在公司内网里使用时可以接受。</p>}
            {probe.mode === 'invite' && <p className="ww-muted">加入后在{probe.department ? `「${probe.department}」` : '企业里'}，身份是{ROLE[probe.role]}。</p>}
            <p className="ww-muted">加入后，企业维护的专家和技能会在你的电脑上让模型读写文件、执行命令。请确认这是你所在的企业。企业看不到你的个人知识、个人技能和会话。</p>
            {probe.mode === 'invite' && <Field label="你的名字"><input style={inputStyle} value={form.displayName} maxLength={40} onChange={event => setForm({ ...form, displayName: event.target.value })} /></Field>}
            <Field label="登录名" hint={probe.mode === 'invite' ? '字母、数字、点、短横线和下划线，以后换电脑也用它登录' : ''}>
              <input style={inputStyle} value={form.username} autoComplete="username" maxLength={32} onChange={event => setForm({ ...form, username: event.target.value })} />
            </Field>
            <Field label="密码" hint={probe.mode === 'invite' ? '至少 8 位' : ''}>
              <input style={inputStyle} type="password" value={form.password} autoComplete={probe.mode === 'invite' ? 'new-password' : 'current-password'} onChange={event => setForm({ ...form, password: event.target.value })} />
            </Field>
            {probe.mode === 'invite' && <Field label="再输一次密码"><input style={inputStyle} type="password" value={form.confirm} autoComplete="new-password" onChange={event => setForm({ ...form, confirm: event.target.value })} /></Field>}
          </div>
          <div className="ww-dialog-actions">
            <button type="button" disabled={busy} onClick={() => setProbe(null)}>取消</button>
            <button type="button" className="ww-primary" disabled={busy || !form.username.trim() || !form.password || (probe.mode === 'invite' && !form.displayName.trim())} onClick={submit}>
              {busy ? '正在连接…' : probe.mode === 'invite' ? '确认加入' : '确认登录'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- 已连接 ----------

function NoteDrawer({ workbench, run, space, note, onClose }) {
  const { Drawer } = workbench.ui;
  const [path, setPath] = useState(note?.path ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  const [busy, setBusy] = useState(false);
  const editable = space.canMaintain;
  const save = () => run(async (remote, signal) => {
    setBusy(true);
    try {
      await call(remote, { action: 'write', kind: 'knowledge', slug: space.slug, path: path.trim(), content, baseHash: note?.hash ?? null }, signal);
      workbench.notify(note ? '已保存修改，团队成员下次同步就能看到' : '笔记已建好', { kind: 'success' });
      onClose();
    } finally { setBusy(false); }
  }, { refresh: true });
  const footer = editable ? [
    <button key="cancel" type="button" disabled={busy} onClick={onClose}>取消</button>,
    <button key="save" type="button" className="ww-primary" disabled={busy || !path.trim()} onClick={save}>{note ? '保存修改' : '创建笔记'}</button>,
  ] : undefined;
  return (
    <Drawer title={note ? (editable ? `编辑 ${note.path}` : note.path) : `在「${space.title}」新建笔记`} busy={busy} onClose={onClose} footer={footer}>
      <div style={{ display: 'grid', gap: 12 }}>
        {!note && <Field label="笔记路径" hint="可以带子目录，例如 规范/代码评审.md，要以 .md 结尾"><input style={inputStyle} value={path} onChange={event => setPath(event.target.value)} /></Field>}
        {editable
          ? <Field label="内容"><textarea rows={20} style={{ ...inputStyle, fontFamily: 'var(--dsw-alias-font-mono, monospace)' }} value={content} onChange={event => setContent(event.target.value)} /></Field>
          : <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{content}</pre>}
        {!editable && <p className="ww-muted">你不是这个空间的维护人，只能查看。在知识页搜索时也能搜到这篇。</p>}
      </div>
    </Drawer>
  );
}

function SubmitDrawer({ workbench, run, spaces, onClose }) {
  const { Drawer } = workbench.ui;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [slug, setSlug] = useState(spaces[0]?.slug ?? '');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const search = () => run(async (remote, signal) => {
    setBusy(true);
    try { setResults((await call(remote, { action: 'personalSearch', query: query.trim() }, signal)).notes); } finally { setBusy(false); }
  });
  const submit = () => run(async (remote, signal) => {
    setBusy(true);
    try {
      await call(remote, { action: 'submitPersonal', notePath: chosen.path, slug, path: path.trim() }, signal);
      workbench.notify('已提交到团队，你的个人笔记原样保留', { kind: 'success' });
      onClose();
    } finally { setBusy(false); }
  }, { refresh: true });
  return (
    <Drawer title="把个人笔记提交到团队" busy={busy} onClose={onClose} footer={[
      <button key="cancel" type="button" disabled={busy} onClick={onClose}>取消</button>,
      <button key="ok" type="button" className="ww-primary" disabled={busy || !chosen || !slug || !path.trim()} onClick={submit}>提交到团队</button>,
    ]}>
      <div style={{ display: 'grid', gap: 12 }}>
        <p className="ww-muted">只发你选的这一篇，复制一份到团队知识空间；你的个人知识库不会有任何改动，其他笔记也不会上传。</p>
        <Field label="找自己的笔记">
          <div className="ww-row"><input style={{ flex: 1 }} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') search(); }} placeholder="关键字" />
            <button type="button" disabled={busy} onClick={search}>查找</button></div>
        </Field>
        {results && (results.length ? (
          <div style={{ display: 'grid', gap: 4, maxHeight: 260, overflow: 'auto' }}>
            {results.map(note => (
              <label key={note.path} className="ww-row" style={{ cursor: 'pointer' }}>
                <input type="radio" name="note" checked={chosen?.path === note.path} onChange={() => { setChosen(note); setPath(note.path.split('/').pop()); }} />
                <span>{note.title}</span><span className="ww-muted" style={{ fontSize: 12 }}>{note.path}</span>
              </label>
            ))}
          </div>
        ) : <p className="ww-muted">没找到，换个关键字试试。</p>)}
        <Field label="提交到哪个知识空间">
          <select value={slug} onChange={event => setSlug(event.target.value)}>{spaces.map(space => <option key={space.slug} value={space.slug}>{space.title}</option>)}</select>
        </Field>
        <Field label="在团队里的路径" hint="可以带子目录，要以 .md 结尾；同名的已经存在时会提示"><input style={inputStyle} value={path} onChange={event => setPath(event.target.value)} /></Field>
      </div>
    </Drawer>
  );
}

function SkillDrawer({ workbench, run, skill, file, onClose }) {
  const { Drawer } = workbench.ui;
  const [content, setContent] = useState(file.content);
  const [busy, setBusy] = useState(false);
  const save = () => run(async (remote, signal) => {
    setBusy(true);
    try {
      await call(remote, { action: 'write', kind: 'skill', slug: skill.slug, path: 'SKILL.md', content, baseHash: file.hash }, signal);
      workbench.notify('已保存修改', { kind: 'success' });
      onClose();
    } finally { setBusy(false); }
  }, { refresh: true });
  return (
    <Drawer title={`编辑技能 ${skill.title}`} busy={busy} onClose={onClose} footer={[
      <button key="cancel" type="button" disabled={busy} onClick={onClose}>取消</button>,
      <button key="save" type="button" className="ww-primary" disabled={busy} onClick={save}>保存修改</button>,
    ]}>
      <p className="ww-muted">这里改的是 SKILL.md。技能里的其他文件（脚本、参考资料）请在管理端上传压缩包替换。</p>
      <textarea rows={22} style={{ ...inputStyle, fontFamily: 'var(--dsw-alias-font-mono, monospace)' }} value={content} onChange={event => setContent(event.target.value)} />
    </Drawer>
  );
}

function SpaceCard({ space, onOpen, menu }) {
  return (
    <div className="ww-card" role="button" tabIndex={0} style={{ cursor: 'pointer', display: 'grid', gap: 6, alignContent: 'start' }}
      onClick={onOpen} onKeyDown={event => { if (event.key === 'Enter') onOpen(); }}>
      <div className="ww-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <strong style={{ fontFamily: 'var(--dsw-alias-font-serif, serif)' }}>{space.title}</strong>
        {menu && <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{menu}</span>}
      </div>
      <span className="ww-muted">{space.description || '没有介绍'}</span>
      <span className="ww-muted" style={{ fontSize: 12 }}>{space.files.length} 篇笔记 · {space.canMaintain ? '你可以维护' : '只读'}</span>
    </div>
  );
}

function ConnectedView({ status, run, workbench }) {
  const { ConfirmDialog, ActionMenu, Drawer } = workbench.ui;
  const [drawer, setDrawer] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const spaces = status.items.filter(item => item.kind === 'knowledge');
  const experts = status.items.filter(item => item.kind === 'expert');
  const skills = status.items.filter(item => item.kind === 'skill');
  const maintainable = spaces.filter(space => space.canMaintain);
  const me = status.me;

  const openNote = (space, file) => run(async (remote, signal) => {
    const note = await call(remote, { action: 'read', kind: 'knowledge', slug: space.slug, path: file.path }, signal);
    setDrawer({ type: 'note', space, note });
  });
  const openSkill = skill => run(async (remote, signal) => {
    const file = await call(remote, { action: 'read', kind: 'skill', slug: skill.slug, path: 'SKILL.md' }, signal);
    setDrawer({ type: 'skill', skill, file });
  });
  const leave = () => run(async (remote, signal) => {
    await call(remote, { action: 'leave' }, signal);
    setLeaving(false);
    workbench.notify('已退出团队，本机的团队内容已撤掉，个人内容都还在', { kind: 'success' });
  }, { refresh: true });

  return (
    <>
      {status.state === 'offline' && (
        <section className="ww-section">
          <strong>{status.hidden ? '离线太久，团队内容先收起来了' : '暂时连不上企业服务端'}</strong>
          <p className="ww-muted">{status.lastError?.message}。{status.hidden
            ? `超过企业规定的 ${status.offlineDays} 天没连上，团队内容已从本机撤掉，连上后会自动恢复。`
            : `上次同步在 ${ago(status.lastOkAt)}，团队内容照常能用；超过 ${status.offlineDays} 天还连不上会先收起来。`}</p>
        </section>
      )}

      <section className="ww-section" style={{ display: 'grid', gap: 6 }}>
        <div className="ww-row" style={{ justifyContent: 'space-between' }}>
          <strong>{me.user.displayName}<span className="ww-muted">（{me.user.username} · {ROLE[me.user.role]}）</span></strong>
          <button type="button" className="ww-danger" onClick={() => setLeaving(true)}>退出团队</button>
        </div>
        <span className="ww-muted">{me.org.name}{me.department ? ` · ${me.department.path.join(' / ')}` : ''} · 服务器 {status.server}{status.encrypted ? '' : '（内网，未加密）'}</span>
        <span className="ww-muted" style={{ fontSize: 12 }}>企业看不到你的个人知识、个人技能和会话；只有你点“提交到团队”的笔记才会发给企业。</span>
      </section>

      <h3 style={{ margin: '18px 0 8px' }}>团队知识 <span className="ww-muted" style={{ fontWeight: 400 }}>· 在知识页搜索时和个人知识一起出来</span></h3>
      {spaces.length ? (
        <div className="ww-grid">
          {spaces.map(space => (
            <SpaceCard key={space.slug} space={space} onOpen={() => setDrawer({ type: 'space', space })}
              menu={space.canMaintain && <ActionMenu label={`${space.title}的操作`} iconOnly>
                <button type="button" onClick={() => setDrawer({ type: 'note', space, note: null })}>新建笔记</button>
                <button type="button" onClick={() => setDrawer({ type: 'submit' })}>提交个人笔记</button>
              </ActionMenu>} />
          ))}
        </div>
      ) : <p className="ww-muted">企业还没有给你开放知识空间。</p>}

      <h3 style={{ margin: '18px 0 8px' }}>团队专家 <span className="ww-muted" style={{ fontWeight: 400 }}>· 在「专家团队」里选用，卡片标“团队”</span></h3>
      {experts.length ? (
        <div className="ww-grid">
          {experts.map(expert => (
            <div key={expert.slug} className="ww-card" style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <strong style={{ fontFamily: 'var(--dsw-alias-font-serif, serif)' }}>{expert.title}</strong>
              <span className="ww-muted">{expert.description || '没有介绍'}</span>
              <span className="ww-muted" style={{ fontSize: 12 }}>{expert.canMaintain ? '你可以维护：在「专家团队」里点这位专家的“编辑专家”' : '只读：可以在「专家团队」里复制为自己的专家再改'}</span>
            </div>
          ))}
        </div>
      ) : <p className="ww-muted">企业还没有给你开放团队专家。</p>}

      <h3 style={{ margin: '18px 0 8px' }}>团队技能 <span className="ww-muted" style={{ fontWeight: 400 }}>· 在技能库的“扩展”一组里，专家和小鲸都能调用</span></h3>
      {skills.length ? (
        <div className="ww-grid">
          {skills.map(skill => (
            <div key={skill.slug} className="ww-card" style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
              <div className="ww-row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <strong style={{ fontFamily: 'var(--dsw-alias-font-serif, serif)' }}>{skill.title}</strong>
                {skill.canMaintain && <ActionMenu label={`${skill.title}的操作`} iconOnly><button type="button" onClick={() => openSkill(skill)}>编辑技能</button></ActionMenu>}
              </div>
              <span className="ww-muted">{skill.description || '没有介绍'}</span>
              <span className="ww-muted" style={{ fontSize: 12 }}><code>{skill.slug}</code> · {skill.files.length} 个文件</span>
            </div>
          ))}
        </div>
      ) : <p className="ww-muted">企业还没有给你开放团队技能。</p>}

      {drawer?.type === 'space' && (
        <Drawer title={drawer.space.title} onClose={() => setDrawer(null)} footer={drawer.space.canMaintain ? [
          <button key="submit" type="button" onClick={() => setDrawer({ type: 'submit' })}>提交个人笔记</button>,
          <button key="new" type="button" className="ww-primary" onClick={() => setDrawer({ type: 'note', space: drawer.space, note: null })}>新建笔记</button>,
        ] : undefined}>
          <div style={{ display: 'grid', gap: 4 }}>
            {drawer.space.files.length ? drawer.space.files.map(file => (
              <button key={file.path} type="button" style={{ textAlign: 'left' }} onClick={() => openNote(drawer.space, file)}>{file.path}</button>
            )) : <p className="ww-muted">这个空间还没有笔记。</p>}
          </div>
        </Drawer>
      )}
      {drawer?.type === 'note' && <NoteDrawer workbench={workbench} run={run} space={drawer.space} note={drawer.note} onClose={() => setDrawer(null)} />}
      {drawer?.type === 'submit' && <SubmitDrawer workbench={workbench} run={run} spaces={maintainable} onClose={() => setDrawer(null)} />}
      {drawer?.type === 'skill' && <SkillDrawer workbench={workbench} run={run} skill={drawer.skill} file={drawer.file} onClose={() => setDrawer(null)} />}
      {leaving && <ConfirmDialog title="退出团队" danger confirmLabel="退出团队" cancelLabel="留在团队"
        message={`退出“${me.org.name}”后，本机的团队知识、团队专家和团队技能都会撤掉，正在用团队专家的会话不能再继续。你的个人知识、个人技能和会话都不受影响。以后可以用账号重新登录。`}
        onConfirm={leave} onCancel={() => setLeaving(false)} />}
    </>
  );
}

// ---------- 页签 ----------

export function apply(ctx) {
  // 顶层不等鲸翼；所有远程挂载、页签和迟到结果都放在可撤销的子作用域里。
  ctx.inject(['whalewingWorkbench'], scope => {
    function TeamTab({ active, workbench }) {
      const [remote, setRemote] = useState(null);
      const [problem, setProblem] = useState(null);
      const [attempt, setAttempt] = useState(0);
      const [status, setStatus] = useState(null);
      const alive = useRef(true);
      const remoteRef = useRef(null);
      remoteRef.current = remote;

      // 连上 Host 的 manage 方法；写法照鲸翼的保存状态模板。
      useEffect(() => {
        const local = new AbortController();
        let release, dependency;
        setProblem(null);
        const timer = setTimeout(() => { if (!local.signal.aborted) setProblem('连接鲸翼企业版超时'); }, 10000);
        Promise.resolve().then(() => scope.remote.$mount(contract.client)).then(async unmount => {
          if (local.signal.aborted) { await unmount(); return; }
          release = unmount;
          dependency = scope.inject(['remote.' + namespace], child => {
            if (local.signal.aborted) return;
            clearTimeout(timer);
            setRemote(child.remote[namespace]);
            child.effect(() => () => { if (!local.signal.aborted) { setRemote(null); setProblem('和鲸翼企业版的连接断开了'); } });
          });
          await dependency;
        }).catch(error => { if (!local.signal.aborted) setProblem(error.message); });
        return () => {
          local.abort(); clearTimeout(timer); setRemote(null);
          void Promise.resolve(dependency?.dispose?.()).finally(() => release?.()).catch(error => console.warn('鲸翼企业版连接清理失败', error));
        };
      }, [attempt]);

      useEffect(() => () => { alive.current = false; }, []);

      const refresh = useCallback(async signal => {
        const current = remoteRef.current;
        if (!current) return;
        const value = await call(current, { action: 'status' }, signal);
        if (alive.current) setStatus(value);
      }, []);

      // 所有操作走工作台的统一忙碌状态；失败用右上角提示，说清原因和怎么办。
      const run = useCallback((task, { refresh: after } = {}) => workbench.run(async signal => {
        const current = remoteRef.current;
        if (!current) { workbench.notify('还没连上鲸翼企业版，请稍等或点“重新连接”', { kind: 'error' }); return; }
        try { await task(current, signal); }
        catch (error) {
          if (signal.aborted) return;
          const conflict = error.code === 'CONFLICT' || error.code === 'EXISTS';
          workbench.notify(error.message, { kind: 'error', ...(conflict ? { action: { label: '刷新团队内容', run: () => workbench.run(s => call(current, { action: 'sync' }, s).then(setStatus)) } } : {}) });
        } finally {
          if (after && !signal.aborted) await refresh(signal).catch(() => {});
        }
      }), [workbench, refresh]);

      useEffect(() => {
        if (!remote) return undefined;
        const controller = new AbortController();
        refresh(controller.signal).catch(error => { if (!controller.signal.aborted) workbench.notify(error.message, { kind: 'error' }); });
        // 页签显示时每 30 秒读一次本机状态（不连服务端）；同步由 Host 每 10 分钟做一次。
        const timer = active ? setInterval(() => refresh(controller.signal).catch(() => {}), 30_000) : null;
        return () => { controller.abort(); clearInterval(timer); };
      }, [remote, active, refresh, workbench]);

      useEffect(() => workbench.onRefresh(() => run(async (current, signal) => {
        const value = await call(current, { action: 'sync' }, signal);
        setStatus(value);
        if (value.lastError) workbench.notify(`同步没成功：${value.lastError.message}`, { kind: 'error', action: { label: '重试', run: () => workbench.run(s => call(current, { action: 'sync' }, s).then(setStatus)) } });
        else if (value.state === 'connected') workbench.notify('团队内容已是最新', { kind: 'success' });
      })), [workbench, run]);

      const summary = useMemo(() => {
        if (!status) return '正在读取…';
        if (status.state === 'disconnected') return '没有连接企业';
        if (status.state === 'expired') return '登录已失效，请重新登录';
        const org = status.me?.org?.name ?? '';
        const department = status.me?.department ? ` · ${status.me.department.name}` : '';
        return status.state === 'offline' ? `${org}${department} · 离线 · 上次同步 ${ago(status.lastOkAt)}` : `${org}${department} · ${ago(status.lastOkAt)}同步`;
      }, [status]);

      return (
        <div style={{ display: 'grid', gap: 12 }} aria-label="团队">
          <div>
            <h1 style={{ margin: 0, fontFamily: 'var(--dsw-alias-font-serif, serif)', fontSize: 20 }}>团队</h1>
            <p className="ww-muted" style={{ margin: '4px 0 0' }}>{summary}</p>
          </div>
          {problem && !remote ? (
            <section className="ww-section">
              <p>{problem}。可能是鲸翼企业版刚被关掉或还在加载。</p>
              <div className="ww-row"><button type="button" onClick={() => setAttempt(value => value + 1)}>重新连接</button></div>
            </section>
          ) : !status ? null : status.state === 'disconnected' || status.state === 'expired'
            ? <ConnectView status={status} run={run} workbench={workbench} />
            : <ConnectedView status={status} run={run} workbench={workbench} />}
        </div>
      );
    }
    scope.slots.inject('whalewing.workbench.tab', () => scope.slots.register({
      name: 'whalewing.workbench.tab', id: featureId, order: 120,
      label: () => scope.locale.resolveText({ zh: '团队', en: 'Team' }),
    }, TeamTab));
  });
}
