import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseExpertTemplate, renderExpertTemplate } from '@whalewing-enterprise/shared/expert';
import { filePath, readItemFile } from '../api.js';
import { useApp } from '../context.js';
import { ActionMenu, AddCard, ConfirmDialog, Drawer, Empty, Field, formatBytes, formatTime, PageHeader, useToast } from '../ui.jsx';
import { departmentTree } from './Members.jsx';

const KIND = {
  knowledge: { title: '团队知识', unit: '知识空间', add: '新建知识空间', route: 'knowledge',
    summary: '按知识空间放 Markdown 笔记。员工搜索知识时团队知识和个人知识一起出来，标明来自哪个空间。' },
  expert: { title: '团队专家', unit: '专家', add: '新建团队专家', route: 'experts',
    summary: '团队维护的专家出现在员工的“专家团队”里，标“团队”。格式和鲸翼个人版的专家模板一样。' },
  skill: { title: '团队技能', unit: '技能', add: '新建团队技能', route: 'skills',
    summary: '团队技能出现在员工的技能库里，专家和小鲸都能调用。一个技能是一个带 SKILL.md 的目录。' },
};

// ---------- 可见范围和维护人 ----------

export function useAccessText() {
  const { directory } = useApp();
  return useCallback(access => {
    const name = subject => subject.type === 'all' ? '全员'
      : subject.type === 'department' ? directory.departments.find(d => d.id === subject.id)?.name ?? '已删除的部门'
        : directory.users.find(u => u.id === subject.id)?.displayName ?? '已删除的成员';
    const view = access.view.some(subject => subject.type === 'all') ? '全员可见' : access.view.length ? `${access.view.map(name).join('、')}可见` : '只有管理员可见';
    const maintain = access.maintain.length ? `维护人：${access.maintain.map(name).join('、')}` : '只有管理员能改';
    return `${view} · ${maintain}`;
  }, [directory]);
}

function SubjectPicker({ value, onChange, allowAll, emptyText }) {
  const { directory } = useApp();
  const tree = departmentTree(directory.departments);
  const all = value.some(subject => subject.type === 'all');
  const key = subject => `${subject.type}:${subject.id ?? ''}`;
  const chosen = new Set(value.map(key));
  const label = subject => subject.type === 'department' ? `部门 · ${directory.departments.find(d => d.id === subject.id)?.name ?? subject.id}`
    : `成员 · ${directory.users.find(u => u.id === subject.id)?.displayName ?? subject.id}`;
  const add = raw => {
    if (!raw) return;
    const [type, id] = raw.split(':');
    const subject = { type, id: Number(id) };
    if (!chosen.has(key(subject))) onChange([...value.filter(item => item.type !== 'all'), subject]);
  };
  return (
    <div className="picker">
      {allowAll && (
        <div className="row">
          <label className="radio"><input type="radio" checked={all} onChange={() => onChange([{ type: 'all' }])} />全员</label>
          <label className="radio"><input type="radio" checked={!all} onChange={() => onChange([])} />指定部门和成员</label>
        </div>
      )}
      {!all && (
        <>
          <div className="chips">
            {value.length ? value.map(subject => (
              <span key={key(subject)} className="chip">{label(subject)}
                <button type="button" className="icon" aria-label={`去掉${label(subject)}`} onClick={() => onChange(value.filter(item => key(item) !== key(subject)))}>×</button>
              </span>
            )) : <span className="muted small">{emptyText}</span>}
          </div>
          <select value="" onChange={event => add(event.target.value)} aria-label="添加部门或成员">
            <option value="">＋ 添加部门或成员…</option>
            <optgroup label="部门（含下级部门）">
              {tree.map(d => <option key={d.id} value={`department:${d.id}`} disabled={chosen.has(`department:${d.id}`)}>{'　'.repeat(d.depth)}{d.name}</option>)}
            </optgroup>
            <optgroup label="成员">
              {directory.users.filter(u => u.status === 'active').map(u => <option key={u.id} value={`user:${u.id}`} disabled={chosen.has(`user:${u.id}`)}>{u.displayName}（{u.username}）</option>)}
            </optgroup>
          </select>
        </>
      )}
    </div>
  );
}

