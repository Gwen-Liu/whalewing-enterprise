// 员工端在真实 DSH 里的功能测试：临时 DSH 装上鲸翼个人版和本仓库的员工端，连到测试服务端，按员工的业务流程点界面。
// 用例清单见 e2e/cases.md（TEAM-*）。同一个文件里的用例按顺序跑、共用一套 DSH 和服务端：前面加入了，后面接着用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, textOf, withPage } from '../support/browser.mjs';
import { drawer, modal, openTab, openWhaleWing, startDsh, toast } from '../support/dsh.mjs';
import { ORG, startServer } from '../support/server.mjs';

let server, dsh, browser, data;
const PASSWORD = 'li-pass-1234';

test.before(async () => {
  [server, dsh, browser] = await Promise.all([startServer(), startDsh(), launchBrowser()]);
  await server.relogin();
  const rd = await server.admin('POST', '/admin/departments', { name: '研发部', parentId: null });
  const sales = await server.admin('POST', '/admin/departments', { name: '销售部', parentId: null });
  const only = (view, maintain = []) => ({ view, maintain });
  const dept = id => ({ type: 'department', id });
  await server.admin('POST', '/admin/items', { kind: 'knowledge', slug: 'rd-handbook', title: '研发手册', description: '研发规范和流程', access: only([dept(rd.id)], [dept(rd.id)]) });
  await server.putFile('knowledge', 'rd-handbook', '评审/代码评审.md', '# 代码评审\n\n两人以上看过才能合并到主干。');
  await server.admin('POST', '/admin/items', { kind: 'knowledge', slug: 'company', title: '公司制度', description: '全员都能看', access: only([{ type: 'all' }]) });
  await server.putFile('knowledge', 'company', '报销流程.md', '# 报销流程\n\n发票拍照上传，财务三个工作日内打款。');
  await server.admin('POST', '/admin/items', { kind: 'knowledge', slug: 'sales-kit', title: '销售资料', access: only([dept(sales.id)]) });
  await server.putFile('knowledge', 'sales-kit', '报价话术.md', '# 报价话术\n\n只给销售部看的保密话术。');
  await server.admin('POST', '/admin/items', { kind: 'expert', slug: 'code-reviewer', title: '代码评审专家', description: '按团队规范做代码评审', access: only([{ type: 'all' }], [dept(rd.id)]) });
  await server.admin('POST', '/admin/items', { kind: 'expert', slug: 'hr-helper', title: '人事助手', description: '回答请假和报销问题', access: only([{ type: 'all' }]) });
  await server.admin('POST', '/admin/items', { kind: 'skill', slug: 'weekly-report', title: '团队周报', description: '按团队格式写周报', access: only([{ type: 'all' }], [dept(rd.id)]) });
  const { link } = await server.admin('POST', '/admin/invites', { departmentId: rd.id, maxUses: 5 });
  data = { link, rd };
});
test.after(async () => { await browser?.close(); await dsh?.stop(); await server?.stop(); });

// ---------- 小工具 ----------

