// 打发布包：
//   员工端 dsh-whalewing-enterprise-<版本>.tgz —— 在 plugin/ 构建后 npm pack
//   服务端 whalewing-enterprise-server-<版本>.tgz —— 复制到暂存目录，把共用部分（shared）放进 vendor/ 并改成相对引用，再 npm pack
// 产物放在 .artifacts/release/<版本>/。只打包，不发布。
//   node scripts/pack.mjs            两个都打
//   node scripts/pack.mjs --stage    只准备服务端暂存目录（Docker 构建用）
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageOnly = process.argv.includes('--stage');
const version = JSON.parse(readFileSync(path.join(root, 'server/package.json'), 'utf8')).version;
for (const part of ['plugin', 'shared', 'admin']) {
  const other = JSON.parse(readFileSync(path.join(root, part, 'package.json'), 'utf8')).version;
  if (other !== version) throw new Error(`${part}/package.json 的版本 ${other} 和服务端 ${version} 不一样，三个部分要用同一个版本号`);
}
const outDir = path.join(root, '.artifacts', 'release', version);
const stage = path.join(root, '.artifacts', 'pack', 'server');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败`);
}

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function stageServer() {
  if (!existsSync(path.join(root, 'server/admin-dist/index.html'))) throw new Error('还没构建管理端网页，先运行 npm run build');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const item of ['bin', 'src', 'admin-dist', 'package.json']) cpSync(path.join(root, 'server', item), path.join(stage, item), { recursive: true });
  cpSync(path.join(root, 'shared/src'), path.join(stage, 'vendor/shared'), { recursive: true });
  cpSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  cpSync(path.join(root, 'server/README.md'), path.join(stage, 'README.md'));
  // 服务端源码里引用共用部分的地方改成相对路径。
  for (const file of walk(path.join(stage, 'src')).filter(name => name.endsWith('.js'))) {
    const relative = path.relative(path.dirname(file), path.join(stage, 'vendor/shared')).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8')
      .replace(/(['"])@whalewing-enterprise\/shared\/(\w+)\1/g, (_, quote, sub) => `${quote}${relative}/${sub}.js${quote}`)
      .replace(/(['"])@whalewing-enterprise\/shared\1/g, (_, quote) => `${quote}${relative}/index.js${quote}`);
    writeFileSync(file, text);
  }
  const leftovers = walk(stage).filter(file => file.endsWith('.js') && readFileSync(file, 'utf8').includes('@whalewing-enterprise/'));
  if (leftovers.length) throw new Error(`还有没改掉的工作区引用：${leftovers.join(', ')}`);
  const manifest = JSON.parse(readFileSync(path.join(stage, 'package.json'), 'utf8'));
  manifest.files = ['bin', 'src', 'vendor', 'admin-dist', 'README.md', 'LICENSE'];
  delete manifest.scripts;
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// 直接用当前 Node 跑 npm，不经过命令行外壳（Windows 上 npm.cmd 要外壳，参数不转义）。
function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const found = candidates.find(file => file.endsWith('npm-cli.js') && existsSync(file));
  if (!found) throw new Error('找不到 npm，请确认装的是带 npm 的 Node.js');
  return found;
}

function pack(cwd) {
  const output = execFileSync(process.execPath, [npmCli(), 'pack', '--json', '--pack-destination', outDir], { cwd, encoding: 'utf8' });
  const [info] = JSON.parse(output.slice(output.indexOf('[')));
  return { file: path.join(outDir, info.filename), size: info.size, files: info.entryCount, shasum: info.shasum, integrity: info.integrity };
}

stageServer();
if (!stageOnly) {
  mkdirSync(outDir, { recursive: true });
  run(process.execPath, ['scripts/build.mjs'], path.join(root, 'plugin'));
  const results = [pack(path.join(root, 'plugin')), pack(stage)];
  for (const result of results) console.log(`${path.basename(result.file)}：${result.size} 字节，${result.files} 个文件，shasum ${result.shasum}`);
} else {
  console.log(`服务端暂存目录：${stage}`);
}
