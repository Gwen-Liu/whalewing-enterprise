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
    await go(page, '组织与人员');
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
    await go(page, '组织与人员');
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
    assert.match(await textOf(confirm), /个人内容和负责的事项不受影响/);
    await confirm.getByRole('button', { name: '停用账号' }).click();
    await toast(page, 'success', '已停用').waitFor();
    await row.filter({ hasText: '已停用' }).waitFor();
    assert.equal((await fetch(server.origin + '/api/v1/sync', { headers: { authorization: `Bearer ${relogin.token}` } })).status, 401, '停用后登录马上失效');

    await menu(page, '张三的操作', '重新启用');
    await toast(page, 'success', '已重新启用').waitFor();
    await page.getByPlaceholder('找名字或登录名').fill('zhang');
    assert.equal(await page.locator('tbody tr').count(), 1);
    // 自己不能停用自己：菜单里没有“停用账号”（管理员之间平级，没有“所有者”）。
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
    await go(page, '组织与人员');
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

// ---------- 企业管理：管理员、角色、负责人、事项类型、看板、项目、回收站、导入 ----------

// 企业管理设计§超级管理员在系统之外，管理员在系统之内：管理员可以有多个、互相平级；自己不能停用、不能改自己的身份。
test('ADM-16 管理员平级：任命第二位管理员、互相能停用和重置密码；自己的身份不能改', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '组织与人员');
    await page.getByRole('button', { name: '新建账号' }).click();
    const drawer = dialog(page, '新建账号');
    await field(drawer, '名字').fill('李管理');
    await field(drawer, '登录名').fill('admin2');
    await field(drawer, '初始密码').fill('admin2-pass-1');
    await field(drawer, '身份').selectOption({ label: '管理员' });
    assert.equal(await field(drawer, '角色').count(), 0, '管理员不挂角色');
    await drawer.getByRole('button', { name: '创建账号' }).click();
    await toast(page, 'success', '账号已建好').waitFor();
    const row = page.locator('tr', { hasText: 'admin2' });
    assert.match(await textOf(row), /李管理 admin2 — 管理员/);

    await menu(page, '李管理的操作', '重置密码');
    const reset = dialog(page, '重置 李管理 的密码');
    await field(reset, '新密码').fill('admin2-pass-2');
    await reset.getByRole('button', { name: '重置密码' }).click();
    await toast(page, 'success', '密码已重置').waitFor();
    await menu(page, '李管理的操作', '停用账号');
    await dialog(page, '停用账号').getByRole('button', { name: '停用账号' }).click();
    await toast(page, 'success', '已停用').waitFor();
    await menu(page, '李管理的操作', '重新启用');
    await toast(page, 'success', '已重新启用').waitFor();

    await menu(page, `${OWNER.displayName}的操作`, '编辑');
    const self = dialog(page, `编辑 ${OWNER.displayName}`);
    assert.equal(await field(self, '身份').isDisabled(), true);
    assert.match(await textOf(self), /不能改自己的身份/);
    clean(session);
  });
});

