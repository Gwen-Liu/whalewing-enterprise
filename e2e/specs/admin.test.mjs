// 管理端网页的功能测试：在真实浏览器里按管理员的业务流程点界面。用例清单见 e2e/cases.md（ADM-*）。
// 一个文件一个服务端；同一个文件里的用例按顺序跑、共用这个服务端，后面的用例用到前面建好的数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { horizontalOverflow, launchBrowser, textOf, withPage } from '../support/browser.mjs';
import { ORG, OWNER, SETUP_CODE, startServer } from '../support/server.mjs';

let server, browser;
test.before(async () => { [server, browser] = await Promise.all([startServer({ setup: false }), launchBrowser()]); });
test.after(async () => { await browser?.close(); await server?.stop(); });

// ---------- 小工具 ----------

/** 表单里按字段名找输入框（字段名完全一致，免得“密码”和“再输一次密码”撞上）。 */
// filter({ has }) 里的内层定位要从 page 写起，从弹窗写起一个都匹配不到。
const field = (scope, label) => {
  const page = typeof scope.page === 'function' ? scope.page() : scope;
  return scope.locator('label.field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).locator('input, select, textarea').first();
};
const dialog = (page, name) => page.getByRole('dialog', { name });
// 同一句提示可能连着出现两条（连续做了两次同样的操作），取最新的一条。
const toast = (page, kind, text) => page.locator(`.toast.toast-${kind}`).filter(text ? { hasText: text } : {}).last();
const menu = async (page, label, item) => { await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('menuitem', { name: item, exact: true }).click(); };

async function login(page, { username = OWNER.username, password = OWNER.password } = {}) {
  await page.goto(server.origin + '/admin/');
  await field(page, '登录名').fill(username);
  await field(page, '密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '概览', level: 1 }).waitFor();
}

async function go(page, nav) {
  await page.getByRole('navigation', { name: '管理端导航' }).getByRole('link', { name: nav, exact: true }).click();
}

/** 每条用例最后都核对：没有页面错误，没有发往外网的请求。 */
function clean({ errors, external }) {
  assert.deepEqual(errors, [], '页面不能报错');
  assert.deepEqual(external, [], '管理端不能连外网');
}

// ---------- 初始化和登录 ----------

// 设计§部署-第一次打开：没有初始化码不能初始化；两次密码要一致；初始化后直接进管理端。
test('ADM-01 初始化向导：初始化码不对、两次密码不一致都拦下，填对后进概览', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await page.goto(server.origin + '/admin/');
    await page.getByRole('heading', { name: '初始化企业' }).waitFor();
    await field(page, '初始化码').fill('0000-0000');
    await field(page, '企业名称').fill(ORG);
    await field(page, '你的名字').fill(OWNER.displayName);
    await field(page, '登录名').fill(OWNER.username);
    await field(page, '密码').fill(OWNER.password);
    await field(page, '再输一次密码').fill('another-pass-1');
    await page.getByRole('button', { name: '完成初始化' }).click();
    await assert.doesNotReject(page.getByRole('alert').filter({ hasText: '两次输入的密码不一样' }).waitFor());

    await field(page, '再输一次密码').fill(OWNER.password);
    await page.getByRole('button', { name: '完成初始化' }).click();
    await page.getByRole('alert').filter({ hasText: '初始化码不对' }).waitFor();

    await field(page, '初始化码').fill(SETUP_CODE);
    await page.getByRole('button', { name: '完成初始化' }).click();
    await page.getByRole('heading', { name: '概览', level: 1 }).waitFor();
    assert.match(await textOf(page.locator('.sidebar .brand')), new RegExp(ORG));
    // 没填对外地址时概览提醒去设置里填。
    await page.locator('.notice').filter({ hasText: '还没填对外地址' }).waitFor();
    clean(session);
  });
});

