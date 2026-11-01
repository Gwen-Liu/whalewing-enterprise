// 功能测试的浏览器部分：无头 Chromium、每条用例一个干净的浏览器上下文、拦下所有发往本机以外的请求、失败时截图。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

export const evidenceDir = process.env.WWE_E2E_OUT || path.join(os.tmpdir(), 'wwe-e2e-evidence');

export function launchBrowser() {
  // 中文界面；去掉无头默认的 --hide-scrollbars，滚动条和真浏览器一样占位。
  return chromium.launch({ args: ['--lang=zh-CN'], ignoreDefaultArgs: ['--hide-scrollbars'] });
}

const localHost = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/** 开一个新页面：收集页面错误和控制台报错；外网请求一律拦下记在 external 里；失败时截图到证据目录。 */
export async function newPage(browser, t, { width = 1440, height = 900, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, locale: 'zh-CN', acceptDownloads: false });
  const external = [];
  await context.route(url => /^(https?|wss?):$/.test(url.protocol) && !localHost.test(url.hostname), route => { external.push(route.request().url()); return route.abort('blockedbyclient'); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const slug = `${path.basename(t.filePath || 'e2e', '.test.mjs')}-${t.name}`.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120);
  const shot = async name => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const file = path.join(evidenceDir, `${slug}${name ? `-${name}` : ''}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    return file;
  };
  return {
    page, context, errors, external, shot,
    async close(failed) {
      if (failed) t.diagnostic(`截图：${await shot('失败')}`);
      await context.close();
    },
  };
}

export async function withPage(browser, t, options, run) {
  if (typeof options === 'function') { run = options; options = {}; }
  const session = await newPage(browser, t, options);
  let failed = true;
  try { await run(session); failed = false; } finally { await session.close(failed); }
}

/** 页面有没有被撑出横向滚动：返回多出来的像素，0 表示没有。 */
export const horizontalOverflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

export const textOf = async locator => (await locator.innerText()).replace(/\s+/g, ' ').trim();