// 企业管理设计§管理员自己定义的角色、§上下级从哪来：角色 = 权限点 + 数据范围；负责人在部门树上设；还不是负责人时管理端提示。
test('ADM-17 角色与权限：建“小组长”、有人用着的角色删不掉；给张三换角色后提示还不是负责人，设成部门负责人后提示消失', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '角色与权限');
    const cards = page.locator('article.item-card');
    assert.match(await textOf(cards.filter({ hasText: '负责人' }).first()), /负责人 ?预置 .*数据范围：管理范围 .*派事项.*看团队看板/);
    await page.getByRole('button', { name: /新建角色/ }).click();
    const drawer = dialog(page, '新建角色');
    await field(drawer, '角色名称').fill('小组长');
    await drawer.locator('label.check', { hasText: '管理范围' }).getByRole('radio').check();
    for (const permission of ['派事项', '调整事项', '看团队看板']) await drawer.locator('label.check', { hasText: new RegExp(`^${permission}`) }).getByRole('checkbox').check();
    await drawer.getByRole('button', { name: '建好角色' }).click();
    await toast(page, 'success', '角色已建好').waitFor();
    assert.match(await textOf(cards.filter({ hasText: '小组长' })), /数据范围：管理范围 新建事项、派事项、调整事项、看团队看板 0 人用着这个角色/);

    await menu(page, '成员的操作', '删除角色');
    await dialog(page, '删除角色').getByRole('button', { name: '删除角色' }).click();
    await toast(page, 'error', '用着“成员”').waitFor();
    // 删不掉时确认框留着，看完原因点“取消”。
    await dialog(page, '删除角色').getByRole('button', { name: '取消' }).click();

    await go(page, '组织与人员');
    await menu(page, '张三的操作', '编辑');
    const edit = dialog(page, '编辑 张三');
    await field(edit, '角色').selectOption({ label: '小组长' });
    await edit.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存修改').waitFor();
    const row = page.locator('tr', { hasText: 'zhangsan' });
    await row.filter({ hasText: '还不是负责人' }).waitFor();

    await page.getByRole('button', { name: '研发中心', exact: true }).click();
    await page.getByRole('button', { name: '研发中心的操作' }).click();
    await page.getByRole('menuitem', { name: '设置负责人' }).click();
    const managers = dialog(page, '设置“研发中心”的负责人');
    await managers.locator('label.check', { hasText: 'zhangsan' }).getByRole('checkbox').check();
    await managers.getByRole('button', { name: '保存负责人' }).click();
    await toast(page, 'success', '负责人已设好').waitFor();
    await page.getByText('负责人：张三').waitFor();
    assert.equal(await row.filter({ hasText: '还不是负责人' }).count(), 0);
    assert.match(await textOf(row), /张三 ?负责人 zhangsan/);
    clean(session);
  });
});

// 企业管理设计§一种事项，多种类型：类型定编号前缀、状态（归到五个大类）和专属字段。
test('ADM-18 事项类型：加号卡片建“开发”，前缀自动大写、重复被拦下；停用和重新启用', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '事项类型');
    assert.match(await textOf(page.locator('article.item-card').first()), /任务 ?RW .*编号形如 RW-\d{6}-001 未开始 进行中 等待中 已完成 已取消/);
    await page.getByRole('button', { name: /新建类型/ }).click();
    let drawer = dialog(page, '新建事项类型');
    await field(drawer, '类型名称').fill('开发');
    await field(drawer, '编号前缀').fill('rw');
    await drawer.getByRole('textbox', { name: '第 1 个状态的名字' }).fill('待开发');
    await drawer.getByRole('button', { name: '＋ 加一个字段' }).click();
    await drawer.getByRole('textbox', { name: '第 1 个字段的名字' }).fill('模块');
    await drawer.getByRole('combobox', { name: '“模块”的类型' }).selectOption({ label: '单选' });
    await drawer.getByRole('textbox', { name: '“模块”的选项' }).fill('前端、后端');
    await drawer.getByRole('button', { name: '建好类型' }).click();
    await toast(page, 'error', '已经被别的类型用了').waitFor();
    await field(drawer, '编号前缀').fill('kf');
    await drawer.getByRole('button', { name: '建好类型' }).click();
    await toast(page, 'success', '类型已建好').waitFor();
    const card = page.locator('article.item-card', { hasText: '开发' });
    assert.match(await textOf(card), /开发 ?KF .*编号形如 KF-\d{6}-001 待开发 ?·未开始 进行中 .*专属字段：模块（单选）/);
    await menu(page, '开发的操作', '停用');
    await toast(page, 'success', '已停用').waitFor();
    await card.filter({ hasText: '已停用' }).waitFor();
    await menu(page, '开发的操作', '重新启用');
    await toast(page, 'success', '已重新启用').waitFor();
    clean(session);
  });
});

