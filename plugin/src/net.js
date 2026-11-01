// 连企业服务端：先按加密规则检查地址，再发请求；连不上时把原因翻译成大白话。
import { lookup as dnsLookup } from 'node:dns/promises';
import { API_PREFIX, isIpLiteral, isPrivateAddress, parseServerAddress } from '@whalewing-enterprise/shared';

export class EnterpriseError extends Error {
  constructor(code, message, status) { super(message); this.name = 'EnterpriseError'; this.code = code; if (status) this.status = status; }
}
const fail = (code, message, status) => new EnterpriseError(code, message, status);

/**
 * 加密规则（企业版方案已定）：外网地址只能 HTTPS，证书不对不提供“忽略继续”；
 * 地址在内网网段（填域名时看解析出来的地址）才允许 HTTP，并提示没有加密。
 */
export async function inspectAddress(raw, { lookup = dnsLookup } = {}) {
  const parsed = parseServerAddress(raw);
  if (!parsed.ok) throw fail('ADDRESS', parsed.reason);
  let addresses;
  if (isIpLiteral(parsed.hostname)) addresses = [parsed.hostname];
  else if (parsed.hostname === 'localhost') addresses = ['127.0.0.1'];
  else {
    try { addresses = (await lookup(parsed.hostname, { all: true })).map(entry => entry.address); }
    catch { throw fail('NETWORK', `找不到“${parsed.hostname}”这个地址：检查地址有没有拼错，或者电脑能不能上网、能不能连公司内网`); }
  }
  const isPrivate = addresses.length > 0 && addresses.every(isPrivateAddress);
  if (parsed.protocol === 'http' && !isPrivate) {
    throw fail('INSECURE', '这是外网地址，只能用 https:// 连接，免得登录信息和团队内容在网上被看到。请让管理员给服务端配上 HTTPS，或换成 https:// 开头的地址');
  }
  return { origin: parsed.origin, encrypted: parsed.protocol === 'https', private: isPrivate, hostname: parsed.hostname };
}

const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED']);

function proxyHint(hostname) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return '';
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(item => item.trim()).filter(Boolean);
  return noProxy.some(item => item === '*' || hostname.endsWith(item.replace(/^\*?\.?/, ''))) ? '' : `。这台电脑设了代理，连公司内网的服务端时要把“${hostname}”加进 NO_PROXY`;
}

export function explainNetworkError(error, { hostname, isPrivate }) {
  if (error instanceof EnterpriseError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return fail('TIMEOUT', `服务端很久没有回应：检查网络，或请管理员看看服务端还在不在运行${isPrivate ? proxyHint(hostname) : ''}`);
  }
  const code = error?.cause?.code ?? error?.code;
  if (TLS_CODES.has(code)) {
    return fail('CERTIFICATE', `服务端的 HTTPS 证书不被信任（${code}）。为了不连到冒充的服务器，这里不提供“忽略证书继续连”；请管理员换成正规机构签发的证书，或在内网改用 http://内网地址`);
  }
  if (code === 'ECONNREFUSED') return fail('NETWORK', `连得到“${hostname}”这台电脑，但服务端没在运行，或者端口不对`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return fail('NETWORK', `找不到“${hostname}”这个地址：检查地址有没有拼错，或者电脑能不能上网`);
  return fail('NETWORK', `连不上服务端（${code ?? error?.message ?? '未知原因'}）：检查网络${isPrivate ? proxyHint(hostname) : '，或请管理员看看服务端还在不在运行'}`);
}

/** 发一个请求，返回 { status, json, text, headers, buffer }；失败统一抛 EnterpriseError。 */
export async function request(target, method, path, { token, body, etag, signal, raw = false, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let response;
  try {
    response = await fetchImpl(target.origin + API_PREFIX + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.any(signals),
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw explainNetworkError(error, { hostname: target.hostname, isPrivate: target.private });
  }
  if (response.status === 304) return { status: 304, headers: response.headers };
  if (raw && response.ok) return { status: response.status, headers: response.headers, buffer: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
  if (!response.ok) {
    const error = json?.error;
    if (error?.code) throw fail(error.code, error.message, response.status);
    throw fail('SERVER', `服务端返回了 ${response.status}，可能连到的不是鲸翼企业版服务端，请核对地址`, response.status);
  }
  return { status: response.status, json, headers: response.headers };
}