function ItemDrawer({ kind, item, busy, onClose, onSubmit }) {
  const [form, setForm] = useState(() => item
    ? { title: item.title, description: item.description, access: item.access }
    : { slug: '', title: '', description: '', access: { view: [{ type: 'all' }], maintain: [] } });
  const initial = useRef(JSON.stringify(form));
  const dirty = JSON.stringify(form) !== initial.current;
  const meta = KIND[kind];
  return (
    <Drawer title={item ? `${meta.unit}设置：${item.title}` : meta.add} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || !form.title.trim() || (!item && !form.slug)} onClick={() => onSubmit(item ? form : { kind, ...form })}>{item ? '保存修改' : `创建${meta.unit}`}</button>,
    ]}>
      <Field label="名称"><input value={form.title} maxLength={60} onChange={event => setForm({ ...form, title: event.target.value })} autoFocus /></Field>
      {!item && (
        <Field label="标识" hint={kind === 'skill' ? '小写字母、数字和短横线，也是技能在 DSH 里的名字，建好后不能改。' : '小写字母、数字和短横线，用在网址和员工电脑的缓存目录里，建好后不能改。'}>
          <input value={form.slug} maxLength={64} placeholder={kind === 'skill' ? '例如 weekly-report' : '例如 rd-handbook'}
            onChange={event => setForm({ ...form, slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
        </Field>
      )}
      <Field label="介绍" hint={kind === 'skill' ? '一句话说明这个技能做什么，会写进 SKILL.md 的 description。' : '一句话说明这里放什么。'}>
        <textarea rows={3} maxLength={240} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} />
      </Field>
      <Field group label="谁能看"><SubjectPicker allowAll value={form.access.view} emptyText="还没选，只有管理员能看" onChange={view => setForm({ ...form, access: { ...form.access, view } })} /></Field>
      <Field group label="维护人" hint="维护人能在自己的鲸翼里改这项内容；不选就只有管理员能改。维护人自动能看。">
        <SubjectPicker value={form.access.maintain} emptyText="只有管理员能改" onChange={maintain => setForm({ ...form, access: { ...form.access, maintain } })} />
      </Field>
    </Drawer>
  );
}

// ---------- 内容列表页 ----------

export function ContentPage({ kind }) {
  const { call, go } = useApp();
  const notify = useToast();
  const accessText = useAccessText();
  const [items, setItems] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const meta = KIND[kind];
  const load = useCallback(() => call('GET', `/admin/items?kind=${kind}`).then(data => setItems(data.items))
    .catch(error => notify(error.message, { kind: 'error', action: { label: '重试', run: load } })), [call, kind, notify]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const submit = async input => {
    setBusy(true);
    try {
      if (drawer.item) await call('PATCH', `/admin/items/${kind}/${drawer.item.slug}`, input);
      else await call('POST', '/admin/items', input);
      notify(drawer.item ? '已保存修改' : `${meta.unit}已建好`);
      setDrawer(null); load();
      if (!drawer.item) go(`items/${kind}/${input.slug}`);
    } catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(false); }
  };
  const remove = async item => {
    setBusy(true);
    try { await call('DELETE', `/admin/items/${kind}/${item.slug}`); notify(`已删除“${item.title}”`); setConfirm(null); load(); }
    catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title={meta.title} summary={items ? `${items.length} 个${meta.unit} · ${meta.summary}` : '正在读取…'} />
      {items && (
        <div className="grid cards">
          {items.map(item => (
            <div key={item.slug} className="card item-card" role="button" tabIndex={0} onClick={() => go(`items/${kind}/${item.slug}`)}
              onKeyDown={event => { if (event.key === 'Enter') go(`items/${kind}/${item.slug}`); }}>
              <div className="item-card-head">
                <h3>{item.title}</h3>
                <ActionMenu label={`${item.title}的操作`} items={[
                  { label: '设置', run: () => setDrawer({ item }) },
                  { label: `删除${meta.unit}`, danger: true, run: () => setConfirm(item) },
                ]} />
              </div>
              <p className="muted clamp">{item.description || '没有介绍'}</p>
              <p className="small muted">{kind === 'knowledge' ? `${item.files} 篇笔记` : kind === 'skill' ? `${item.files} 个文件` : '专家模板'} · {formatBytes(item.bytes)} · {formatTime(item.updatedAt)}更新</p>
              <p className="small access">{accessText(item.access)}</p>
              <span className="tag tag-mono">{item.slug}</span>
            </div>
          ))}
          <AddCard label={meta.add} onClick={() => setDrawer({})} />
        </div>
      )}
      {drawer && <ItemDrawer kind={kind} item={drawer.item} busy={busy} onClose={() => setDrawer(null)} onSubmit={submit} />}
      {confirm && <ConfirmDialog title={`删除${meta.unit}`} danger busy={busy} confirmLabel={`删除${meta.unit}`}
        message={`删除“${confirm.title}”和它的全部文件，员工下次同步时本机也会撤掉。这一步不能撤销，需要的话先备份数据目录。`}
        onCancel={() => setConfirm(null)} onConfirm={() => remove(confirm)} />}
    </>
  );
}