/** 「团队」页签自己的表单字段，按字段名完全一致来找。 */
const wwField = (scope, label) => {
  const page = typeof scope.page === 'function' ? scope.page() : scope;
  return scope.locator('label.ww-field').filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }).locator('input, textarea, select').first();
};
const teamView = page => page.locator('div[aria-label="团队"]');
const summary = page => teamView(page).locator('p').first();
const refresh = async page => {
  await page.locator('.ww-workbench-header').getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('dialog', { name: '更多操作' }).getByRole('button', { name: '刷新' }).click();
};
const openMenu = async (page, label) => {
  await page.getByRole('button', { name: label, exact: true }).click();
  return page.getByRole('dialog', { name: label, exact: true });
};
const pageHead = page => page.locator('.ww-pagehead:visible').first();
const searchKnowledge = async (page, words) => {
  await openTab(page, '个人知识');
  await page.getByRole('textbox', { name: '关键词（留空列出笔记）' }).fill(words);
  await page.getByRole('button', { name: '查找笔记', exact: true }).click();
};
const userId = async username => (await server.admin('GET', '/admin/users')).users.find(user => user.username === username).id;
/** 「团队」页签里的二级页：我的工作、团队看板、项目、团队资料。 */
const teamPage = async (page, name) => {
  const tab = teamView(page).getByRole('tab', { name, exact: true });
  await tab.click();
  await page.waitForFunction(label => [...document.querySelectorAll('div[aria-label="团队"] [role="tab"]')].some(button => button.textContent.trim() === label && button.getAttribute('aria-selected') === 'true'), name);
};
const assistantDraft = (page, text = 'team_work') => page.waitForFunction(value => document.querySelector('aside.ww-assistant [data-composer-input]')?.innerText.includes(value), text);
/** 鲸翼的助手气泡写着“打开{助手名称}”，用它看鲸翼里小鲸现在叫什么。 */
const assistantBubble = (page, name) => page.getByRole('button', { name: `打开${name}`, exact: true });
const nameAssistant = assistantName => server.admin('PATCH', '/admin/settings', { assistantName });
/** 在「团队」页签点刷新（立即同步），等提示“团队内容已是最新”。 */
const syncTeam = async page => {
  await openTab(page, '团队');
  await refresh(page);
  await toast(page, '团队内容已是最新', 'success').last().waitFor();
};
// 北京时间的日期，往前往后挪几天。
const isoDay = offset => new Date(Date.now() + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

function clean({ errors, external }) {
  assert.deepEqual(errors, [], '页面不能报错');
  assert.deepEqual(external, [], '不能连外网');
}

async function open(session) {
  await openWhaleWing(session.page, dsh.url);
  await openTab(session.page, '团队');
  await teamView(session.page).waitFor();
}

// ---------- 加入 ----------

// 设计§连接和登录-加密规则：外网地址只能 https；邀请链接格式不对说清楚。
test('TEAM-01 没连接时：显示加入入口；外网 http 地址和格式不对的邀请链接都被拦下', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    assert.equal(await textOf(summary(page)), '没有连接企业');
    const address = wwField(page, '邀请链接或服务器地址');
    await address.fill('http://8.8.8.8:8730');
    await page.getByRole('button', { name: '下一步' }).click();
    await toast(page, '只能用 https://', 'error').waitFor();
    await address.fill('https://team.example.com/join/abc');
    await page.getByRole('button', { name: '下一步' }).click();
    await toast(page, '不是有效的邀请链接', 'error').waitFor();
    clean(session);
  });
});

// 设计§连接和登录-先确认再连：弹窗写清企业名、地址、是否加密、部门和身份；取消就什么都不连。
test('TEAM-02 粘贴邀请链接：先显示“你将加入”，取消不连；两次密码不一致拦下；确认后加入', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    const address = wwField(page, '邀请链接或服务器地址');
    await address.fill(data.link);
    await page.getByRole('button', { name: '下一步' }).click();
    let confirm = modal(page, `你将加入：${ORG}`);
    const text = await textOf(confirm);
    assert.ok(text.includes(server.origin), '弹窗里写服务器地址');
    assert.match(text, /这是内网地址，连接没有加密/);
    assert.match(text, /加入后在「研发部」，身份是成员/);
    assert.match(text, /企业看不到你的个人知识、个人技能和会话/);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(await textOf(summary(page)), '没有连接企业');

    await page.getByRole('button', { name: '下一步' }).click();
    confirm = modal(page, `你将加入：${ORG}`);
    await wwField(confirm, '你的名字').fill('李组长');
    await wwField(confirm, '登录名').fill('lead');
    await wwField(confirm, '密码').fill(PASSWORD);
    await wwField(confirm, '再输一次密码').fill('another-pass-1');
    await confirm.getByRole('button', { name: '确认加入' }).click();
    await toast(page, '两次输入的密码不一样', 'error').waitFor();
    await wwField(confirm, '再输一次密码').fill(PASSWORD);
    await confirm.getByRole('button', { name: '确认加入' }).click();
    await toast(page, `已加入“${ORG}”`, 'success').waitFor();
    await page.waitForFunction(() => document.querySelector('div[aria-label="团队"] p')?.textContent.includes('研发部'));
    assert.match(await textOf(summary(page)), new RegExp(`^${ORG} · 研发部 · `));

    // 令牌只在 DSH 的凭据存储里，不写进插件自己的文件。
    const credentials = fs.readFileSync(path.join(dsh.home, '.credentials.yaml'), 'utf8');
    assert.match(credentials, /dsh-whalewing-enterprise/);
    const state = fs.readFileSync(path.join(dsh.profile, 'whalewing-enterprise', 'state.json'), 'utf8');
    assert.ok(!/token/i.test(state), 'state.json 里不能有令牌');
    clean(session);
  });
});

