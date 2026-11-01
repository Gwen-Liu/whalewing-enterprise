import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
// scrypt 是 Node 自带的，不用装原生依赖。参数和 OWASP 推荐的最低档一致。
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const want = Buffer.from(expected, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return key.length === want.length && timingSafeEqual(key, want);
}

// 账号不存在时也算一次哈希，免得从响应快慢猜出哪些登录名存在。
let dummy;
export async function burnPasswordCheck(password) {
  dummy ??= await hashPassword('whalewing-enterprise-dummy');
  await verifyPassword(password, dummy);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 初始化码：8 位数字分两段，方便从日志里抄。 */
export function setupCode() {
  const digits = Array.from(randomBytes(8), byte => String(byte % 10)).join('');
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}
