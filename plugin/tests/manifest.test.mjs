// 版本声明：员工端声明的 DSH 版本、DSH 自带包的版本、共用常量和三个部分的版本号要对得上。
// DSH 只加载 engines.dsh 和自己版本完全一致的插件，这里对不上，员工装上也不会加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DSH_VERSION, PERSONAL_MIN_VERSION } from '@whalewing-enterprise/shared';

const read = rel => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

test('员工端的 engines.dsh、DSH 包版本和共用常量一致，版本号以适配的 DSH 版本开头', () => {
  const manifest = read('plugin/package.json');
  assert.equal(manifest.engines.dsh, DSH_VERSION);
  assert.ok(manifest.version.startsWith(`${DSH_VERSION}.`), `版本号 ${manifest.version} 要以 ${DSH_VERSION}. 开头`);
  assert.ok(PERSONAL_MIN_VERSION.startsWith(`${DSH_VERSION}.`), `要的个人版 ${PERSONAL_MIN_VERSION} 要是适配 ${DSH_VERSION} 的版本`);
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
  assert.ok(peers.length > 0);
  for (const [name, range] of peers) assert.equal(range, DSH_VERSION, name);
  assert.equal(manifest.peerDependencies['dsh-whalewing'], undefined, '个人版扩展接口的版本范围等它首个封版再定，不预填');
});

test('共用部分、服务端、管理端和员工端用同一个版本号', () => {
  const version = read('plugin/package.json').version;
  for (const rel of ['shared/package.json', 'server/package.json', 'admin/package.json']) assert.equal(read(rel).version, version, rel);
});