// 设计§团队内容和权限：只拿得到自己能看的；维护人和只读分得清。
test('TEAM-03 团队页签：能看的知识空间、专家、技能都在，看不到的不出现，维护人和只读分得清', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await teamPage(page, '团队资料');
    const view = teamView(page);
    await view.getByText('研发手册', { exact: true }).waitFor();
    const text = await textOf(view);
    assert.match(text, /李组长（lead · 成员）/);
    assert.match(text, /研发手册 研发规范和流程 1 篇笔记 · 你可以维护/);
    assert.match(text, /公司制度 全员都能看 1 篇笔记 · 只读/);
    assert.ok(!text.includes('销售资料'), '只给销售部看的空间不能出现');
    assert.match(text, /代码评审专家 按团队规范做代码评审 你可以维护/);
    assert.match(text, /人事助手 回答请假和报销问题 只读/);
    assert.match(text, /团队周报 按团队格式写周报 weekly-report · 1 个文件/);
    clean(session);
  });
});

// 设计§接进鲸翼个人版：团队专家进“专家团队”标“团队”；维护人能编辑并写回服务端，别人只能查看或复制。
test('TEAM-04 专家团队：团队专家标“团队”；只读的只能查看和复制；维护人编辑后写回服务端', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await openTab(page, '专家团队');
    await refresh(page);
    await page.waitForFunction(() => /2 位来自团队/.test(document.querySelector('.ww-pagehead:not([hidden])')?.textContent ?? '') || [...document.querySelectorAll('.ww-pagehead')].some(head => head.offsetParent && /2 位来自团队/.test(head.textContent)));
    const readOnly = await openMenu(page, '人事助手 · 专家操作');
    assert.deepEqual((await readOnly.getByRole('button').allInnerTexts()).map(item => item.trim()), ['查看专家', '复制为我的专家']);
    await page.keyboard.press('Escape');

    const menu = await openMenu(page, '代码评审专家 · 专家操作');
    await menu.getByRole('button', { name: '编辑专家' }).click();
    const editor = drawer(page, '编辑专家');
    assert.match(await textOf(editor), /由「团队」提供/);
    await editor.locator('label', { hasText: '一句话介绍' }).locator('input, textarea').first().fill('先看测试，再看实现');
    await editor.locator('footer button.ww-primary').click();
    await toast(page, '已保存「代码评审专家」的修改').waitFor();
    assert.match(await server.readFile('experts/code-reviewer/expert.md'), /description: 先看测试，再看实现/);
    clean(session);
  });
});

// 设计§接进鲸翼个人版：团队知识和个人知识一起搜，标“团队”，阅读只读；看不到的空间搜不到。
test('TEAM-05 个人知识：搜得到团队笔记，标“团队”，打开是只读；别的部门的空间搜不到', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await searchKnowledge(page, '两人以上');
    const result = page.getByRole('button', { name: /研发手册 \/ 代码评审/ });
    await result.waitFor();
    assert.match(await textOf(result.locator('xpath=..')), /团队/);
    await result.click();
    await page.getByText('这篇笔记由「团队」提供', { exact: false }).first().waitFor();
    await page.getByText('两人以上看过才能合并到主干。').first().waitFor();

    await searchKnowledge(page, '保密话术');
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole('button', { name: /报价话术/ }).count(), 0, '销售部的笔记不能出现');
    clean(session);
  });
});

