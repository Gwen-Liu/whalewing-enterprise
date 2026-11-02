// 从表格导入事项：选文件（CSV、Excel）→ 把列对到字段 → 把旧状态、负责人、项目对上 → 先检查再导入。
// 文件在浏览器里解析，不上传原文件；发给服务端的是整理好的行，服务端逐行再校验一遍。
import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_LABELS } from '@whalewing-enterprise/shared/protocol';
import { useApp } from '../context.js';
import { Field, PageHeader, useToast } from '../ui.jsx';
import { normalizeDate, normalizeProgress, readSheet } from '../sheet.js';

const TARGETS = [
  { key: 'title', label: '标题', required: true, guess: /标题|名称|事项|任务|主题|title|summary|subject/i },
  { key: 'assignee', label: '负责人', required: true, guess: /负责人|处理人|经办人|执行人|owner|assignee/i },
  { key: 'status', label: '状态', guess: /状态|status/i },
  { key: 'priority', label: '优先级', guess: /优先级|紧急|priority/i },
  { key: 'startDate', label: '开始日期', guess: /开始|start/i },
  { key: 'dueDate', label: '截止日期', guess: /截止|到期|计划完成|期限|due|deadline/i },
  { key: 'completedAt', label: '完成日期', guess: /实际完成|完成日期|完成时间|completed/i },
  { key: 'progress', label: '进度', guess: /进度|progress/i },
  { key: 'project', label: '项目', guess: /项目|project/i },
  { key: 'content', label: '内容', guess: /内容|描述|说明|详情|备注|description/i },
  { key: 'waitingNote', label: '在等什么', guess: /等待|阻塞|卡在/i },
  { key: 'sourceNumber', label: '原编号', guess: /编号|单号|^id$|number/i },
];

const STATUS_WORDS = [
  ['cancelled', /取消|作废|关闭不做|cancel/i],
  ['done', /完成|已上线|已关闭|关闭|结束|done|closed|resolved/i],
  ['waiting', /等待|阻塞|挂起|暂停|待确认|waiting|blocked|hold/i],
  ['doing', /进行|处理中|开发中|实施中|测试中|doing|progress/i],
  ['todo', /未开始|待|新建|打开|open|todo|new/i],
];

const guessStatus = (value, statuses) => {
  const text = String(value).trim();
  const exact = statuses.find(status => status.name === text || CATEGORY_LABELS[status.category] === text);
  if (exact) return exact.key;
  for (const [category, pattern] of STATUS_WORDS) if (pattern.test(text)) return statuses.find(status => status.category === category)?.key ?? '';
  return '';
};
const guessPriority = value => /高|紧急|high|p0|p1|urgent/i.test(value) ? 'high' : /低|low|p3|p4/i.test(value) ? 'low' : 'medium';
const SKIP = 'skip';

