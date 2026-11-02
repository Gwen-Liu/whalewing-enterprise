import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, AUTH_CODES } from './api.js';
import { AppContext } from './context.js';
import { Logo, ToastHost, useToast } from './ui.jsx';
import { SetupPage, LoginPage } from './pages/Auth.jsx';
import { OverviewPage } from './pages/Overview.jsx';
import { MembersPage } from './pages/Members.jsx';
import { RolesPage } from './pages/Roles.jsx';
import { WorkTypesPage } from './pages/WorkTypes.jsx';
import { BoardPage, ProjectsPage, TrashPage } from './pages/Work.jsx';
import { ImportPage } from './pages/Import.jsx';
import { ContentPage, ItemPage } from './pages/Content.jsx';
import { SettingsPage } from './pages/Settings.jsx';
import { AuditPage } from './pages/Audit.jsx';
import './styles.css';

// ---------- 路由：/admin/ 下面的几页，用浏览器历史记录切换 ----------

const NAV = [
  { path: '', label: '概览' },
  { group: '组织' },
  { path: 'members', label: '组织与人员' },
  { path: 'roles', label: '角色与权限' },
  { group: '工作' },
  { path: 'board', label: '全局看板' },
  { path: 'projects', label: '项目' },
  { path: 'work-types', label: '事项类型' },
  { path: 'trash', label: '回收站' },
  { path: 'import', label: '导入事项' },
  { group: '团队内容' },
  { path: 'knowledge', label: '团队知识' },
  { path: 'experts', label: '团队专家' },
  { path: 'skills', label: '团队技能' },
  { group: '系统' },
  { path: 'settings', label: '设置' },
  { path: 'audit', label: '操作记录' },
];

const currentPath = () => window.location.pathname.replace(/^\/admin\/?/, '').replace(/\/+$/, '');

function useRoute() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback(next => {
    window.history.pushState(null, '', '/admin/' + next);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);
  return [path, go];
}

function App() {
  const notify = useToast();
  const [state, setState] = useState({ phase: 'loading' });
  const [path, go] = useRoute();
  const [directory, setDirectory] = useState({ departments: [], users: [], roles: [] });

  const load = useCallback(async () => {
    try {
      const hello = await api('GET', '/hello');
      if (hello.setupRequired) return setState({ phase: 'setup', hello });
      try {
        const me = await api('GET', '/me');
        if (me.user.role === 'member') return setState({ phase: 'login', hello, problem: '这个账号不是管理员' });
        setState({ phase: 'ready', hello, me });
      } catch (error) {
        if (AUTH_CODES.has(error.code) || error.code === 'FORBIDDEN') return setState({ phase: 'login', hello });
        throw error;
      }
    } catch (error) {
      setState({ phase: 'error', message: error.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // 部门、成员和角色名单在好几页都要用（选可见范围、选部门、选角色），放在一处读。
  const refreshDirectory = useCallback(async () => {
    const [departments, users, roles] = await Promise.all([api('GET', '/admin/departments'), api('GET', '/admin/users'), api('GET', '/admin/roles')]);
    setDirectory({ departments: departments.departments, users: users.users, roles: roles.roles });
  }, []);
  useEffect(() => {
    if (state.phase === 'ready') refreshDirectory().catch(error => notify(error.message, { kind: 'error' }));
  }, [state.phase, refreshDirectory, notify]);

  // 任何接口报登录过期，就回到登录页。
  const call = useCallback(async (...args) => {
    try { return await api(...args); }
    catch (error) {
      if (AUTH_CODES.has(error.code)) { setState(current => ({ phase: 'login', hello: current.hello, problem: error.message })); }
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    try { await api('POST', '/auth/logout'); } finally { setState(current => ({ phase: 'login', hello: current.hello })); }
  }, []);

  const context = useMemo(() => ({ ...state, call, go, directory, refreshDirectory, reload: load }), [state, call, go, directory, refreshDirectory, load]);

  if (state.phase === 'loading') return <div className="center muted">正在连接服务端…</div>;
  if (state.phase === 'error') return <div className="center"><div className="card narrow"><h1>连不上服务端</h1><p className="muted">{state.message}</p><button type="button" className="primary" onClick={load}>重试</button></div></div>;
  if (state.phase === 'setup') return <SetupPage onDone={load} />;
  if (state.phase === 'login') return <LoginPage orgName={state.hello?.orgName} problem={state.problem} onDone={load} />;

  const [section, ...rest] = path.split('/');
  let page;
  if (section === 'members') page = <MembersPage />;
  else if (section === 'roles') page = <RolesPage />;
  else if (section === 'board') page = <BoardPage />;
  else if (section === 'projects') page = <ProjectsPage />;
  else if (section === 'work-types') page = <WorkTypesPage />;
  else if (section === 'trash') page = <TrashPage />;
  else if (section === 'import') page = <ImportPage />;
  else if (section === 'knowledge') page = <ContentPage kind="knowledge" />;
  else if (section === 'experts') page = <ContentPage kind="expert" />;
  else if (section === 'skills') page = <ContentPage kind="skill" />;
  else if (section === 'items' && rest.length === 2) page = <ItemPage kind={rest[0]} slug={rest[1]} />;
  else if (section === 'settings') page = <SettingsPage />;
  else if (section === 'audit') page = <AuditPage />;
  else page = <OverviewPage />;
  const active = section === 'items' ? { knowledge: 'knowledge', expert: 'experts', skill: 'skills' }[rest[0]] : section;

  return (
    <AppContext.Provider value={context}>
      <div className="shell">
        <nav className="sidebar" aria-label="管理端导航">
          <div className="brand">
            <Logo size={26} />
            <div><strong>鲸翼企业版</strong><span className="muted">{state.hello.orgName}</span></div>
          </div>
          <div className="nav-list">
            {NAV.map(item => item.group ? <span key={item.group} className="nav-group">{item.group}</span> : (
              <a key={item.path} href={'/admin/' + item.path} className={active === item.path ? 'active' : ''} aria-current={active === item.path ? 'page' : undefined}
                onClick={event => { event.preventDefault(); go(item.path); }}>{item.label}</a>
            ))}
          </div>
          <div className="sidebar-foot">
            <span className="muted">{state.me.user.displayName}</span>
            <button type="button" className="link" onClick={logout}>退出登录</button>
          </div>
        </nav>
        <main className="main">{page}</main>
      </div>
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><ToastHost><App /></ToastHost></StrictMode>);