// 设计§接进鲸翼个人版：团队技能在技能库“扩展 · 团队”一组，只读。
test('TEAM-06 技能库：“扩展 · 团队”一组里有团队技能，只读', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await openTab(page, '技能成长');
    const library = page.locator('section.ww-skill-library');
    await library.locator('.ww-skill-filters .ww-chip').filter({ hasText: '扩展' }).click();
    await library.getByText('扩展 · 团队').waitFor();
    const row = library.locator('.ww-skill-row').filter({ hasText: 'weekly-report' });
    assert.match(await textOf(row), /扩展 · 只读/);
    clean(session);
  });
});

// ---------- 维护 ----------

// 设计§「团队」页签：维护人能在页签里新建笔记，写到服务端，搜索马上能搜到。
test('TEAM-07 维护人在团队页签新建笔记：写到服务端，个人知识里马上搜得到', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await teamPage(page, '团队资料');
    const menu = await openMenu(page, '研发手册的操作');
    await menu.getByRole('button', { name: '新建笔记' }).click();
    const editor = drawer(page, '在「研发手册」新建笔记');
    await wwField(editor, '笔记路径').fill('发布/上线清单.md');
    await wwField(editor, '内容').fill('# 上线清单\n\n先备份数据目录，再发布。');
    await editor.locator('footer').getByRole('button', { name: '创建笔记' }).click();
    await toast(page, '笔记已建好', 'success').waitFor();
    assert.match(await server.readFile('knowledge/rd-handbook/发布/上线清单.md'), /先备份数据目录/);
    await searchKnowledge(page, '先备份数据目录');
    await page.getByRole('button', { name: /研发手册 \/ 上线清单/ }).waitFor();
    clean(session);
  });
});

// 设计§「团队」页签 和 §整体结构：提交个人笔记只发选中的那一篇，个人知识库原样不动。
test('TEAM-08 提交个人笔记：只发选中的那一篇，个人知识库的文件一字不改', async t => {
  const notePath = path.join(dsh.vault, '40-知识', '鲸翼测试-周报写法.md');
  const original = '---\ntype: atomic\nstatus: seedling\ncreated: 2026-11-01\nupdated: 2026-11-01\naliases: []\n---\n\n# 鲸翼测试-周报写法\n\n先写结论，再写进展和风险。\n';
  fs.writeFileSync(notePath, original);
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await teamPage(page, '团队资料');
    const menu = await openMenu(page, '研发手册的操作');
    await menu.getByRole('button', { name: '提交个人笔记' }).click();
    const editor = drawer(page, '把个人笔记提交到团队');
    assert.match(await textOf(editor), /只发你选的这一篇/);
    await editor.getByPlaceholder('关键字').fill('鲸翼测试-周报写法');
    const choice = editor.locator('label', { hasText: '鲸翼测试-周报写法' }).getByRole('radio');
    // 知识库可能要一会儿才认到刚写进去的文件，最多查 10 次。
    for (let attempt = 0; attempt < 10 && !(await choice.count()); attempt++) {
      await editor.getByRole('button', { name: '查找' }).click();
      await page.waitForTimeout(800);
    }
    await choice.check();
    assert.equal(await wwField(editor, '在团队里的路径').inputValue(), '鲸翼测试-周报写法.md');
    await editor.locator('footer').getByRole('button', { name: '提交到团队' }).click();
    await toast(page, '已提交到团队', 'success').waitFor();
    assert.match(await server.readFile('knowledge/rd-handbook/鲸翼测试-周报写法.md'), /先写结论，再写进展和风险。/);
    assert.equal(fs.readFileSync(notePath, 'utf8'), original, '个人笔记一字不改');
    clean(session);
  });
});

// 设计§「团队」页签：维护人能改团队技能的 SKILL.md。
test('TEAM-09 维护人修改团队技能的 SKILL.md：写回服务端', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await teamPage(page, '团队资料');
    const menu = await openMenu(page, '团队周报的操作');
    await menu.getByRole('button', { name: '编辑技能' }).click();
    const editor = drawer(page, '编辑技能 团队周报');
    const box = editor.locator('textarea');
    const text = await box.inputValue();
    assert.match(text, /^---\nname: weekly-report/);
    await box.fill(text + '\n每周五下午五点前交。\n');
    await editor.locator('footer').getByRole('button', { name: '保存修改' }).click();
    await toast(page, '已保存修改', 'success').waitFor();
    assert.match(await server.readFile('skills/weekly-report/SKILL.md'), /每周五下午五点前交/);
    clean(session);
  });
});