// 设计§安全：成员不能登录管理端；密码错说清楚；退出登录回到登录页。
test('ADM-02 登录：密码错有提示，成员账号进不了管理端，退出登录回到登录页', async t => {
  await server.admin('POST', '/auth/login', { username: OWNER.username, password: OWNER.password, client: 'admin' });
  await server.admin('POST', '/admin/users', { username: 'member1', displayName: '普通成员', password: 'member-pass-1', role: 'member', departmentId: null });
  await withPage(browser, t, async session => {
    const { page } = session;
    await page.goto(server.origin + '/admin/');
    await field(page, '登录名').fill(OWNER.username);
    await field(page, '密码').fill('wrong-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '登录名或密码不对' }).waitFor();

    await field(page, '登录名').fill('member1');
    await field(page, '密码').fill('member-pass-1');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '不能登录管理端' }).waitFor();

    await login(page);
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByRole('heading', { name: `登录 ${ORG}` }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: `登录 ${ORG}` }).waitFor();
    clean(session);
  });
});

// ---------- 成员和部门 ----------

// 设计§谁能看、谁能改：部门是一棵树；新建用右侧抽屉，结果用右上角提示；不能移到自己的下级下面；有成员的部门删不了。
test('ADM-03 部门：新建、建下级、改名，不能移到自己下级，有成员时删不掉，空部门能删', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '成员');
    await page.getByRole('button', { name: '＋ 新建部门' }).click();
    let drawer = dialog(page, '新建部门');
    await field(drawer, '部门名称').fill('研发部');
    await drawer.getByRole('button', { name: '创建部门' }).click();
    await toast(page, 'success', '部门已建好').waitFor();
    await drawer.waitFor({ state: 'detached' });

    await menu(page, '研发部的操作', '新建下级部门');
    drawer = dialog(page, '新建部门');
    assert.equal(await field(drawer, '上级部门').locator('option:checked').innerText(), '研发部');
    await field(drawer, '部门名称').fill('后端组');
    await drawer.getByRole('button', { name: '创建部门' }).click();
    await toast(page, 'success', '部门已建好').waitFor();

    await menu(page, '研发部的操作', '改名或移动');
    drawer = dialog(page, '修改部门 研发部');
    const options = await field(drawer, '上级部门').locator('option').allInnerTexts();
    assert.ok(!options.some(option => option.includes('研发部') || option.includes('后端组')), '上级部门里不能选自己和自己的下级');
    await field(drawer, '部门名称').fill('研发中心');
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();
    await page.getByRole('button', { name: '研发中心', exact: true }).waitFor();

    await page.getByRole('button', { name: '＋ 新建部门' }).click();
    drawer = dialog(page, '新建部门');
    await field(drawer, '部门名称').fill('临时部门');
    await drawer.getByRole('button', { name: '创建部门' }).click();
    await toast(page, 'success', '部门已建好').waitFor();
    await menu(page, '临时部门的操作', '删除部门');
    const confirm = dialog(page, '删除部门');
    assert.match(await confirm.getByRole('button', { name: '删除部门' }).getAttribute('class'), /danger/, '删除确认按钮是红色');
    await confirm.getByRole('button', { name: '删除部门' }).click();
    await toast(page, 'success', '部门已删除').waitFor();
    await page.getByRole('button', { name: '临时部门', exact: true }).waitFor({ state: 'detached' });
    clean(session);
  });
});

