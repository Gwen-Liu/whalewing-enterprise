// 完整回归：共用部分、服务端、员工端组合包一起跑，任何一项失败整体失败。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = [['shared', 'shared/test'], ['server', 'server/test'], ['plugin', 'plugin/tests']];
let failed = false;
for (const [name, dir] of suites) {
  const full = path.join(root, dir);
  const files = existsSync(full) ? readdirSync(full).filter(file => file.endsWith('.test.mjs')).map(file => path.join(dir, file)) : [];
  if (!files.length) { console.log(`— ${name}：没有测试`); continue; }
  console.log(`— ${name}：${files.length} 个测试文件`);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
