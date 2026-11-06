// 服务端直接生成的两张小页面：邀请链接在浏览器里打开时的说明页，以及管理端还没构建时的提示页。
// 不带脚本，只用内联样式；颜色跟随系统的浅色和深色。
import { DSH_VERSION, PERSONAL_MIN_VERSION } from '@whalewing-enterprise/shared';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f8fa; --card: #ffffff; --text: #1f2328; --muted: #59636e; --line: #d1d9e0; --brand: #1677c8; --code: #eef2f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1419; --card: #161b22; --text: #e6edf3; --muted: #9198a1; --line: #30363d; --brand: #58a6ff; --code: #1f2630; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
  font: 14px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 24px 16px; }
main { width: min(560px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font: 600 22px/1.4 "Songti SC", "SimSun", serif; margin: 0 0 4px; }
.muted { color: var(--muted); margin: 0 0 20px; }
ol { padding-left: 20px; margin: 0; }
li { margin: 10px 0; }
code { background: var(--code); border-radius: 6px; padding: 2px 6px; font: 13px/1.6 ui-monospace, Consolas, monospace; word-break: break-all; }
.link { display: block; margin-top: 6px; padding: 8px 10px; user-select: all; }
.brand { color: var(--brand); font-weight: 600; }
.problem { border-left: 3px solid #d1242f; padding-left: 12px; }
`;

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function joinPage({ info, problem, version, link }) {
  if (!info) {
    return page('邀请链接用不了 · 鲸翼企业版', `<h1>邀请链接用不了</h1><p class="muted problem">${escape(problem)}</p>
<p>请找发邀请的管理员重新发一条。</p>`);
  }
  // 成员的邀请写加入后挂的角色名（比如“负责人”），没有角色名时写“成员”。
  const role = info.role === 'admin' ? '管理员' : info.roleName ?? '成员';
  return page(`加入${info.orgName} · 鲸翼企业版`, `<h1>加入 ${escape(info.orgName)}</h1>
<p class="muted">你收到的是 <span class="brand">鲸翼企业版</span> 的邀请${info.department ? `，加入后在「${escape(info.department)}」` : ''}，身份是${role}。邀请 ${escape(info.expiresAt.slice(0, 10))} 前有效。</p>
<ol>
<li>在电脑上打开 DeepSeek Harness（DSH，这一版要 <code>${DSH_VERSION}</code>），先装好鲸翼个人版 <code>dsh-whalewing@${PERSONAL_MIN_VERSION}</code> 或更新的 <code>${DSH_VERSION}.x</code> 版本。</li>
<li>在 DSH「插件 → 添加插件」里填 <code>dsh-whalewing-enterprise@${escape(version)}</code>，装好后点“立即启用”。</li>
<li>打开鲸翼，进「团队」页签，粘贴这条邀请链接：<code class="link">${escape(link)}</code></li>
<li>确认是要加入的企业，再设置你的登录名和密码。</li>
</ol>`);
}

export function missingAdminPage() {
  return page('管理端网页还没构建 · 鲸翼企业版', `<h1>管理端网页还没构建</h1>
<p class="muted">服务端已经在运行，但没找到管理端网页的文件。</p>
<p>从源码运行时，在仓库根目录运行 <code>npm run build</code> 后重启服务端。用 npm 包或 Docker 装的不会出现这一页；出现了请重新安装。</p>`);
}