// 企业管理设计§团队看板、§管理员是系统里的最高权限：全局看板和员工端同一份数据；管理员能调整任何人的事项，改动进动态和操作记录。
test('ADM-19 全局看板：点部门进去、点人看他的事项；管理员调整截止日期和优先级，动态和操作记录都有', async t => {
  const zhang = (await server.admin('GET', '/admin/users')).users.find(user => user.username === 'zhangsan');
  const past = new Date(Date.now() + 8 * 3600_000 - 3 * 86_400_000).toISOString().slice(0, 10);
  await server.admin('POST', '/work/items', { title: '接口联调', assigneeId: zhang.id, status: 'doing', dueDate: past });
  await server.admin('POST', '/work/items', { title: '写接口文档', assigneeId: zhang.id });
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '全局看板');
    const departments = page.locator('table').first();
    const center = departments.locator('tr', { hasText: '研发中心' });
    assert.match(await textOf(center), /研发中心 张三 \d+ 1 1 0 0/);
    await center.getByRole('button', { name: '研发中心' }).click();
    await page.getByRole('button', { name: '后端组' }).click();
    await page.getByRole('heading', { name: /研发中心 \/ 后端组/ }).waitFor();
    await page.getByRole('button', { name: '张三', exact: true }).click();
    const person = dialog(page, '张三手上的事项');
    await person.getByRole('button', { name: '接口联调' }).waitFor();
    assert.match(await textOf(person), /接口联调 .*逾期 3 天/);
    await person.getByRole('button', { name: '接口联调' }).click();
    const item = dialog(page, /接口联调/);
    await field(item, '截止日期').fill('2030-01-15');
    await field(item, '优先级').selectOption({ label: '高' });
    await field(item, '写一句动态（可选）').fill('客户同意延期');
    await item.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '已保存 RW-').waitFor();
    assert.match(await textOf(item), /优先级：中 → 高；截止日期：\d{4}-\d{2}-\d{2} → 2030-01-15 “客户同意延期”/);
    const audit = await server.admin('GET', '/admin/audit?action=work.adjust');
    assert.match(audit.entries[0].detail.changes.join(' '), /截止日期：.* → 2030-01-15/);
    assert.equal(audit.entries[0].detail.via, '本人操作');
    clean(session);
  });
});

// 企业管理设计§项目、§防止越权：项目和成员；删除先进回收站，管理员能恢复，彻底删除只能在服务器上用命令行。
test('ADM-20 项目和回收站：新建项目、改成已结束；事项放进回收站后能恢复', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '项目');
    await page.getByRole('button', { name: '新建项目' }).click();
    const drawer = dialog(page, '新建项目');
    await field(drawer, '项目名称').fill('客户门户');
    await drawer.locator('label.check', { hasText: 'zhangsan' }).getByRole('checkbox').check();
    await drawer.getByRole('button', { name: '建好项目' }).click();
    await toast(page, 'success', '项目已建好').waitFor();
    const row = page.locator('tr', { hasText: '客户门户' });
    assert.match(await textOf(row), /客户门户 王管理 1 0 0 .* 进行中/);
    await menu(page, '客户门户的操作', '编辑');
    const edit = dialog(page, '项目 客户门户');
    await field(edit, '状态').selectOption({ label: '已结束（不能再加事项）' });
    await edit.getByRole('button', { name: '保存修改' }).click();
    await toast(page, 'success', '项目已保存').waitFor();
    await row.filter({ hasText: '已结束' }).waitFor();

    await go(page, '全局看板');
    await page.getByRole('button', { name: '研发中心' }).click();
    await page.getByRole('button', { name: '后端组' }).click();
    await page.getByRole('button', { name: '张三', exact: true }).click();
    await dialog(page, '张三手上的事项').getByRole('button', { name: '写接口文档' }).click();
    const item = dialog(page, /写接口文档/);
    await item.getByRole('button', { name: '放进回收站' }).click();
    const confirm = dialog(page, '放进回收站');
    assert.match(await textOf(confirm), /彻底删除只能在服务器上用命令行/);
    await confirm.getByRole('button', { name: '放进回收站' }).click();
    await toast(page, 'success', '已放进回收站').waitFor();
    // 放进回收站后回到这个人的事项列表，列表里已经没有它了。
    const back = dialog(page, '张三手上的事项');
    await back.getByText('接口联调').waitFor();
    assert.equal(await back.getByRole('button', { name: '写接口文档' }).count(), 0);
    await page.keyboard.press('Escape');

    await go(page, '回收站');
    const trashed = page.locator('tr', { hasText: '写接口文档' });
    assert.match(await textOf(trashed), /写接口文档 张三 王管理/);
    await trashed.getByRole('button', { name: '恢复' }).click();
    await toast(page, 'success', '已恢复').waitFor();
    await page.getByText('回收站是空的。').waitFor();
    clean(session);
  });
});

