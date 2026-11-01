// 构建：管理端网页（输出到 server/admin-dist）和员工端组合包。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (label, args, cwd) => {
  console.log(`— ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, cwd), stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run('管理端网页', [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], 'admin');
run('员工端组合包', ['scripts/build.mjs'], 'plugin');
