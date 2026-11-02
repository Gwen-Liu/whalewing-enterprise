import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context.js';
import { Empty, formatTime, PageHeader, useToast } from '../ui.jsx';

const FILTERS = [
  { value: '', label: '全部' },
  { value: 'user', label: '成员' },
  { value: 'role', label: '角色' },
  { value: 'work.', label: '事项' },
  { value: 'project', label: '项目' },
  { value: 'worktype', label: '事项类型' },
  { value: 'department', label: '部门' },
  { value: 'invite', label: '邀请' },
  { value: 'item', label: '团队内容设置' },
  { value: 'file', label: '团队内容文件' },
  { value: 'skill', label: '技能压缩包' },
  { value: 'settings', label: '企业设置' },
];

export function AuditPage() {
  const { call } = useApp();
  const notify = useToast();
  const [action, setAction] = useState('');
  const [entries, setEntries] = useState([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async before => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50', ...(action ? { action } : {}), ...(before ? { before: String(before) } : {}) });
      const data = await call('GET', `/admin/audit?${params}`);
      setEntries(list => before ? [...list, ...data.entries] : data.entries);
      setMore(data.entries.length === 50);
    } catch (error) { notify(error.message, { kind: 'error' }); } finally { setLoading(false); }
  }, [action, call, notify]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="操作记录" summary="谁在什么时候改了成员、角色、权限、团队内容，以及事项的截止日期、优先级、负责人和删除（写明是本人操作还是经模型）。只记管理动作，不记员工的会话和个人内容。" />
      <div className="row filters" role="group" aria-label="按类型筛选">
        {FILTERS.map(filter => <button key={filter.value} type="button" className={`pill${action === filter.value ? ' active' : ''}`} onClick={() => setAction(filter.value)}>{filter.label}</button>)}
      </div>
      <section className="list card">
        {entries.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>时间</th><th>谁</th><th>做了什么</th><th>对象</th></tr></thead>
            <tbody>{entries.map(entry => (
              <tr key={entry.id}>
                <td className="muted nowrap">{formatTime(entry.at)}</td>
                <td>{entry.actorName ?? '系统'}</td>
                <td>{entry.label}</td>
                <td className="mono small">{entry.target}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : !loading && <Empty>没有符合的记录。</Empty>}
        {more && <div className="row center-row"><button type="button" disabled={loading} onClick={() => load(entries.at(-1)?.id)}>{loading ? '正在读取…' : '再看 50 条'}</button></div>}
      </section>
    </>
  );
}