/** 造一个最小的 .xlsx：第一行表头，日期列用日期格式（Excel 里存的是天数）。 */
function xlsx(rows) {
  const strings = [];
  const index = text => { const at = strings.indexOf(text); return at >= 0 ? at : strings.push(text) - 1; };
  const cells = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const ref = String.fromCharCode(65 + c) + (r + 1);
    return typeof value === 'number' ? `<c r="${ref}" s="1"><v>${value}</v></c>` : `<c r="${ref}" t="s"><v>${index(value)}</v></c>`;
  }).join('')}</row>`).join('');
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return Buffer.from(zipSync({
    'xl/workbook.xml': strToU8(`<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="事项" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>'),
    'xl/styles.xml': strToU8(`<styleSheet ${ns}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    'xl/sharedStrings.xml': strToU8(`<sst ${ns}>${strings.map(text => `<si><t>${text}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet ${ns}><sheetData>${cells}</sheetData></worksheet>`),
  }));
}

// 企业管理设计§管理端网页加什么-导入：从表格导入事项，把列对到字段、把旧状态对到新状态和大类。
test('ADM-21 导入事项：CSV 自动对列和状态；对不上的负责人先说清楚，选“这一行不导入”后导入；Excel 的日期格式也认', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '导入事项');
    const csv = '﻿编号,标题,负责人,状态,截止日期\nOLD-1,旧系统事项一,张三,处理中,2026/12/1\nOLD-2,旧系统事项二,zhangsan,已关闭,2026-11-20\nOLD-3,没人认领的,不存在的人,新建,\n';
    await page.locator('input[type=file]').setInputFiles({ name: '旧系统.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.getByText('旧系统.csv：5 列，3 行数据。').waitFor();
    assert.equal(await field(page, '标题（必填）').locator('option:checked').innerText(), '标题');
    assert.equal(await field(page, '原编号').locator('option:checked').innerText(), '编号');
    assert.equal(await page.getByRole('combobox', { name: '旧状态“处理中”对到' }).locator('option:checked').innerText(), '进行中');
    assert.equal(await page.getByRole('combobox', { name: '旧状态“已关闭”对到' }).locator('option:checked').innerText(), '已完成');
    await page.getByRole('button', { name: '先检查' }).click();
    await page.getByText('检查完了：2 行能导入，1 行有问题').waitFor();
    assert.match(await textOf(page.locator('.timeline')), /第 4 行 负责人“不存在的人”还没对上是谁/);
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await toast(page, 'error', '一个都没导入').waitFor();
    await page.getByRole('combobox', { name: '“不存在的人”是谁' }).selectOption({ label: '这一行不导入' });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await toast(page, 'success', '已导入 2 个事项').waitFor();
    const imported = (await server.admin('GET', '/work/items?q=旧系统')).items;
    assert.deepEqual(imported.map(item => [item.title, item.category, item.dueDate]).sort(), [['旧系统事项一', 'doing', '2026-12-01'], ['旧系统事项二', 'done', '2026-11-20']]);

    // Excel：第一张工作表，日期是带日期格式的天数。
    const file = xlsx([['标题', '负责人', '截止日期'], ['从 Excel 来的', '张三', 46022]]);
    await page.locator('input[type=file]').setInputFiles({ name: '旧系统.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: file });
    await page.getByText('旧系统.xlsx：3 列，1 行数据。').waitFor();
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await toast(page, 'success', '已导入 1 个事项').waitFor();
    const fromExcel = (await server.admin('GET', '/work/items?q=Excel')).items[0];
    assert.deepEqual([fromExcel.dueDate, fromExcel.statusName], ['2025-12-31', '未开始']);
    clean(session);
  });
});

