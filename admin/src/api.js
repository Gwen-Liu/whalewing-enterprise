// 管理端调服务端接口。登录状态在 HttpOnly Cookie 里；会改东西的请求带自定义请求头，服务端靠它防跨站提交。
export class RequestError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

const BASE = '/api/v1';

export async function api(method, path, body, { signal } = {}) {
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      signal,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-whalewing-admin': '1' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new RequestError('NETWORK', '连不上服务端：请确认服务端还在运行、网络正常，然后重试', 0);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
  if (!response.ok) {
    const error = data?.error;
    throw new RequestError(error?.code ?? 'INTERNAL', error?.message ?? `服务端返回了 ${response.status}`, response.status);
  }
  return data;
}

/** 读一个团队内容文件的原文和 hash（改的时候要带上 hash，防止覆盖别人的修改）。 */
export async function readItemFile(kind, slug, path) {
  const response = await fetch(`${BASE}/items/${kind}/${slug}/files/${path.split('/').map(encodeURIComponent).join('/')}`, { credentials: 'same-origin' });
  if (!response.ok) {
    let message = `读取失败（${response.status}）`;
    try { message = (await response.json()).error.message; } catch { /* 保留默认说明 */ }
    throw new RequestError('READ', message, response.status);
  }
  return { text: await response.text(), hash: response.headers.get('x-content-hash') };
}

export const filePath = (kind, slug, path) => `/items/${kind}/${slug}/files/${path.split('/').map(encodeURIComponent).join('/')}`;

export const AUTH_CODES = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'ACCOUNT_DISABLED']);
