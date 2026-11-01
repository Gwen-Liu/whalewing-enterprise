// 功能测试用的临时 DSH：独立的 DSH_HOME、profile、知识库和文档目录，用目录联接装上鲸翼个人版和本仓库的员工端，
// 只加载 DSH 原版基础包和这两个插件；测完关掉进程、删掉临时目录（遇到联接只删链接本身）。不碰员工的正式 DSH 和 ~/.dsh。
//
// 要两样东西，找不到就报错、不跳过：
//   WWE_E2E_WHALEWING  鲸翼个人版插件目录（要带专家来源、知识来源接口的版本，并装好开发依赖）；
//                      不设时依次找仓库同级的 whalewing/、WhaleWing/plugins/whalewing/
//   WWE_E2E_DSH_BIN    DSH 的 lib/bin.js；不设时从个人版的开发依赖里找 @deepseek-ai/dsh
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const pluginDir = path.join(repoRoot, 'plugin');
const slash = value => value.replaceAll('\\', '/');

export function personalDir() {
  const candidates = [process.env.WWE_E2E_WHALEWING, path.resolve(repoRoot, '../whalewing'), path.resolve(repoRoot, '../WhaleWing/plugins/whalewing')].filter(Boolean);
  for (const dir of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (manifest.name === 'dsh-whalewing') return dir;
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到鲸翼个人版：请把 WWE_E2E_WHALEWING 设成个人版插件目录（package.json 的 name 是 dsh-whalewing）');
}

export function dshBin() {
  if (process.env.WWE_E2E_DSH_BIN) return process.env.WWE_E2E_DSH_BIN;
  try { return createRequire(path.join(personalDir(), 'package.json')).resolve('@deepseek-ai/dsh/lib/bin.js'); }
  catch { throw new Error('找不到 DSH：请把 WWE_E2E_DSH_BIN 设成 DSH 的 lib/bin.js，或先装好鲸翼个人版的开发依赖'); }
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

/** 删目录：遇到联接或符号链接只删链接本身，不进到链接指向的目录里（插件源码就是被联接进来的）。 */
export function removeTree(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return; }
  if (stat.isSymbolicLink()) { fs.unlinkSync(target); return; }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

/** 去掉本机的各种 Key、Token、密钥类环境变量，测试里不可能误用真凭据。 */
const secretName = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?$/i;
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !secretName.test(name)));

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经退出 */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已经退出 */ }
  }
}