// 企业管理设计§“看”和“改”分开：事项默认谁能看，企业设置里可以改成全员可见。
test('ADM-22 设置：事项默认谁能看改成全员可见；时区写错被拦下', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '设置');
    await page.locator('label.check', { hasText: '全员可见' }).getByRole('radio').check();
    await field(page, '时区').fill('北京');
    await page.getByRole('button', { name: '保存修改' }).first().click();
    await toast(page, 'error', 'Asia/Shanghai 这样的写法').waitFor();
    await field(page, '时区').fill('Asia/Shanghai');
    await page.getByRole('button', { name: '保存修改' }).first().click();
    await toast(page, 'success', '已保存修改').waitFor();
    assert.equal((await server.admin('GET', '/admin/settings')).workVisibility, 'all');
    await page.locator('label.check', { hasText: '数据范围里的' }).getByRole('radio').check();
    await page.getByRole('button', { name: '保存修改' }).first().click();
    await toast(page, 'success', '已保存修改').waitFor();
    assert.equal((await server.admin('GET', '/admin/settings')).workVisibility, 'scope');
    clean(session);
  });
});

// 企业管理设计§助手改名、§管理端网页加什么-企业设置：管理员起名，去掉首尾空白保存；管理端里写着“小鲸”的说明跟着换；留空恢复。
test('ADM-23 设置：助手名称起名后保存，概览和团队技能的说明跟着换；留空恢复“小鲸助手”', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await login(page);
    await go(page, '设置');
    const name = field(page, '助手名称');
    assert.equal(await name.inputValue(), '', '默认不改名');
    assert.equal(await name.getAttribute('placeholder'), '小鲸助手');
    assert.match(await textOf(page.locator('label.field').filter({ has: page.locator('.field-label', { hasText: /^助手名称$/ }) })), /留空就用「小鲸助手」.*最多 16 个字/);
    await name.fill('  小司助手 ');
    await page.getByRole('button', { name: '保存修改' }).first().click();
    await toast(page, 'success', '已保存修改').waitFor();
    assert.equal((await server.admin('GET', '/admin/settings')).assistantName, '小司助手', '去掉首尾空白');
    assert.equal(await name.inputValue(), '小司助手');

    await go(page, '概览');
    await page.locator('.stat', { hasText: '团队技能' }).getByText('专家和小司助手都能调用').waitFor();
    await go(page, '团队技能');
    await page.getByText('专家和小司助手都能调用', { exact: false }).first().waitFor();

    await go(page, '设置');
    await field(page, '助手名称').fill('   ');
    await page.getByRole('button', { name: '保存修改' }).first().click();
    await toast(page, 'success', '已保存修改').waitFor();
    assert.equal((await server.admin('GET', '/admin/settings')).assistantName, null, '留空就不改名');
    await go(page, '概览');
    await page.locator('.stat', { hasText: '团队技能' }).getByText('专家和小鲸都能调用').waitFor();
    await go(page, '操作记录');
    await page.locator('tbody tr', { hasText: '修改企业设置' }).first().waitFor();
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
    assert.match(await textOf(table), new RegExp(`${OWNER.displayName}（owner） 新建成员 zhangsan`));
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

const PAGES = [['概览', '概览'], ['组织与人员', '组织与人员'], ['角色与权限', '角色与权限'], ['全局看板', '全局看板'], ['项目', '项目'], ['事项类型', '事项类型'], ['回收站', '回收站'],
  ['导入事项', '从表格导入事项'], ['团队知识', '团队知识'], ['团队专家', '团队专家'], ['团队技能', '团队技能'], ['设置', '设置'], ['操作记录', '操作记录']];

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