// ---------- 内容详情页 ----------

function TextFileDrawer({ title, file, kind, busy, onClose, onSubmit, pathEditable }) {
  const [path, setPath] = useState(file?.path ?? (kind === 'knowledge' ? '' : ''));
  const [text, setText] = useState(file?.text ?? '');
  const dirty = text !== (file?.text ?? '') || (pathEditable && path !== (file?.path ?? ''));
  return (
    <Drawer title={title} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy || !path.trim()} onClick={() => onSubmit(path.trim(), text)}>{file ? '保存修改' : '创建文件'}</button>,
    ]}>
      {pathEditable ? (
        <Field label="文件路径" hint={kind === 'knowledge' ? '可以带子目录，例如 规范/代码评审.md；要以 .md 结尾。' : '相对技能目录的路径，例如 scripts/check.sh。'}>
          <input value={path} onChange={event => setPath(event.target.value)} placeholder={kind === 'knowledge' ? '目录/笔记名.md' : 'references/说明.md'} autoFocus />
        </Field>
      ) : <p className="mono muted">{path}</p>}
      <Field label="内容"><textarea className="editor" rows={22} value={text} onChange={event => setText(event.target.value)} spellCheck={false} /></Field>
    </Drawer>
  );
}

function ExpertDrawer({ value, busy, onClose, onSubmit }) {
  const [form, setForm] = useState({ ...value, skillsText: value.skills.join('\n') });
  const initial = useRef(JSON.stringify(form));
  const dirty = JSON.stringify(form) !== initial.current;
  const submit = () => {
    const skills = form.skillsText.split(/[\s,，]+/).map(skill => skill.trim()).filter(Boolean);
    onSubmit({ name: form.name.trim(), description: form.description.trim(), skills, avatar: form.avatar?.trim() || null, prompt: form.prompt });
  };
  return (
    <Drawer title={`编辑专家：${value.name}`} busy={busy} dirty={dirty} onClose={onClose} footer={[
      <button key="ok" type="button" className="primary" disabled={busy} onClick={submit}>保存修改</button>,
    ]}>
      <Field label="专家名称"><input value={form.name} maxLength={40} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="一句话介绍"><textarea rows={2} maxLength={240} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
      <Field label="技能" hint="每行一个技能名，可以写团队技能的标识，也可以写鲸翼随包的技能（例如 whalewing-writing）。">
        <textarea rows={4} className="mono" value={form.skillsText} onChange={event => setForm({ ...form, skillsText: event.target.value })} />
      </Field>
      <Field label="头像标识" hint="可以不填；写鲸翼个人版的头像标识，例如 preset-01。"><input value={form.avatar ?? ''} maxLength={40} onChange={event => setForm({ ...form, avatar: event.target.value })} /></Field>
      <Field label="提示词" hint="这位专家负责什么、怎么做事、交付什么。"><textarea className="editor" rows={16} value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} /></Field>
    </Drawer>
  );
}

const readFileAsBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => reject(new Error('读不了这个文件'));
  reader.readAsDataURL(file);
});

export function ItemPage({ kind, slug }) {
  const { call, go } = useApp();
  const notify = useToast();
  const accessText = useAccessText();
  const [data, setData] = useState(null);
  const [expert, setExpert] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const upload = useRef(null), mdUpload = useRef(null);
  const meta = KIND[kind];

  const load = useCallback(async () => {
    try {
      const result = await call('GET', `/admin/items/${kind}/${slug}`);
      setData(result);
      if (kind === 'expert') {
        const file = await readItemFile(kind, slug, 'expert.md');
        try { setExpert({ ...parseExpertTemplate(file.text), hash: file.hash, raw: file.text }); }
        catch (error) { setExpert({ problem: error.message, hash: file.hash, raw: file.text }); }
      }
    } catch (error) { notify(error.message, { kind: 'error', action: { label: '重试', run: load } }); }
  }, [call, kind, slug, notify]);
  useEffect(() => { load(); }, [load]);

  const act = async (task, success) => {
    setBusy(true);
    try { await task(); notify(success); setDrawer(null); setConfirm(null); await load(); }
    catch (error) {
      notify(error.message, { kind: 'error', ...(error.code === 'CONFLICT' ? { action: { label: '读取最新内容', run: () => { setDrawer(null); load(); } } } : {}) });
    } finally { setBusy(false); }
  };

  const openFile = async file => {
    try { const content = await readItemFile(kind, slug, file.path); setDrawer({ type: 'file', file: { path: file.path, text: content.text, hash: content.hash } }); }
    catch (error) { notify(error.message, { kind: 'error' }); }
  };
  const saveFile = (path, text) => act(() => call('PUT', filePath(kind, slug, path), { content: text, baseHash: drawer.file?.hash ?? null }), drawer.file ? '已保存修改' : '文件已建好');
  const uploadNotes = async files => {
    setBusy(true);
    let ok = 0;
    try {
      for (const file of files) {
        const text = await file.text();
        await call('PUT', filePath(kind, slug, file.name), { content: text, baseHash: null });
        ok += 1;
      }
      notify(`已上传 ${ok} 篇笔记`);
    } catch (error) { notify(`传了 ${ok} 篇后失败：${error.message}`, { kind: 'error' }); }
    finally { setBusy(false); load(); }
  };
  const uploadArchive = async file => {
    try {
      const archive = await readFileAsBase64(file);
      setConfirm({ title: '上传技能压缩包', message: `用“${file.name}”整体替换这个技能的文件，压缩包里没有的文件会被删掉。`, confirmLabel: '替换技能文件',
        run: () => act(() => call('POST', `/admin/items/skill/${slug}/archive`, { archive }), '技能文件已替换') });
    } catch (error) { notify(error.message, { kind: 'error' }); }
  };

  const files = useMemo(() => (data?.files ?? []).filter(file => !query.trim() || file.path.toLowerCase().includes(query.trim().toLowerCase())), [data, query]);
  if (!data) return <PageHeader title={meta.unit} summary="正在读取…" />;
  const { item } = data;

  return (
    <>
      <div className="crumbs"><button type="button" className="link" onClick={() => go(meta.route)}>{meta.title}</button><span aria-hidden="true">›</span><span>{item.title}</span></div>
      <PageHeader title={item.title} summary={`${item.description || '没有介绍'} · ${accessText(item.access)}`} actions={<>
        <button type="button" onClick={() => setDrawer({ type: 'settings' })}>设置</button>
        {kind === 'expert' && expert && !expert.problem && <button type="button" className="primary" onClick={() => setDrawer({ type: 'expert' })}>编辑专家</button>}
        {kind === 'expert' && <button type="button" onClick={() => setDrawer({ type: 'file', file: { path: 'expert.md', text: expert?.raw ?? '', hash: expert?.hash } })}>编辑模板原文</button>}
        {kind === 'skill' && <><button type="button" onClick={() => upload.current?.click()}>上传压缩包</button>
          <input ref={upload} type="file" accept=".zip,application/zip" hidden onChange={event => { const file = event.target.files[0]; event.target.value = ''; if (file) uploadArchive(file); }} /></>}
        {kind === 'knowledge' && <><button type="button" disabled={busy} onClick={() => mdUpload.current?.click()}>上传笔记</button>
          <input ref={mdUpload} type="file" accept=".md,text/markdown" multiple hidden onChange={event => { const list = [...event.target.files]; event.target.value = ''; if (list.length) uploadNotes(list); }} /></>}
      </>} />

      {kind === 'expert' ? (
        <section className="card expert-preview">
          {expert?.problem ? <p className="form-problem">{expert.problem}。点“编辑模板原文”改正。</p> : expert && (
            <>
              <div className="row"><h2 className="serif">{expert.name}</h2><span className="tag">团队</span></div>
              <p className="muted">{expert.description}</p>
              {expert.skills.length > 0 && <div className="chips">{expert.skills.map(skill => <span key={skill} className="chip mono">{skill}</span>)}</div>}
              <pre className="prompt">{expert.prompt}</pre>
            </>
          )}
        </section>
      ) : (
        <section className="list card">
          <div className="list-head">
            <h2>{kind === 'knowledge' ? '笔记' : '文件'}<span className="muted">（{data.files.length}）</span></h2>
            <input type="search" placeholder="按路径找" value={query} onChange={event => setQuery(event.target.value)} aria-label="按路径找文件" />
          </div>
          <div className="grid file-grid">
            {files.map(file => (
              <div key={file.path} className="card file-card" role="button" tabIndex={0} onClick={() => openFile(file)} onKeyDown={event => { if (event.key === 'Enter') openFile(file); }}>
                <div className="item-card-head">
                  <span className="mono file-path">{file.path}</span>
                  <ActionMenu label={`${file.path}的操作`} items={[
                    { label: '编辑', run: () => openFile(file) },
                    !(kind === 'skill' && file.path === 'SKILL.md') && { label: '删除', danger: true,
                      run: () => setConfirm({ title: '删除文件', message: `删除“${file.path}”。员工下次同步时本机也会撤掉。`, confirmLabel: '删除文件', danger: true,
                        run: () => act(() => call('DELETE', `${filePath(kind, slug, file.path)}?baseHash=${file.hash}`), '文件已删除') }) },
                  ]} />
                </div>
                <span className="small muted">{formatBytes(file.size)} · {formatTime(file.updatedAt)}更新</span>
              </div>
            ))}
            <AddCard label={kind === 'knowledge' ? '新建笔记' : '新建文件'} onClick={() => setDrawer({ type: 'file' })} />
          </div>
          {!data.files.length && kind === 'knowledge' && <Empty>空间里还没有笔记。可以新建，也可以把 .md 文件直接上传进来。</Empty>}
        </section>
      )}

      {drawer?.type === 'settings' && <ItemDrawer kind={kind} item={item} busy={busy} onClose={() => setDrawer(null)}
        onSubmit={input => act(() => call('PATCH', `/admin/items/${kind}/${slug}`, input), '已保存修改')} />}
      {drawer?.type === 'file' && <TextFileDrawer kind={kind} busy={busy} file={drawer.file?.text !== undefined && drawer.file.path ? drawer.file : null}
        title={drawer.file ? `编辑 ${drawer.file.path}` : kind === 'knowledge' ? '新建笔记' : '新建文件'}
        pathEditable={!drawer.file} onClose={() => setDrawer(null)} onSubmit={saveFile} />}
      {drawer?.type === 'expert' && expert && <ExpertDrawer value={expert} busy={busy} onClose={() => setDrawer(null)} onSubmit={value => {
        let text;
        try { text = renderExpertTemplate(value); } catch (error) { notify(error.message, { kind: 'error' }); return; }
        act(() => call('PUT', filePath('expert', slug, 'expert.md'), { content: text, baseHash: expert.hash }), '已保存修改');
      }} />}
      {confirm && <ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.confirmLabel} danger={confirm.danger} busy={busy}
        onCancel={() => setConfirm(null)} onConfirm={confirm.run} />}
    </>
  );
}