// 设计§谁能看、谁能改 和 §安全：停用、改角色、重置密码马上让已登录的地方失效。
test('ADM-04 成员：新建账号、改部门、重置密码、停用后令牌马上失效、再启用', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '成员');
    await page.getByRole('button', { name: '新建账号' }).click();
    let drawer = dialog(page, '新建账号');
    await field(drawer, '名字').fill('张三');
    await field(drawer, '登录名').fill('zhangsan');
    await field(drawer, '初始密码').fill('zhang-pass-1');
    await field(drawer, '部门').selectOption({ label: '研发中心' });
    await drawer.getByRole('button', { name: '创建账号' }).click();
    await toast(page, 'success', '账号已建好').waitFor();
    const row = page.locator('tr', { hasText: 'zhangsan' });
    assert.match(await textOf(row), /张三 zhangsan 研发中心 成员/);

    // 员工端登录拿到令牌，停用后这个令牌马上不能用。
    const pluginLogin = await fetch(server.origin + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhangsan', password: 'zhang-pass-1', client: 'plugin' }) }).then(response => response.json());

    await menu(page, '张三的操作', '编辑');
    drawer = dialog(page, '编辑 张三');
    await field(drawer, '部门').selectOption({ label: '　后端组' });
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();
    await row.filter({ hasText: '后端组' }).waitFor();

    await menu(page, '张三的操作', '重置密码');
    drawer = dialog(page, '重置 张三 的密码');
    await field(drawer, '新密码').fill('zhang-pass-2');
    await drawer.getByRole('button', { name: '重置密码' }).click();
    await toast(page, 'success', '密码已重置').waitFor();
    const oldToken = await fetch(server.origin + '/api/v1/sync', { headers: { authorization: `Bearer ${pluginLogin.token}` } });
    assert.equal(oldToken.status, 401, '重置密码后旧的登录失效');

    const relogin = await fetch(server.origin + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhangsan', password: 'zhang-pass-2', client: 'plugin' }) }).then(response => response.json());
    await menu(page, '张三的操作', '停用账号');
    const confirm = dialog(page, '停用账号');
    assert.match(await textOf(confirm), /个人内容不受影响/);
    await confirm.getByRole('button', { name: '停用账号' }).click();
    await toast(page, 'success', '已停用').waitFor();
    await row.filter({ hasText: '已停用' }).waitFor();
    assert.equal((await fetch(server.origin + '/api/v1/sync', { headers: { authorization: `Bearer ${relogin.token}` } })).status, 401, '停用后登录马上失效');

    await menu(page, '张三的操作', '重新启用');
    await toast(page, 'success', '已重新启用').waitFor();
    await page.getByPlaceholder('找名字或登录名').fill('zhang');
    assert.equal(await page.locator('tbody tr').count(), 1);
    // 所有者不能被停用：菜单里没有“停用账号”。
    await page.getByPlaceholder('找名字或登录名').fill('owner');
    await page.getByRole('button', { name: `${OWNER.displayName}的操作` }).click();
    assert.equal(await page.getByRole('menuitem', { name: '停用账号' }).count(), 0);
    clean(session);
  });
});

// 设计§连接和登录：邀请链接只显示一次、能复制；撤销后失效；浏览器打开链接看到说明页。
test('ADM-05 邀请：生成链接（只显示一次、能复制）、邀请记录、撤销、说明页', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '成员');
    await page.getByRole('button', { name: '研发中心', exact: true }).click();
    await page.getByRole('button', { name: '邀请成员' }).click();
    const drawer = dialog(page, '邀请成员');
    assert.equal(await field(drawer, '加入哪个部门').locator('option:checked').innerText(), '研发中心', '默认邀请到左边选中的部门');
    await field(drawer, '能用几次').fill('3');
    await drawer.getByRole('button', { name: '生成邀请链接' }).click();
    const result = dialog(page, '邀请链接');
    const link = (await textOf(result.locator('.copy-box')));
    assert.match(link, new RegExp(`^${server.origin}/join/[A-Za-z0-9_-]{32}$`));
    assert.match(await textOf(result), /能用 3 次/);
    await result.getByRole('button', { name: '复制链接' }).click();
    await toast(page, 'success', '链接已复制').waitFor();
    await result.getByRole('button', { name: '关闭', exact: true }).first().click();

    const info = await page.context().newPage();
    await info.goto(link);
    assert.match(await textOf(info.locator('main')), new RegExp(`加入 ${ORG}.*研发中心.*dsh-whalewing-enterprise@`));
    await info.close();

    await page.getByRole('tab', { name: '邀请记录' }).click();
    const inviteRow = page.locator('tbody tr').first();
    assert.match(await textOf(inviteRow), /研发中心 成员 0 \/ 3 .* 能用/);
    await inviteRow.getByRole('button', { name: '邀请的操作' }).click();
    await page.getByRole('menuitem', { name: '撤销邀请' }).click();
    await dialog(page, '撤销邀请').getByRole('button', { name: '撤销邀请' }).click();
    await toast(page, 'success', '邀请已撤销').waitFor();
    await inviteRow.filter({ hasText: '已撤销' }).waitFor();
    const page2 = await page.context().newPage();
    await page2.goto(link);
    assert.match(await textOf(page2.locator('main')), /邀请链接用不了/);
    await page2.close();
    clean(session);
  });
});

