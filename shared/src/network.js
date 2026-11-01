// 加密规则（企业版方案已定）：外网地址只能 HTTPS；内网地址允许 HTTP，但要提示没有加密。
// 这里只判断地址本身；填的是域名时，员工端先解析出 IP 再用 isPrivateAddress 判断。

function ipv4Parts(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
  return numbers.every(n => n >= 0 && n <= 255) ? numbers : null;
}

export function isPrivateAddress(raw) {
  const ip = String(raw).replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = ipv4Parts(mapped ? mapped[1] : ip);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!ip.includes(':')) return false;
  // 本机 ::1，以及 IPv6 的内网段 fc00::/7（相当于 IPv4 的 10.x、192.168）。
  return ip === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(ip);
}

export const isIpLiteral = host => Boolean(ipv4Parts(host)) || host.replace(/^\[|\]$/g, '').includes(':');

/** 把员工填的服务器地址整理成 origin；不合规就返回原因，原因直接给人看。 */
export function parseServerAddress(input) {
  let text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: '请填写服务器地址' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { return { ok: false, reason: '服务器地址格式不对，例如 https://team.example.com' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: '服务器地址只能用 https:// 或 http:// 开头' };
  if (url.username || url.password) return { ok: false, reason: '服务器地址里不能带账号和密码' };
  if (url.search || url.hash) return { ok: false, reason: '服务器地址里不能带 ? 或 # 后面的内容' };
  const base = url.pathname.replace(/\/+$/, '');
  return { ok: true, origin: url.origin + base, protocol: url.protocol.slice(0, -1), hostname: url.hostname.replace(/^\[|\]$/g, '') };
}

/** 邀请链接形如 https://team.example.com/join/<邀请码>。 */
export function parseInviteLink(input) {
  const text = String(input ?? '').trim();
  const match = text.match(/^(https?:\/\/[^\s]+?)\/join\/([A-Za-z0-9_-]{16,100})\/?$/);
  if (!match) return { ok: false, reason: '这不是有效的邀请链接，链接应形如 https://服务器地址/join/邀请码' };
  const server = parseServerAddress(match[1]);
  return server.ok ? { ok: true, server, code: match[2] } : server;
}