export function ImportPage() {
  const { call, directory } = useApp();
  const notify = useToast();
  const [file, setFile] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [mapping, setMapping] = useState({});
  const [types, setTypes] = useState([]);
  const [projects, setProjects] = useState([]);
  const [typeId, setTypeId] = useState(null);
  const [statusMap, setStatusMap] = useState({});
  const [peopleMap, setPeopleMap] = useState({});
  const [projectMap, setProjectMap] = useState({});
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('GET', '/admin/work-types').then(data => { const usable = data.types.filter(type => !type.archived); setTypes(usable); setTypeId(current => current ?? usable[0]?.id ?? null); }).catch(error => notify(error.message, { kind: 'error' }));
    call('GET', '/work/projects').then(data => setProjects(data.projects.filter(project => project.status === 'active'))).catch(() => {});
  }, [call, notify]);

  const open = async chosen => {
    if (!chosen) return;
    setCheck(null);
    try {
      const rows = (await readSheet(chosen)).map(row => row.map(cell => String(cell ?? '').trim()));
      const start = rows.findIndex(row => row.some(Boolean));
      if (start < 0) throw new Error('表格是空的');
      const header = rows[start];
      const data = rows.slice(start + 1).map((row, index) => ({ line: start + index + 2, cells: row })).filter(row => row.cells.some(Boolean));
      if (!data.length) throw new Error('表格只有表头，没有数据行');
      const guessed = {};
      for (const target of TARGETS) {
        const index = header.findIndex((name, column) => target.guess.test(name) && !Object.values(guessed).includes(column));
        if (index >= 0) guessed[target.key] = index;
      }
      setFile(chosen); setSheet({ header, data }); setMapping(guessed); setStatusMap({}); setPeopleMap({}); setProjectMap({});
    } catch (error) { notify(error.message, { kind: 'error' }); }
  };

  const type = types.find(entry => entry.id === typeId);
  const valuesOf = key => mapping[key] === undefined || !sheet ? [] : [...new Set(sheet.data.map(row => row.cells[mapping[key]] ?? '').filter(Boolean))];
  const statusValues = useMemo(() => valuesOf('status'), [sheet, mapping]); // eslint-disable-line react-hooks/exhaustive-deps
  const peopleValues = useMemo(() => valuesOf('assignee'), [sheet, mapping]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectValues = useMemo(() => valuesOf('project'), [sheet, mapping]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeUsers = directory.users.filter(user => user.status === 'active');
  const matchPerson = value => activeUsers.find(user => user.displayName === value || user.username.toLowerCase() === value.toLowerCase())?.id ?? '';
  const statusFor = value => statusMap[value] ?? (type ? guessStatus(value, type.statuses) : '');
  const personFor = value => peopleMap[value] ?? matchPerson(value);
  const projectFor = value => projectMap[value] ?? (projects.find(project => project.name === value)?.id ?? '');
  const defaultStatus = type?.statuses.find(status => status.category === 'todo')?.key ?? type?.statuses[0]?.key;

  const build = () => {
    const rows = [], lines = [], skipped = [], local = [];
    for (const row of sheet.data) {
      const cell = key => mapping[key] === undefined ? '' : row.cells[mapping[key]] ?? '';
      const person = personFor(cell('assignee'));
      if (person === SKIP) { skipped.push(row.line); continue; }
      // 对不上的先在这里说清楚，不发给服务端。
      if (!person) { local.push({ line: row.line, message: cell('assignee') ? `负责人“${cell('assignee')}”还没对上是谁` : '没写负责人' }); continue; }
      const status = cell('status') ? statusFor(cell('status')) : defaultStatus;
      if (!status) { local.push({ line: row.line, message: `状态“${cell('status')}”还没对上` }); continue; }
      const project = cell('project') ? projectFor(cell('project')) : '';
      rows.push({
        title: cell('title'), typeId, status, assigneeId: person,
        ...(cell('priority') ? { priority: guessPriority(cell('priority')) } : {}),
        ...(project ? { projectId: Number(project) } : {}),
        ...(cell('startDate') ? { startDate: normalizeDate(cell('startDate')) } : {}),
        ...(cell('dueDate') ? { dueDate: normalizeDate(cell('dueDate')) } : {}),
        ...(cell('completedAt') ? { completedAt: normalizeDate(cell('completedAt')) } : {}),
        ...(normalizeProgress(cell('progress')) !== null ? { progress: normalizeProgress(cell('progress')) } : {}),
        ...(cell('content') ? { content: cell('content') } : {}),
        ...(cell('waitingNote') ? { waitingNote: cell('waitingNote').slice(0, 200) } : {}),
        ...(cell('sourceNumber') ? { sourceNumber: cell('sourceNumber').slice(0, 60) } : {}),
      });
      lines.push(row.line);
    }
    return { rows, lines, skipped, local };
  };

  const submit = async dryRun => {
    const { rows, lines, skipped, local } = build();
    if (!rows.length && !local.length) { notify('没有要导入的行：负责人都选了“这一行不导入”', { kind: 'error' }); return; }
    setBusy(true);
    try {
      // 有对不上的行又没选“跳过”时，只检查不导入，一个都不建。
      const onlyCheck = dryRun || (local.length > 0 && !skipInvalid);
      const result = rows.length ? await call('POST', '/admin/work/import', { rows, dryRun: onlyCheck, skipInvalid }) : { created: 0, valid: 0, problems: [] };
      // 服务端说的是第几条，换成表格里的第几行。
      const problems = [...local, ...result.problems.map(problem => ({ line: lines[problem.row - 1], message: problem.message }))].sort((a, b) => a.line - b.line);
      setCheck({ ...result, problems, skipped, dryRun });
      if (!dryRun && result.created) notify(`已导入 ${result.created} 个事项`);
      else if (!dryRun && problems.length) notify(`有 ${problems.length} 行有问题，一个都没导入。改好后再导，或勾选“跳过有问题的行”`, { kind: 'error' });
    } catch (error) { notify(error.message, { kind: 'error' }); } finally { setBusy(false); }
  };

  const ready = sheet && mapping.title !== undefined && mapping.assignee !== undefined && typeId;
  return (
    <>
      <PageHeader title="从表格导入事项" summary="把旧系统导出的表格（CSV 或 Excel .xlsx）搬进来：先把列对到字段，再把旧状态对到这里的状态和大类，检查没问题后导入。文件只在浏览器里读，不上传原文件。" />
      <section className="card section form" style={{ marginTop: 0 }}>
        <h2>1. 选表格</h2>
        <Field label="表格文件" hint="第一行是表头。一个表格里有几种类型的事项时，按类型分开导入。"><input type="file" accept=".csv,.xlsx,text/csv" onChange={event => open(event.target.files[0])} /></Field>
        {sheet && <p className="muted">{file.name}：{sheet.header.length} 列，{sheet.data.length} 行数据。</p>}
      </section>

      {sheet && (
        <section className="card section form">
          <h2>2. 把列对到字段</h2>
          <Field label="导入成哪个类型"><select value={typeId ?? ''} onChange={event => { setTypeId(Number(event.target.value)); setStatusMap({}); }}>
            {types.map(entry => <option key={entry.id} value={entry.id}>{entry.name}（{entry.prefix}）</option>)}
          </select></Field>
          <div className="form-grid">
            {TARGETS.map(target => (
              <Field key={target.key} label={`${target.label}${target.required ? '（必填）' : ''}`}>
                <select value={mapping[target.key] ?? ''} onChange={event => setMapping({ ...mapping, [target.key]: event.target.value === '' ? undefined : Number(event.target.value) })}>
                  <option value="">不导入</option>
                  {sheet.header.map((name, index) => <option key={index} value={index}>{name || `第 ${index + 1} 列`}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </section>
      )}

      {ready && (
        <section className="card section form">
          <h2>3. 把旧的值对上</h2>
          {statusValues.length > 0 && <Field group label="状态" hint={`表格里没写状态的行用“${type.statuses.find(status => status.key === defaultStatus)?.name}”。`}>
            <div className="table-wrap"><table><tbody>{statusValues.map(value => (
              <tr key={value}><td>{value}</td><td>
                <select value={statusFor(value)} aria-label={`旧状态“${value}”对到`} onChange={event => setStatusMap({ ...statusMap, [value]: event.target.value })}>
                  <option value="">还没对上</option>
                  {type.statuses.map(status => <option key={status.key} value={status.key}>{status.name === CATEGORY_LABELS[status.category] ? status.name : `${status.name}（${CATEGORY_LABELS[status.category]}）`}</option>)}
                </select></td></tr>
            ))}</tbody></table></div>
          </Field>}
          <Field group label="负责人" hint="按名字或登录名自动对；对不上的选一个人，或者这几行先不导入。">
            <div className="table-wrap"><table><tbody>{peopleValues.map(value => (
              <tr key={value}><td>{value}</td><td>
                <select value={personFor(value)} aria-label={`“${value}”是谁`} onChange={event => setPeopleMap({ ...peopleMap, [value]: event.target.value === SKIP ? SKIP : event.target.value ? Number(event.target.value) : '' })}>
                  <option value="">还没对上</option>
                  <option value={SKIP}>这一行不导入</option>
                  {activeUsers.map(user => <option key={user.id} value={user.id}>{user.displayName}（{user.username}）</option>)}
                </select></td></tr>
            ))}</tbody></table></div>
          </Field>
          {projectValues.length > 0 && <Field group label="项目" hint="对不上的就不属于任何项目；要用新项目，先到“项目”里建好。">
            <div className="table-wrap"><table><tbody>{projectValues.map(value => (
              <tr key={value}><td>{value}</td><td>
                <select value={projectFor(value)} aria-label={`项目“${value}”对到`} onChange={event => setProjectMap({ ...projectMap, [value]: event.target.value ? Number(event.target.value) : '' })}>
                  <option value="">不属于任何项目</option>
                  {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select></td></tr>
            ))}</tbody></table></div>
          </Field>}
        </section>
      )}

      {ready && (
        <section className="card section form">
          <h2>4. 检查并导入</h2>
          <label className="check"><input type="checkbox" checked={skipInvalid} onChange={event => setSkipInvalid(event.target.checked)} /><span>跳过有问题的行，只导入没问题的</span></label>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => submit(true)}>先检查</button>
            <button type="button" className="primary" disabled={busy} onClick={() => submit(false)}>{busy ? '正在处理…' : '导入'}</button>
          </div>
          {check && (
            <div className="grid" style={{ gap: 6 }}>
              <p>{check.dryRun ? `检查完了：${check.valid} 行能导入` : `导入了 ${check.created} 个事项`}{check.problems.length ? `，${check.problems.length} 行有问题` : '，没有问题'}{check.skipped.length ? `，${check.skipped.length} 行按你的选择不导入` : ''}。</p>
              {check.problems.length > 0 && <ul className="timeline">{check.problems.slice(0, 100).map((problem, index) => <li key={`${problem.line}-${index}`}><span className="muted">第 {problem.line} 行</span><span style={{ gridColumn: 'span 2' }}>{problem.message}</span></li>)}</ul>}
            </div>
          )}
        </section>
      )}
    </>
  );
}