// ---------- 团队内容 ----------

// 设计§三类团队内容 和 §改动冲突：新建用加号卡片；编辑用右侧抽屉；别人改过后再保存会被拒并给“读取最新内容”。
test('ADM-06 团队知识：加号卡片建空间、新建和修改笔记、冲突时提示读取最新、删除笔记、上传 .md', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '团队知识');
    await page.getByRole('button', { name: '新建知识空间' }).click();
    let drawer = dialog(page, '新建知识空间');
    await field(drawer, '名称').fill('研发手册');
    await field(drawer, '标识').fill('RD Handbook!');
    assert.equal(await field(drawer, '标识').inputValue(), 'rdhandbook', '标识自动去掉大写和符号');
    await field(drawer, '标识').fill('rd-handbook');
    await field(drawer, '介绍').fill('研发规范和流程');
    await drawer.getByRole('button', { name: '创建知识空间' }).click();
    await toast(page, 'success', '知识空间已建好').waitFor();
    await page.getByRole('heading', { name: '研发手册', level: 1 }).waitFor();

    await page.getByRole('button', { name: '新建笔记' }).click();
    drawer = dialog(page, '新建笔记');
    await field(drawer, '文件路径').fill('评审/代码评审.md');
    await field(drawer, '内容').fill('# 代码评审\n\n两人以上看过才合并。');
    await drawer.getByRole('button', { name: '创建文件' }).click();
    await toast(page, 'success', '文件已建好').waitFor();
    const card = page.locator('.file-card', { hasText: '评审/代码评审.md' });
    await card.waitFor();

    await card.click();
    drawer = dialog(page, '编辑 评审/代码评审.md');
    assert.match(await field(drawer, '内容').inputValue(), /两人以上/);
    // 抽屉开着的时候，别人（这里直接调接口）把这篇改了。
    const latest = (await server.admin('GET', '/admin/items/knowledge/rd-handbook')).files.find(file => file.path === '评审/代码评审.md');
    await server.putFile('knowledge', 'rd-handbook', '评审/代码评审.md', '# 代码评审\n\n别人先改了。', latest.hash);
    await field(drawer, '内容').fill('# 代码评审\n\n我的修改。');
    await drawer.getByRole('button', { name: '保存修改' }).click();
    const conflict = toast(page, 'error', '内容已被别人改过');
    await conflict.waitFor();
    await conflict.getByRole('button', { name: '读取最新内容' }).click();
    await card.click();
    drawer = dialog(page, '编辑 评审/代码评审.md');
    assert.match(await field(drawer, '内容').inputValue(), /别人先改了/);
    await field(drawer, '内容').fill('# 代码评审\n\n合并后的内容。');
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();

    await page.locator('input[type=file][accept*=".md"]').setInputFiles([{ name: '上线清单.md', mimeType: 'text/markdown', buffer: Buffer.from('# 上线清单\n\n先备份。') }]);
    await toast(page, 'success', '已上传 1 篇笔记').waitFor();
    await page.locator('.file-card', { hasText: '上线清单.md' }).waitFor();

    await page.getByRole('button', { name: '上线清单.md的操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '删除' }).click();
    await dialog(page, '删除文件').getByRole('button', { name: '删除文件' }).click();
    await toast(page, 'success', '文件已删除').waitFor();
    await page.locator('.file-card', { hasText: '上线清单.md' }).waitFor({ state: 'detached' });
    clean(session);
  });
});

