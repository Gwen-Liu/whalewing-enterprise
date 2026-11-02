// 管理端的通用组件，交互和鲸翼个人版一致：确认用居中弹窗、结果用右上角提示、编辑用右侧抽屉、添加用加号卡片。
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import logo from './logo-mono.svg?raw';

export function Logo({ size = 22 }) {
  return <span className="logo" style={{ width: size, height: size }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }} />;
}

// ---------- 右上角提示 ----------

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const remove = useCallback(id => setItems(list => list.filter(item => item.id !== id)), []);
  const notify = useCallback((text, { kind = 'success', action } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setItems(list => [...list.slice(-3), { id, text, kind, action }]);
    return id;
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(item => <Toast key={item.id} item={item} onClose={() => remove(item.id)} />)}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onClose }) {
  const [paused, setPaused] = useState(false);
  // 成功 4 秒收起；失败带恢复动作的一直留着，没有恢复动作的 8 秒收起。鼠标停在上面时暂停。
  const ms = item.kind === 'success' ? 4000 : item.action ? null : 8000;
  useEffect(() => {
    if (!ms || paused) return undefined;
    const timer = setTimeout(onClose, ms);
    return () => clearTimeout(timer);
  }, [ms, paused, onClose]);
  return (
    <div className={`toast toast-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="toast-text">{item.text}</span>
      {item.action && <button type="button" className="link" onClick={() => { onClose(); item.action.run(); }}>{item.action.label}</button>}
      <button type="button" className="icon" aria-label="关闭提示" onClick={onClose}>×</button>
    </div>
  );
}

// ---------- 弹层 ----------

function useEscape(onClose, busy) {
  useEffect(() => {
    const handler = event => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);
}

export function Modal({ title, onClose, children, footer, busy, small }) {
  useEscape(onClose, busy);
  const titleId = useId();
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={`modal${small ? ' modal-small' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h2 id={titleId}>{title}</h2><button type="button" className="icon" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel = '取消', danger, busy, onConfirm, onCancel }) {
  return (
    <Modal small title={title} onClose={onCancel} busy={busy} footer={<>
      <button type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
      <button type="button" className={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>{busy ? '正在处理…' : confirmLabel}</button>
    </>}>
      <p className="confirm-text">{message}</p>
    </Modal>
  );
}

/** 右侧抽屉。dirty 为 true 时，点“取消”、按 Esc、点遮罩或 × 关闭前都先确认放弃修改。 */
export function Drawer({ title, onClose, children, footer, busy, dirty, cancelLabel = '取消' }) {
  const [asking, setAsking] = useState(false);
  const close = useCallback(() => { if (busy) return; if (dirty) setAsking(true); else onClose(); }, [busy, dirty, onClose]);
  useEscape(close, busy || asking);
  const titleId = useId();
  return (
    <div className="overlay overlay-drawer" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h2 id={titleId}>{title}</h2><button type="button" className="icon" aria-label="关闭" disabled={busy} onClick={close}>×</button></header>
        <div className="drawer-body">{children}</div>
        {/* “取消”由抽屉自己放，和 Esc、点遮罩、点 × 走同一条路：有改动时先问要不要放弃。 */}
        <footer><button type="button" disabled={busy} onClick={close}>{cancelLabel}</button>{footer}</footer>
      </aside>
      {asking && <ConfirmDialog title="放弃修改" message="填写的内容还没保存，关掉就没有了。" confirmLabel="放弃修改" cancelLabel="继续编辑" danger
        onConfirm={() => { setAsking(false); onClose(); }} onCancel={() => setAsking(false)} />}
    </div>
  );
}

// ---------- 菜单和卡片 ----------

export function ActionMenu({ label = '更多操作', items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const handler = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const key = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', key); };
  }, [open]);
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return (
    <div className="menu" ref={ref} onClick={event => event.stopPropagation()}>
      <button type="button" className="icon menu-trigger" aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>…</button>
      {open && (
        <div className="menu-list" role="menu">
          {visible.map(item => (
            <button key={item.label} type="button" role="menuitem" className={item.danger ? 'menu-danger' : ''} disabled={item.disabled}
              onClick={() => { setOpen(false); item.run(); }}>{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AddCard({ label, onClick }) {
  return <button type="button" className="card add-card" onClick={onClick}><span className="add-mark" aria-hidden="true">＋</span>{label}</button>;
}

export function PageHeader({ title, summary, actions }) {
  return (
    <div className="page-header">
      <div><h1>{title}</h1>{summary && <p className="muted">{summary}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/**
 * 表单字段。里面只有一个输入框时用 <label>，点字段名就能聚焦；
 * 里面是一组控件（单选、按钮、下拉）时传 group，用分组容器，免得点说明文字误触第一个单选框。
 */
export function Field({ label, hint, children, group }) {
  if (group) {
    return <div className="field" role="group" aria-label={label}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</div>;
  }
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export function Empty({ children }) { return <p className="empty muted">{children}</p>; }

/** 选几个人：能搜，勾选。部门负责人、项目成员都用它。 */
export function PeoplePicker({ label, hint, users, value, onChange, departmentName = () => null }) {
  const [query, setQuery] = useState('');
  const chosen = new Set(value);
  const text = query.trim().toLowerCase();
  const shown = users.filter(user => !text || `${user.displayName} ${user.username} ${departmentName(user.departmentId) ?? ''}`.toLowerCase().includes(text));
  return (
    <Field group label={label} hint={hint}>
      <input type="search" placeholder="找名字、登录名或部门" value={query} onChange={event => setQuery(event.target.value)} aria-label={`${label}：找人`} />
      <div className="people-picker">
        {shown.map(user => (
          <label key={user.id} className="check">
            <input type="checkbox" checked={chosen.has(user.id)} onChange={() => onChange(chosen.has(user.id) ? value.filter(id => id !== user.id) : [...value, user.id])} />
            <span>{user.displayName}</span><span className="muted small">{user.username}{departmentName(user.departmentId) ? ` · ${departmentName(user.departmentId)}` : ''}</span>
          </label>
        ))}
        {!shown.length && <span className="muted small">没有符合的人。</span>}
      </div>
      {value.length > 0 && <span className="field-hint">已选 {value.length} 人：{value.map(id => users.find(user => user.id === id)?.displayName ?? id).join('、')}</span>}
    </Field>
  );
}

/** 下载一段文字成文件（导出的表格用）。 */
export function downloadText(text, name, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const formatTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  // 未来的时间（比如邀请的截止时间）直接写日期，不说“几分钟前”。
  if (diff < 0) return date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const formatBytes = value => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