// ---------- 同步、离线、停用、退出 ----------

// 设计§同步和本机缓存：页头“…”里的刷新就是立即同步，新内容马上出现。
test('TEAM-10 管理员新加了内容：点刷新马上出现', async t => {
  await server.admin('POST', '/admin/items', { kind: 'knowledge', slug: 'new-space', title: '新人手册', description: '入职第一周看这里' });
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await refresh(page);
    await toast(page, '团队内容已是最新', 'success').waitFor();
    await teamPage(page, '团队资料');
    await teamView(page).getByText('新人手册', { exact: true }).waitFor();
    clean(session);
  });
});

// ---------- 企业管理：我的工作、团队看板、项目 ----------

// 企业管理设计§我的工作：默认打开；数字卡片只筛选不跳页；“更新”打开右侧抽屉，改动进动态。
test('TEAM-15 我的工作：先处理里有逾期和等我答复；新建事项；卡片筛选；更新状态写进动态', async t => {
  const lead = await userId('lead');
  const dev = await server.admin('POST', '/admin/users', { username: 'dev', displayName: '丁开发', password: 'dev-pass-1234', role: 'member', departmentId: data.rd.id });
  const late = await server.admin('POST', '/work/items', { title: '登录页改版', assigneeId: lead, status: 'doing', dueDate: isoDay(-2), progress: 90 });
  await server.admin('POST', '/work/items', { title: '需求范围确认', assigneeId: dev.id, status: 'waiting', waitingOn: lead, waitingNote: '等组长确认范围' });
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    const view = teamView(page);
    await view.getByText('登录页改版').waitFor();
    assert.equal(await view.getByRole('tab', { name: '团队看板' }).count(), 0, '成员看不到团队看板');
    assert.match(await textOf(view.locator('h2').first()), /^\d+月\d+日 周./);
    const text = await textOf(view);
    assert.match(text, /逾期 1 今天到期 0 进行中 1 等我答复 1 本周完成 0/);
    assert.match(text, /先处理 · 2/);
    assert.match(text, /逾期 2 天/);
    assert.match(text, /等我答复（来自 丁开发）/);

    await view.getByRole('button', { name: '＋ 新事项' }).click();
    const create = drawer(page, '新事项');
    await wwField(create, '标题').fill('整理发布清单');
    await wwField(create, '截止日期').fill(isoDay(0));
    await create.locator('footer').getByRole('button', { name: '建好事项' }).click();
    await toast(page, '已建好 RW-', 'success').waitFor();
    await view.getByText('整理发布清单').waitFor();
    assert.match(await textOf(view), /先处理 · 3/);

    await view.getByRole('button', { name: /^\s*逾期\s*1\s*$/ }).click();
    await page.waitForFunction(() => !document.querySelector('div[aria-label="团队"]').innerText.includes('整理发布清单'));
    assert.match(await textOf(view), /只看“逾期”/);
    await view.getByRole('listitem').filter({ hasText: '登录页改版' }).getByRole('button', { name: '更新' }).click();
    const update = drawer(page, `${late.number} 登录页改版`);
    await wwField(update, '状态').selectOption({ label: '已完成' });
    await wwField(update, '写一句动态（可选）').fill('已经上线');
    await update.locator('footer').getByRole('button', { name: '保存修改' }).click();
    await toast(page, `已保存 ${late.number}`, 'success').waitFor();
    assert.match(await textOf(update), /状态：进行中 → 已完成/);
    assert.match(await textOf(update), /“已经上线”/);
    const saved = await server.admin('GET', `/work/items/${late.id}`);
    assert.deepEqual([saved.category, saved.progress, saved.events.at(-1).actorName], ['done', 100, '李组长']);
    clean(session);
  });
});