// 设计§谁能看、谁能改：可见范围选部门、维护人选成员，卡片和详情上写明。
test('ADM-07 可见范围和维护人：选部门可见、选成员当维护人，卡片上写明', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '团队知识');
    await menu(page, '研发手册的操作', '设置');
    const drawer = dialog(page, '知识空间设置：研发手册');
    await drawer.getByRole('radio', { name: '指定部门和成员' }).check();
    const pickers = drawer.getByRole('combobox', { name: '添加部门或成员' });
    await pickers.nth(0).selectOption({ label: '研发中心' });
    await pickers.nth(1).selectOption({ label: '张三（zhangsan）' });
    assert.match(await textOf(drawer), /部门 · 研发中心.*成员 · 张三/);
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();
    assert.match(await textOf(page.locator('.item-card', { hasText: '研发手册' })), /研发中心可见 · 维护人：张三/);
    clean(session);
  });
});

// 设计§三类团队内容：团队专家和个人版专家模板同一格式；表单编辑后预览跟着变；原文写坏了保存不了。
test('ADM-08 团队专家：新建、表单编辑、预览更新，模板原文写坏会被拦下', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '团队专家');
    await page.getByRole('button', { name: '新建团队专家' }).click();
    let drawer = dialog(page, '新建团队专家');
    await field(drawer, '名称').fill('代码评审专家');
    await field(drawer, '标识').fill('code-reviewer');
    await field(drawer, '介绍').fill('按团队规范做代码评审');
    await drawer.getByRole('button', { name: '创建专家' }).click();
    await toast(page, 'success', '专家已建好').waitFor();
    const preview = page.locator('.expert-preview');
    await preview.locator('h2', { hasText: '代码评审专家' }).waitFor();
    assert.match(await textOf(preview), /代码评审专家 团队 按团队规范做代码评审/);

    await page.getByRole('button', { name: '编辑专家' }).click();
    drawer = dialog(page, '编辑专家：代码评审专家');
    await field(drawer, '一句话介绍').fill('先看测试，再看实现');
    await field(drawer, '技能').fill('weekly-report\nwhalewing-writing');
    await field(drawer, '提示词').fill('你是代码评审专家。合并前确认测试全部通过。');
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();
    await preview.getByText('先看测试，再看实现').waitFor();
    assert.match(await textOf(preview), /先看测试，再看实现 weekly-report whalewing-writing 你是代码评审专家。合并前确认测试全部通过。/);

    await page.getByRole('button', { name: '编辑模板原文' }).click();
    drawer = dialog(page, '编辑 expert.md');
    await field(drawer, '内容').fill('没有开头的模板');
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'error', '专家模板格式不对').waitFor();
    clean(session);
  });
});

// 设计§三类团队内容：技能根目录要有 SKILL.md、name 和标识一样；压缩包整体替换，外面多一层目录也认。
test('ADM-09 团队技能：新建带 SKILL.md、上传压缩包整体替换、name 写错拦下、SKILL.md 不能删', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '团队技能');
    await page.getByRole('button', { name: '新建团队技能' }).click();
    const drawer = dialog(page, '新建团队技能');
    await field(drawer, '名称').fill('团队周报');
    await field(drawer, '标识').fill('weekly-report');
    await field(drawer, '介绍').fill('按团队格式写周报');
    await drawer.getByRole('button', { name: '创建技能' }).click();
    await toast(page, 'success', '技能已建好').waitFor();
    await page.locator('.file-card', { hasText: 'SKILL.md' }).waitFor();
    await page.getByRole('button', { name: 'SKILL.md的操作', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '删除' }).count(), 0, 'SKILL.md 不能删');
    await page.keyboard.press('Escape');

    const archive = Buffer.from(zipSync({
      'weekly-report/SKILL.md': strToU8('---\nname: weekly-report\ndescription: 结论、进展、风险、下周计划\n---\n先写结论。'),
      'weekly-report/templates/周报模板.md': strToU8('# 本周结论'),
    }));
    await page.locator('input[type=file][accept*=".zip"]').setInputFiles({ name: 'weekly-report.zip', mimeType: 'application/zip', buffer: archive });
    const confirm = dialog(page, '上传技能压缩包');
    assert.match(await textOf(confirm), /压缩包里没有的文件会被删掉/);
    await confirm.getByRole('button', { name: '替换技能文件' }).click();
    await toast(page, 'success', '技能文件已替换').waitFor();
    await page.locator('.file-card', { hasText: 'templates/周报模板.md' }).waitFor();

    await page.locator('.file-card', { hasText: 'SKILL.md' }).click();
    const editor = dialog(page, '编辑 SKILL.md');
    await field(editor, '内容').fill('---\nname: other-name\ndescription: x\n---\n');
    await editor.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'error', 'name: weekly-report').waitFor();
    clean(session);
  });
});

