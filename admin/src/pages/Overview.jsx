import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context.js';
import { formatTime, PageHeader, useToast } from '../ui.jsx';

export function OverviewPage() {
  const { call, go } = useApp();
  const notify = useToast();
  const [data, setData] = useState(null);
  const load = useCallback(() => call('GET', '/admin/overview').then(setData).catch(error => notify(error.message, { kind: 'error', action: { label: '重试', run: load } })), [call, notify]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <PageHeader title="概览" summary="正在读取…" />;
  const { members, content, settings, recent } = data;
  const stats = [
    { label: '成员', value: members.active, note: members.total > members.active ? `另有 ${members.total - members.active} 人已停用` : '全部在用', to: 'members' },
    { label: '最近 7 天连过', value: members.recentlySeen, note: '员工端或管理端用过的人', to: 'members' },
    { label: '知识空间', value: content.knowledge, note: '团队知识', to: 'knowledge' },
    { label: '团队专家', value: content.expert, note: '出现在员工的专家团队里', to: 'experts' },
    { label: '团队技能', value: content.skill, note: '专家和小鲸都能调用', to: 'skills' },
    { label: '部门', value: data.departments, note: '可以一层层往下建', to: 'members' },
  ];
  return (
    <>
      <PageHeader title="概览" summary={`${settings.orgName} · 服务端 ${data.serverVersion}`} />
      {!settings.publicUrl && (
        <div className="notice">还没填<strong>对外地址</strong>：邀请链接会用你现在打开管理端的地址。员工从别的网络连接时，请到
          <button type="button" className="link" onClick={() => go('settings')}>设置</button>里填上员工能访问的地址（外网要 https）。</div>
      )}
      <div className="grid stats">
        {stats.map(stat => (
          <button key={stat.label} type="button" className="card stat" onClick={() => go(stat.to)}>
            <span className="muted">{stat.label}</span><strong>{stat.value}</strong><span className="muted small">{stat.note}</span>
          </button>
        ))}
      </div>
      <section className="section">
        <div className="section-head"><h2>最近的管理操作</h2><button type="button" className="link" onClick={() => go('audit')}>全部操作记录</button></div>
        {recent.length ? (
          <ul className="timeline">
            {recent.map(entry => <li key={entry.id}><span className="muted">{formatTime(entry.at)}</span><span>{entry.actorName ?? '系统'} · {entry.label}</span><span className="muted">{entry.target}</span></li>)}
          </ul>
        ) : <p className="muted">还没有操作。</p>}
      </section>
    </>
  );
}