// 企业管理设计§团队看板：有管理范围才看得到；组长自己的事项不混在看板里；点人看他的事项；“让小鲸分析”带着范围打开小鲸。
test('TEAM-16 团队看板：当上研发部负责人后出现；点人看他的事项；让小鲸分析', async t => {
  const lead = await userId('lead');
  const roles = (await server.admin('GET', '/admin/roles')).roles;
  await server.admin('PATCH', `/admin/users/${lead}`, { roleId: roles.find(role => role.preset === 'lead').id });
  await server.admin('PUT', `/admin/departments/${data.rd.id}/managers`, { userIds: [lead] });
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await refresh(page);
    await teamPage(page, '团队看板');
    const view = teamView(page);
    await view.getByText('研发部 · 1 人').waitFor();
    assert.match(await textOf(view), /进行中 0 逾期 0 等待中 1 本周完成 0/);
    await view.getByRole('button', { name: '丁开发' }).click();
    const person = drawer(page, '丁开发手上的事项');
    await person.getByRole('button', { name: /需求范围确认/ }).click();
    const item = drawer(page, '需求范围确认');
    await item.getByText('在等').first().waitFor();
    assert.match(await textOf(item), /李组长：等组长确认范围/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await view.getByRole('button', { name: '让小鲸分析' }).click();
    await assistantDraft(page);
    clean(session);
  });
});

// 企业管理设计§项目 和 §我的工作“交给专家”：加号卡片建项目；项目里建事项；事项交给专家时带着事项打开小鲸。
test('TEAM-17 项目：加号卡片建项目、在项目里建事项；引用团队笔记；事项菜单“交给专家”带着事项和笔记打开小鲸', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await teamPage(page, '项目');
    const view = teamView(page);
    await view.getByRole('button', { name: /新项目/ }).click();
    const create = drawer(page, '新项目');
    await wwField(create, '项目名称').fill('客户门户');
    await create.locator('label', { hasText: '丁开发' }).getByRole('checkbox').check();
    await create.locator('footer').getByRole('button', { name: '建好项目' }).click();
    await toast(page, '项目“客户门户”已建好', 'success').waitFor();
    await view.getByText('客户门户', { exact: true }).click();
    const project = drawer(page, '客户门户');
    await project.getByText('成员：丁开发').waitFor();
    await project.locator('footer').getByRole('button', { name: '＋ 在项目里建事项' }).click();
    const item = drawer(page, '新事项');
    await wwField(item, '项目').locator('option', { hasText: '客户门户' }).waitFor({ state: 'attached' });
    assert.equal(await wwField(item, '项目').locator('option:checked').innerText(), '客户门户', '从项目里建事项时项目已选好');
    await wwField(item, '标题').fill('门户首页');
    await item.locator('footer').getByRole('button', { name: '建好事项' }).click();
    await toast(page, '已建好', 'success').waitFor();
    await drawer(page, '客户门户').getByText('门户首页').waitFor();
    await page.keyboard.press('Escape');

    await teamPage(page, '我的工作');
    const row = view.getByRole('listitem').filter({ hasText: '门户首页' });
    const number = (await textOf(row)).match(/RW-\d{6}-\d{3}/)[0];
    // 引用资料：从本机同步的团队知识里挑一篇；交给专家时这篇一起交给小鲸。
    await row.getByRole('button', { name: '更新' }).click();
    const edit = drawer(page, number + ' 门户首页');
    await edit.getByRole('combobox', { name: '加一篇团队笔记' }).selectOption({ label: '研发手册 / 评审/代码评审' });
    await edit.locator('footer').getByRole('button', { name: '保存修改' }).click();
    await toast(page, '已保存 ' + number, 'success').waitFor();
    assert.match(await textOf(edit), /引用资料 研发手册 \/ 评审\/代码评审/);
    await page.keyboard.press('Escape');
    const menu = await openMenu(page, number + '的操作');
    await menu.getByRole('button', { name: '交给专家' }).click();
    await assistantDraft(page, number);
    await page.waitForFunction(() => document.querySelector('aside.ww-assistant .ww-assistant-context > summary')?.textContent === '当前资料 · 1');
    clean(session);
  });
});