// 界面通用约定：删除用居中确认、红色按钮；抽屉里有改动时关闭先问“放弃修改”。
test('ADM-10 删除内容项用红色居中确认；抽屉有改动时关闭先问放弃修改', async t => {
  await server.admin('POST', '/admin/items', { kind: 'knowledge', slug: 'temp-space', title: '临时空间' });
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '团队知识');
    await menu(page, '临时空间的操作', '设置');
    const drawer = dialog(page, '知识空间设置：临时空间');
    await field(drawer, '名称').fill('改了没保存');
    await page.keyboard.press('Escape');
    const discard = dialog(page, '放弃修改');
    await discard.getByRole('button', { name: '继续编辑' }).click();
    assert.equal(await field(drawer, '名称').inputValue(), '改了没保存', '继续编辑时改动还在');
    await drawer.getByRole('button', { name: '取消' }).click();
    await discard.getByRole('button', { name: '放弃修改' }).click();
    await drawer.waitFor({ state: 'detached' });

    await menu(page, '临时空间的操作', '删除知识空间');
    const confirm = dialog(page, '删除知识空间');
    assert.match(await confirm.getByRole('button', { name: '删除知识空间' }).getAttribute('class'), /danger/);
    await confirm.getByRole('button', { name: '删除知识空间' }).click();
    await toast(page, 'success', '已删除“临时空间”').waitFor();
    await page.locator('.item-card', { hasText: '临时空间' }).waitFor({ state: 'detached' });
    clean(session);
  });
});

// 设计§管理端-设置：企业名称、对外地址（邀请链接按它生成）、修改自己的密码。
test('ADM-11 设置：改企业名称、对外地址写错拦下、写对后邀请链接用它；改自己的密码', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '设置');
    await field(page, '企业名称').fill('鲸翼测试集团');
    await field(page, '对外地址').fill('team.example.com');
    await page.getByText('有未保存的修改').waitFor();
    await page.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'error', '对外地址要写成').waitFor();
    await field(page, '对外地址').fill('https://team.example.com/');
    await page.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();
    await page.locator('.sidebar .brand', { hasText: '鲸翼测试集团' }).waitFor();
    const { link } = await server.admin('POST', '/admin/invites', { departmentId: null });
    assert.match(link, /^https:\/\/team\.example\.com\/join\//);

    await field(page, '原密码').fill('wrong-old-pass');
    await field(page, '新密码').fill('owner-pass-456');
    await field(page, '再输一次新密码').fill('owner-pass-456');
    await page.getByRole('button', { name: '修改密码' }).click();
    await toast(page, 'error', '原密码不对').waitFor();
    await field(page, '原密码').fill(OWNER.password);
    await page.getByRole('button', { name: '修改密码' }).click();
    await toast(page, 'success', '密码已修改').waitFor();
    // 改回原来的，后面的用例照常登录。
    await field(page, '原密码').fill('owner-pass-456');
    await field(page, '新密码').fill(OWNER.password);
    await field(page, '再输一次新密码').fill(OWNER.password);
    await page.getByRole('button', { name: '修改密码' }).click();
    // 第一次的提示可能还没收起，等第二条出来。
    await page.locator('.toast.toast-success', { hasText: '密码已修改' }).nth(1).waitFor();
    // 改密码会作废其他地方的登录（包括测试造数据用的那个），重新登录一次。
    await server.relogin();
    await server.admin('PATCH', '/admin/settings', { orgName: ORG, publicUrl: null });
    clean(session);
  });
});

