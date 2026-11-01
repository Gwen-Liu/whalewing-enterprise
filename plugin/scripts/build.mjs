// 构建员工端组合包：Host 打成 index.js，浏览器入口打成 client.js，再生成 cordis.patch.yml。
// 共用接口定义（shared）直接打进去，发布的包不依赖工作区里的其他包。
// DSH 自带的包（@deepseek-ai/*、zod）和 React 用宿主那一份，不打进来。
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageName, rowId } from '../identity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const HEADER = '// 由 scripts/build.mjs 生成，请改 src/ 下的源文件。鲸翼企业版，AGPL-3.0-only。\n';

export function renderHost() {
  return HEADER + buildSync({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/host.js')],
    bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
    external: ['@deepseek-ai/*', 'zod'],
    loader: { '.svg': 'text' },
    supported: { 'template-literal': false },
    legalComments: 'none',
  }).outputFiles[0].text;
}

export function renderClient() {
  const compiled = buildSync({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/client.jsx')],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', write: false,
    external: ['react'],
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', minify: true,
    supported: { 'template-literal': false },
    legalComments: 'none',
  }).outputFiles[0].text;
  const zodLicense = readFileSync(path.join(path.dirname(require.resolve('zod/package.json')), 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim();
  return HEADER + `/*! 内联 Zod 许可\n${zodLicense}\n*/\n`
    + `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {\nconst module = { exports: {} };\n${compiled}\nreturn module.exports;\n} });\n`;
}

export function renderPatch() {
  return '# 由 scripts/build.mjs 从 package.json 生成。\n- insert:\n    - id: ' + JSON.stringify(rowId) + '\n      name: ' + JSON.stringify(packageName) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(path.join(root, 'index.js'), renderHost(), 'utf8');
  writeFileSync(path.join(root, 'client.js'), renderClient(), 'utf8');
  writeFileSync(path.join(root, 'cordis.patch.yml'), renderPatch(), 'utf8');
  console.log('已生成 index.js、client.js、cordis.patch.yml');
}