// 企业管理设计§助手改名：管理员在企业设置里起名，员工端同步后鲸翼里的小鲸换成这个名字；改名跟着换；清空后恢复“小鲸助手”。
test('TEAM-18 助手改名：同步后鲸翼和团队页签里的小鲸都换成企业起的名字；改名跟着换；清空后恢复', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await assistantBubble(page, '小鲸助手').waitFor();

    await nameAssistant('小司助手');
    await syncTeam(page);
    await assistantBubble(page, '小司助手').waitFor();
    await teamPage(page, '团队资料');
    await teamView(page).getByText('助手名称“小司助手”由企业统一设定').waitFor();
    assert.match(await textOf(teamView(page)), /专家和小司助手都能调用/);
    await teamPage(page, '团队看板');
    await teamView(page).getByRole('button', { name: '让小司助手分析' }).waitFor();

    // 专家团队里小鲸的卡片换了名字；编辑时名字只读，写明由「团队」统一设定。
    await openTab(page, '专家团队');
    await refresh(page);
    const menu = await openMenu(page, '小司助手 · 专家操作');
    await menu.getByRole('button', { name: '编辑专家' }).click();
    const editor = drawer(page, '编辑专家');
    assert.match(await textOf(editor), /名字由「团队」统一设定/);
    const name = editor.locator('label', { hasText: '名字由「团队」统一设定' }).locator('input');
    assert.equal(await name.inputValue(), '小司助手');
    assert.equal(await name.isDisabled(), true, '名字框只读');
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });

    // 打开助手，面板标题也是新名字。
    await assistantBubble(page, '小司助手').click();
    await page.locator('aside.ww-assistant header h2', { hasText: '小司助手' }).waitFor();
    await page.getByRole('button', { name: '收起助手' }).click();

    await nameAssistant('小航助手');
    await syncTeam(page);
    await assistantBubble(page, '小航助手').waitFor();
    await teamPage(page, '团队资料');
    await teamView(page).getByText('助手名称“小航助手”由企业统一设定').waitFor();

    await nameAssistant(null);
    await syncTeam(page);
    await assistantBubble(page, '小鲸助手').waitFor();
    await teamPage(page, '团队看板');
    await teamView(page).getByRole('button', { name: '让小鲸分析' }).waitFor();
    await teamPage(page, '团队资料');
    assert.ok(!/助手名称/.test(await textOf(teamView(page))), '清空后不再写助手名称');

    // 后面离线、停用、退出几条接着核对名字。
    await nameAssistant('小司助手');
    await syncTeam(page);
    await assistantBubble(page, '小司助手').waitFor();
    clean(session);
  });
});

// 设计§同步和本机缓存-离线：连不上时缓存照常用，说清原因；连上后恢复。
test('TEAM-11 服务端连不上：提示原因、页头标离线，团队笔记照常能搜；恢复后自动好了', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await server.pause();
    try {
      await refresh(page);
      const failed = toast(page, '同步没成功', 'error');
      await failed.waitFor();
      assert.match(await textOf(failed), /重试/);
      await page.waitForFunction(() => document.querySelector('div[aria-label="团队"] p')?.textContent.includes('离线'));
      assert.match(await textOf(teamView(page)), /暂时连不上企业服务端/);
      // 企业管理设计§我的工作：连不上时显示上次同步的“我的工作”，标明是缓存，不能改。
      await teamPage(page, '我的工作');
      await teamView(page).getByText('现在看的是缓存').waitFor();
      assert.equal(await teamView(page).getByRole('button', { name: '＋ 新事项' }).count(), 0, '缓存只能看，不能改');
      await searchKnowledge(page, '两人以上');
      await page.getByRole('button', { name: /研发手册 \/ 代码评审/ }).waitFor();
      await assistantBubble(page, '小司助手').waitFor();
    } finally {
      await server.resume();
    }
    await openTab(page, '团队');
    await refresh(page);
    await toast(page, '团队内容已是最新', 'success').waitFor();
    await page.waitForFunction(() => !document.querySelector('div[aria-label="团队"] p')?.textContent.includes('离线'));
    clean(session);
  });
});