// 设计§安全-操作记录：记谁改了成员、权限和团队内容；能按类型筛选；不记密码。
test('ADM-12 操作记录：有前面的操作，按类型筛选，不含密码', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '操作记录');
    const table = page.locator('tbody');
    await table.locator('tr', { hasText: '新建部门' }).first().waitFor();
    assert.match(await textOf(table), /王所有者（owner） 新建成员 zhangsan/);
    await page.getByRole('button', { name: '部门', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].every(row => row.textContent.includes('部门')));
    await page.getByRole('button', { name: '团队内容文件', exact: true }).click();
    await table.locator('tr', { hasText: 'knowledge/rd-handbook/评审/代码评审.md' }).first().waitFor();
    const all = await server.admin('GET', '/admin/audit?limit=200');
    assert.ok(!JSON.stringify(all).includes('zhang-pass'), '操作记录里不能有密码');
    clean(session);
  });
});

// ---------- 布局和主题 ----------

const PAGES = [['概览', '概览'], ['成员', '成员'], ['团队知识', '团队知识'], ['团队专家', '团队专家'], ['团队技能', '团队技能'], ['设置', '设置'], ['操作记录', '操作记录']];

// 用户 2026-11-01 反馈：管理端要跟着浏览器窗口大小自适应，宽屏不空一大块，窄屏不被撑出横向滚动。
for (const [width, height, columns] of [[375, 812, 2], [768, 1024, 3], [1280, 800, 3], [1920, 1080, 6]]) {
  test(`ADM-13 ${width} 宽：每页都没有横向滚动，概览卡片每行 ${columns} 张${width >= 1920 ? '，内容区铺满' : ''}`, async t => {
    await withPage(browser, t, { width, height }, async session => {
      const { page } = session;
      await login(page);
      const stats = await page.locator('.stats').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      assert.equal(stats, columns);
      for (const [nav, heading] of PAGES) {
        await go(page, nav);
        await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
        assert.equal(await horizontalOverflow(page), 0, `${nav}页在 ${width} 宽时被撑出了横向滚动`);
      }
      await page.goto(server.origin + '/admin/items/knowledge/rd-handbook');
      await page.getByRole('heading', { name: '研发手册', level: 1 }).waitFor();
      assert.equal(await horizontalOverflow(page), 0);
      if (width >= 1920) {
        const main = await page.locator('main.main').boundingBox();
        assert.ok(main.width >= 1600, `1920 宽时内容区应铺开，实际 ${main.width}`);
      }
      clean(session);
    });
  });
}

// 设计§管理端：跟随系统的浅色和深色。
test('ADM-14 深色模式：背景深、文字浅，卡片和背景分得开', async t => {
  await withPage(browser, t, { colorScheme: 'dark' }, async session => {
    const { page } = session;
    await login(page);
    const colors = await page.evaluate(() => {
      const luminance = color => { const [r, g, b] = color.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const style = selector => getComputedStyle(document.querySelector(selector));
      return { body: luminance(style('body').backgroundColor), text: luminance(style('body').color), card: luminance(style('.card').backgroundColor) };
    });
    assert.ok(colors.body < 0.15, '背景是深色');
    assert.ok(colors.text > 0.7, '文字是浅色');
    assert.ok(colors.card > colors.body, '卡片比背景亮一点，分得开');
    clean(session);
  });
});

test('ADM-15 管理端网页的静态文件带缓存规则和安全响应头', async () => {
  const index = await fetch(server.origin + '/admin/');
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  const html = await index.text();
  const asset = html.match(/\/admin\/(assets\/[^"]+\.js)/)[1];
  const script = await fetch(`${server.origin}/admin/${asset}`);
  assert.match(script.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(server.origin + '/admin/members')).status, 200, '直接打开子页面也能进');
  assert.equal(readFileSync(path.join(server.dataDir, 'whalewing-enterprise.db')).length > 0, true);
});