function writeProfile(home, profile, personal) {
  const root = path.join(home, 'profiles', profile);
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(personal, path.join(root, 'node_modules', 'dsh-whalewing'), 'junction');
  fs.symlinkSync(pluginDir, path.join(root, 'node_modules', 'dsh-whalewing-enterprise'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: `wwe-${profile}`, private: true,
    dependencies: { 'dsh-whalewing': `link:${slash(personal)}`, 'dsh-whalewing-enterprise': `link:${slash(pluginDir)}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-whalewing', 'dsh-whalewing-enterprise'] } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  return root;
}

const patchYaml = ({ vault, documents }) => [
  '- id: session-telemetry-otel\n  disabled: true',
  '- id: product-analytics\n  disabled: true',
  '- id: desktop-product-telemetry\n  disabled: true',
  '- id: session-title-llm\n  disabled: true',
  `- id: whalewing\n  config:\n    vaultRoot: ${slash(vault)}`,
  `- id: workspace-controller\n  config:\n    documentsDirectory: ${slash(documents)}`,
  '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1',
].join('\n') + '\n';

/** 启动临时 DSH，等它打印出带口令的访问地址。seed(dirs) 在启动前调用，往临时知识库里放这次要的数据。 */
export async function startDsh({ profile = 'e2e', seed, timeout = 120_000 } = {}) {
  if (!fs.existsSync(path.join(pluginDir, 'index.js'))) throw new Error('还没构建员工端，先在仓库根目录运行 npm run build');
  const personal = personalDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwe-e2e-dsh-'));
  const dirs = { root, home: path.join(root, 'home'), vault: path.join(root, 'vault'), documents: path.join(root, 'documents') };
  try {
    for (const dir of [dirs.home, dirs.vault, dirs.documents]) fs.mkdirSync(dir, { recursive: true });
    dirs.profile = writeProfile(dirs.home, profile, personal);
    const patch = path.join(root, 'e2e.patch.yml');
    fs.writeFileSync(patch, patchYaml(dirs));
    await seed?.(dirs);
    const port = await freePort();
    const logPath = path.join(root, 'host.log'), log = fs.createWriteStream(logPath);
    const child = spawn(process.execPath, [dshBin(), '--profile', profile, '--patch', patch, '--no-open', '--port', String(port)], {
      cwd: root, env: { ...testEnv(), DSH_HOME: dirs.home, CI: 'true' }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DSH ${timeout / 1000} 秒内没有给出访问地址，日志见 ${logPath}`)), timeout);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH 启动时退出（代码 ${code}），日志见 ${logPath}`)); });
      const receive = data => {
        log.write(data);
        if (output === null) return;
        output += data.toString();
        const match = output.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s\u001b]*/);
        if (match) { output = null; clearTimeout(timer); resolve(match[0]); }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
    }).catch(error => { killTree(child); log.end(); throw error; });
    let stopped = false;
    return {
      ...dirs, url, logPath,
      log: () => fs.readFileSync(logPath, 'utf8'),
      async stop({ keep = false } = {}) {
        if (stopped) return;
        stopped = true;
        killTree(child);
        await new Promise(resolve => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
        await new Promise(resolve => log.end(resolve));
        if (!keep) for (let attempt = 0; ; attempt++) {
          try { removeTree(root); break; } catch (error) { if (attempt >= 10) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
        }
      },
    };
  } catch (error) {
    if (!process.env.WWE_E2E_KEEP) { await new Promise(resolve => setTimeout(resolve, 500)); try { removeTree(root); } catch { /* 进程还占着就留给系统清理 */ } }
    else error.message += `（临时目录保留在 ${root}）`;
    throw error;
  }
}

/** 打开 DSH，关掉“开始使用”提示，点左侧“鲸翼”，等工作台页签出来。 */
export async function openWhaleWing(page, url) {
  const welcome = page.getByRole('dialog', { name: '开始使用' });
  const dismiss = async () => { await welcome.getByRole('button', { name: '关闭' }).click(); await welcome.waitFor({ state: 'hidden' }); };
  await page.goto(url);
  if (await welcome.waitFor({ timeout: 5000 }).then(() => true, () => false)) await dismiss();
  await page.addLocatorHandler(welcome, dismiss);
  await page.getByRole('button', { name: '鲸翼', exact: true }).first().click();
  await page.locator('.ww-workbench-header button[data-tab]').first().waitFor();
}

/** 切到鲸翼的某个页签，等它成为选中状态。 */
export async function openTab(page, name) {
  const tab = page.locator('.ww-workbench-header button[data-tab]', { hasText: name });
  await tab.click();
  await page.waitForFunction(label => [...document.querySelectorAll('.ww-workbench-header button[data-tab]')]
    .some(button => button.textContent.trim() === label && button.getAttribute('aria-pressed') === 'true'), name);
  return tab;
}

/** 鲸翼工作台统一的右上角提示、居中弹窗、右侧抽屉。 */
export const toast = (page, text, kind) => page.locator(`.ww-toast${kind ? `.ww-toast-${kind}` : ''}`).filter(text ? { hasText: text } : {});
export const modal = (page, title) => page.locator('dialog.ww-modal[open]').filter({ has: page.locator('header h2', { hasText: title }) });
export const drawer = (page, title) => page.locator('dialog.ww-editor[open]').filter({ has: page.locator('header h2', { hasText: title }) });
