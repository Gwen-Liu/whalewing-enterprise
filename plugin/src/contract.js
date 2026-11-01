// Host 和浏览器之间的调用约定：浏览器的「团队」页签只通过这一个 manage 方法让 Host 做事。
// 写法照鲸翼扩展的保存状态模板（DSH 的 typert 远程调用）。
import { z } from 'zod';
import { packageName } from '../identity.js';

export const namespace = 'whalewingEnterprise';

const text = (max) => z.string().max(max);
const kind = z.enum(['knowledge', 'expert', 'skill']);
const slug = z.string().min(1).max(64);
const relPath = z.string().min(1).max(240);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const input = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status') }),
  z.strictObject({ action: z.literal('probe'), address: text(500) }),
  z.strictObject({ action: z.literal('join'), address: text(500), username: text(64), displayName: text(40), password: text(128) }),
  z.strictObject({ action: z.literal('login'), address: text(500), username: text(64), password: text(128) }),
  z.strictObject({ action: z.literal('sync') }),
  z.strictObject({ action: z.literal('leave') }),
  z.strictObject({ action: z.literal('read'), kind, slug, path: relPath }),
  z.strictObject({ action: z.literal('write'), kind, slug, path: relPath, content: z.string().max(1_000_000), baseHash: hash.nullable() }),
  z.strictObject({ action: z.literal('remove'), kind, slug, path: relPath, baseHash: hash }),
  z.strictObject({ action: z.literal('personalSearch'), query: text(200) }),
  z.strictObject({ action: z.literal('submitPersonal'), notePath: text(400), slug, path: relPath }),
]);

// 返回的内容按动作不同，结构由 Host 保证；这里只要求是能 JSON 往返的对象。
export const output = z.record(z.string(), z.unknown());

const descriptor = {
  id: `${packageName}#${namespace}/manage`, service: namespace, namespace, method: 'manage', invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${packageName}#Input`, create: () => input } }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: `${packageName}#Output`, create: () => output },
};

export const contract = {
  host: { package: packageName, face: 'host', schemas: [], invocations: [descriptor], model: { package: packageName, face: 'host' } },
  client: { package: packageName, descriptors: [descriptor] },
};