// 设计§连接和登录-令牌 和 §同步：管理员停用账号后团队内容撤掉、说明原因；重新启用后用服务器地址登录回来。
test('TEAM-12 账号被停用：团队内容撤掉并说明原因；启用后用服务器地址重新登录', async t => {
  const id = await userId('lead');
  await server.admin('PATCH', `/admin/users/${id}`, { status: 'disabled' });
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await refresh(page);
    await page.waitForFunction(() => document.querySelector('div[aria-label="团队"] p')?.textContent.includes('登录已失效'));
    assert.match(await textOf(teamView(page)), /登录已失效 .*本机的团队内容已经撤掉，助手恢复叫“小鲸助手”，你的个人知识、技能和会话都还在/);
    await assistantBubble(page, '小鲸助手').waitFor();
    await openTab(page, '专家团队');
    await refresh(page);
    await page.waitForTimeout(800);
    assert.ok(!/来自团队/.test(await textOf(pageHead(page))), '团队专家已撤掉');

    await server.admin('PATCH', `/admin/users/${id}`, { status: 'active' });
    await openTab(page, '团队');
    const address = wwField(page, '邀请链接或服务器地址');
    assert.equal(await address.inputValue(), server.origin, '重新登录时服务器地址已经填好');
    await page.getByRole('button', { name: '下一步' }).click();
    const confirm = modal(page, `你将加入：${ORG}`);
    await wwField(confirm, '登录名').fill('lead');
    await wwField(confirm, '密码').fill(PASSWORD);
    await confirm.getByRole('button', { name: '确认登录' }).click();
    await toast(page, `已加入“${ORG}”`, 'success').waitFor();
    await teamPage(page, '团队资料');
    await teamView(page).getByText('研发手册', { exact: true }).waitFor();
    await assistantBubble(page, '小司助手').waitFor();
    clean(session);
  });
});

// 设计§连接和登录 和 §同步-退出：退出后三处团队内容都撤掉，令牌删掉，个人内容不动。
test('TEAM-13 退出团队：居中确认后退出，专家、知识、技能里的团队内容都撤掉，令牌删掉', async t => {
  await withPage(browser, t, async session => {
    const { page } = session;
    await open(session);
    await teamPage(page, '团队资料');
    await teamView(page).getByRole('button', { name: '退出团队' }).click();
    const confirm = modal(page, '退出团队');
    assert.match(await textOf(confirm), /个人知识、个人技能和会话都不受影响/);
    assert.match(await textOf(confirm), /助手恢复叫“小鲸助手”/);
    await confirm.locator('footer button', { hasText: /^\s*退出团队\s*$/ }).click();
    await toast(page, '已退出团队', 'success').waitFor();
    assert.equal(await textOf(summary(page)), '没有连接企业');
    await assistantBubble(page, '小鲸助手').waitFor();

    await openTab(page, '专家团队');
    await refresh(page);
    await page.waitForTimeout(800);
    assert.ok(!/来自团队/.test(await textOf(pageHead(page))));
    await searchKnowledge(page, '两人以上');
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole('button', { name: /研发手册 \/ 代码评审/ }).count(), 0);
    await openTab(page, '技能成长');
    await refresh(page);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('section.ww-skill-library .ww-skill-row').filter({ hasText: 'weekly-report' }).count(), 0);

    assert.ok(!fs.readFileSync(path.join(dsh.home, '.credentials.yaml'), 'utf8').includes('dsh-whalewing-enterprise'), '令牌记录删掉了');
    assert.deepEqual(fs.readdirSync(path.join(dsh.profile, 'whalewing-enterprise', 'cache', 'skills')), [], '技能缓存清空');
    assert.ok(fs.existsSync(path.join(dsh.vault, '40-知识', '鲸翼测试-周报写法.md')), '个人笔记还在');
    clean(session);
  });
});

test('TEAM-14 DSH 日志里没有鲸翼企业版的报错', () => {
  const log = dsh.log();
  assert.ok(!/鲸翼企业版\] (启动失败|更新团队专家失败)/.test(log), log.split('\n').filter(line => line.includes('鲸翼企业版')).join('\n'));
});
