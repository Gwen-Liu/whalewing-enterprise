// 事项和项目：编号、看和改分开、进度和逾期、动态、回收站、我的工作、团队看板、项目、类型、导入导出。
// 组织照设计里的例子：交付中心（乙，负责人）下面一组（丙，小组长；丁、戊）、二组（己，小组长；庚）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { designOrg, server } from './helpers.mjs';
import { addDays } from '../src/work.js';

const work = (s, who, method, url, body) => s.request(method, '/api/v1/work' + url, { ...(who === 'admin' ? { cookie: s.adminCookie } : { token: who.token }), body });
const admin = (s, method, url, body) => s.request(method, '/api/v1/admin' + url, { cookie: s.adminCookie, body });

async function world(t) {
  const s = await server(t);
  const org = await designOrg(s);
  const cal = s.work.calendar();
  return { s, ...org, ...org.people, cal };
}

test('编号按类型前缀和年月自动生成，删掉的号不再用；给别人建要“派事项”并且他在范围里', async t => {
  const { s, ding, wu, bing, geng, yi, cal } = await world(t);
  const first = await work(s, ding, 'POST', '/items', { title: '登录页改版' });
  assert.equal(first.status, 200);
  assert.equal(first.json.number, `RW-${cal.period}-001`);
  assert.deepEqual([first.json.assigneeId, first.json.creatorId, first.json.category, first.json.statusName], [ding.user.id, ding.user.id, 'todo', '未开始']);
  const second = await work(s, ding, 'POST', '/items', { title: '第二件' });
  await work(s, 'admin', 'DELETE', `/items/${second.json.id}`);
  assert.equal((await work(s, ding, 'POST', '/items', { title: '第三件' })).json.number, `RW-${cal.period}-003`);

  assert.match((await work(s, ding, 'POST', '/items', { title: '指给戊', assigneeId: wu.user.id })).json.error.message, /派事项/);
  const assigned = await work(s, bing, 'POST', '/items', { title: '丙派给丁', assigneeId: ding.user.id, dueDate: addDays(cal.today, 3) });
  assert.equal(assigned.status, 200);
  assert.match((await work(s, bing, 'POST', '/items', { title: '丙派给庚', assigneeId: geng.user.id })).json.error.message, /不在你的管理范围/);
  assert.equal((await work(s, yi, 'POST', '/items', { title: '乙派给庚', assigneeId: geng.user.id })).status, 200, '上级的范围包含下面所有组');
  const audit = (await admin(s, 'GET', '/audit?action=work.')).json.entries;
  assert.ok(audit.some(entry => entry.action === 'work.assign' && entry.detail.assignee === 'ding'));
  assert.equal((await work(s, ding, 'POST', '/items', { title: '日期反了', startDate: cal.today, dueDate: addDays(cal.today, -1) })).json.error.code, 'INVALID_INPUT');
});

test('看和改分开：看不到的说不存在；自己负责的能改状态进度，改截止日期要“调整事项”；改动进动态，经模型的标出来', async t => {
  const { s, ding, wu, bing, ji, yi, geng } = await world(t);
  const item = (await work(s, ding, 'POST', '/items', { title: '接口联调' })).json;
  assert.equal((await work(s, wu, 'GET', `/items/${item.id}`)).json.error.code, 'NOT_FOUND', '同组同事不在范围里，也没参与');
  assert.equal((await work(s, ji, 'GET', `/items/${item.id}`)).json.error.code, 'NOT_FOUND', '别的组长看不到');
  assert.equal((await work(s, bing, 'GET', `/items/${item.id}`)).status, 200);
  assert.equal((await work(s, yi, 'GET', `/items/${item.id}`)).status, 200);

  const doing = await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: 1, status: 'doing', progress: 40, comment: '开始联调' });
  assert.deepEqual([doing.json.category, doing.json.progress, doing.json.revision], ['doing', 40, 2]);
  assert.match((await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: 2, dueDate: '2030-01-01' })).json.error.message, /调整事项/);
  assert.equal((await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: 1, progress: 50 })).json.error.code, 'CONFLICT', '读到的版本旧了就拒收');

  const adjusted = await work(s, bing, 'PATCH', `/items/${item.id}`, { baseRevision: 2, dueDate: '2030-01-01', priority: 'high', via: { kind: 'model', name: '小鲸助手' } });
  assert.equal(adjusted.status, 200);
  const last = adjusted.json.events.at(-1);
  assert.deepEqual([last.actorName, last.via, last.viaName], ['bing', 'model', '小鲸助手']);
  assert.deepEqual(last.changes.map(change => [change.label, change.from, change.to]), [['优先级', '中', '高'], ['截止日期', null, '2030-01-01']]);
  const audit = (await admin(s, 'GET', '/audit?action=work.adjust')).json.entries[0];
  assert.equal(audit.detail.via, '经小鲸助手');
  assert.deepEqual(audit.detail.changes, ['优先级：中 → 高', '截止日期：无 → 2030-01-01']);
  // 管理端网页上点的一律算本人操作，带了 via 也不认。
  const fromAdmin = await work(s, 'admin', 'PATCH', `/items/${item.id}`, { baseRevision: 3, priority: 'low', via: { kind: 'model' } });
  assert.equal(fromAdmin.json.events.at(-1).via, 'ui');

  // 协作人能看、能写动态，不能改状态。
  await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: 4, collaboratorIds: [wu.user.id] });
  assert.equal((await work(s, wu, 'GET', `/items/${item.id}`)).status, 200);
  assert.equal((await work(s, wu, 'POST', `/items/${item.id}/comments`, { text: '接口文档我补上了' })).status, 200);
  assert.equal((await work(s, wu, 'PATCH', `/items/${item.id}`, { baseRevision: 5, status: 'done' })).json.error.code, 'FORBIDDEN');

  // 企业设置改成全员可见：庚能看，但不能改、不能写动态。
  await admin(s, 'PATCH', '/settings', { workVisibility: 'all' });
  assert.equal((await work(s, geng, 'GET', `/items/${item.id}`)).status, 200);
  assert.equal((await work(s, geng, 'POST', `/items/${item.id}/comments`, { text: '路过' })).json.error.code, 'FORBIDDEN');
  const detail = (await work(s, geng, 'GET', `/items/${item.id}`)).json;
  assert.deepEqual(detail.rights, { edit: false, adjust: false, assign: false, delete: false, comment: false });
});

test('进度和逾期自动算：完成 100、未开始 0、有检查项按检查项；截止日期过了没做完算逾期，等待中的也算', async t => {
  const { s, ding, wu, cal } = await world(t);
  const item = (await work(s, ding, 'POST', '/items', {
    title: '测试数据准备', checklist: [{ text: '造账号', done: true }, { text: '造订单' }, { text: '造日志' }, { text: '核对' }],
  })).json;
  assert.equal(item.progress, 0, '未开始就是 0');
  const doing = (await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: 1, status: 'doing', progress: 90 })).json;
  assert.equal(doing.progress, 25, '有检查项时按检查项算，手填的不用');
  const done = (await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: doing.revision, status: 'done' })).json;
  assert.equal(done.progress, 100);
  assert.ok(done.completedAt);
  const reopened = (await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: done.revision, status: 'doing' })).json;
  assert.equal(reopened.completedAt, null, '退回进行中，完成时间清掉');
  const cancelled = (await work(s, ding, 'PATCH', `/items/${item.id}`, { baseRevision: reopened.revision, status: 'cancelled' })).json;
  assert.equal(cancelled.progress, null, '已取消不算进度');

  const late = (await work(s, ding, 'POST', '/items', { title: '需求范围确认', status: 'waiting', dueDate: addDays(cal.today, -2), waitingOn: wu.user.id, waitingNote: '等戊确认范围' })).json;
  assert.deepEqual([late.overdue, late.overdueDays, late.waitingOnName], [true, 2, 'wu']);
  const finished = (await work(s, ding, 'POST', '/items', { title: '已经做完的', status: 'done', dueDate: addDays(cal.today, -2) })).json;
  assert.equal(finished.overdue, false, '做完的不算逾期');
});

test('我的工作：按负责人算；逾期、今天到期、进行中、等我答复、本周完成', async t => {
  const { s, ding, wu, bing, cal } = await world(t);
  await work(s, ding, 'POST', '/items', { title: '逾期的', status: 'doing', dueDate: addDays(cal.today, -1) });
  await work(s, ding, 'POST', '/items', { title: '今天到期', dueDate: cal.today });
  await work(s, ding, 'POST', '/items', { title: '做完了', status: 'done' });
  await work(s, bing, 'POST', '/items', { title: '丙建了指给丁', assigneeId: ding.user.id, status: 'doing' });
  await work(s, wu, 'POST', '/items', { title: '戊在等丁', status: 'waiting', waitingOn: ding.user.id, waitingNote: '等丁答复接口字段' });
  await work(s, bing, 'POST', '/items', { title: '丙自己的' });
  const mine = (await work(s, ding, 'GET', '/mine')).json;
  assert.equal(mine.today, cal.today);
  assert.deepEqual(mine.summary, { overdue: 1, dueToday: 1, doing: 2, waitingMe: 1, doneThisWeek: 1 });
  const waiting = mine.items.find(item => item.waitingMe);
  assert.deepEqual([waiting.title, waiting.mine, waiting.assigneeName], ['戊在等丁', false, 'wu']);
  assert.ok(!mine.items.some(item => item.title === '丙自己的'), '“我的”按负责人算，不按创建人');
  // 被等的人能看到这个事项，也能写动态答复。
  assert.equal((await work(s, ding, 'POST', `/items/${waiting.id}/comments`, { text: '字段按第二版来' })).status, 200);
});

test('删除先进回收站，只有管理员能恢复；删除要权限点；动态和操作记录都有', async t => {
  const { s, ding, bing, yi } = await world(t);
  const item = (await work(s, ding, 'POST', '/items', { title: '要删的' })).json;
  assert.equal((await work(s, ding, 'DELETE', `/items/${item.id}`)).json.error.code, 'FORBIDDEN', '成员没有删除权限');
  assert.equal((await work(s, yi, 'DELETE', `/items/${item.id}`)).json.error.code, 'FORBIDDEN', '预置的负责人默认不勾删除');
  const deleter = (await admin(s, 'POST', '/roles', { name: '能删的组长', scope: 'managed', permissions: ['item.delete'] })).json;
  await admin(s, 'PATCH', `/users/${bing.user.id}`, { roleId: deleter.id });
  assert.equal((await work(s, bing, 'DELETE', `/items/${item.id}`)).status, 200);
  assert.equal((await work(s, ding, 'GET', `/items/${item.id}`)).json.error.code, 'NOT_FOUND');
  assert.equal((await work(s, ding, 'GET', '/items')).json.total, 0);
  const trash = (await admin(s, 'GET', '/work/trash')).json.items;
  assert.deepEqual(trash.map(entry => [entry.title, entry.deletedByName]), [['要删的', 'bing']]);
  const restored = await admin(s, 'POST', `/work/items/${item.id}/restore`);
  assert.deepEqual(restored.json.events.map(event => event.kind), ['create', 'delete', 'restore']);
  assert.equal((await work(s, ding, 'GET', `/items/${item.id}`)).status, 200);
  const actions = (await admin(s, 'GET', '/audit?action=work.')).json.entries.map(entry => entry.action);
  assert.deepEqual(actions.slice(0, 2), ['work.restore', 'work.delete']);
});

test('团队看板：负责人先看各下级部门的汇总，再点进部门；组长只看自己的组；自己的事项不混在看板里', async t => {
  const { s, one, two, center, ding, wu, bing, geng, yi, cal } = await world(t);
  await work(s, ding, 'POST', '/items', { title: '丁逾期', status: 'doing', dueDate: addDays(cal.today, -1) });
  await work(s, ding, 'POST', '/items', { title: '丁做完', status: 'done' });
  await work(s, wu, 'POST', '/items', { title: '戊等待', status: 'waiting', waitingOn: geng.user.id, dueDate: addDays(cal.today, -3) });
  await work(s, geng, 'POST', '/items', { title: '庚进行中', status: 'doing' });
  await work(s, bing, 'POST', '/items', { title: '丙自己的', status: 'doing' });

  const top = (await work(s, yi, 'GET', '/board')).json;
  assert.equal(top.title, '交付中心', '只管一个部门时直接进这个部门');
  assert.deepEqual(top.departments.map(row => [row.name, row.people, row.doing, row.overdue, row.waiting, row.doneThisWeek]),
    [['一组', 3, 2, 2, 1, 1], ['二组', 2, 1, 0, 0, 0]]);
  assert.deepEqual(top.departments[0].managers, ['bing']);
  assert.deepEqual(top.summary, { open: 4, doing: 3, overdue: 2, waiting: 1, doneThisWeek: 1 });

  const group = (await work(s, bing, 'GET', '/board')).json;
  assert.equal(group.title, '一组');
  assert.deepEqual(group.members.map(row => [row.name, row.open, row.overdue]), [['ding', 1, 1], ['wu', 1, 1]], '丙自己不在看板里');
  assert.deepEqual(group.members[1].waitingFor, ['geng'], '等待中又逾期的，标出在等谁');
  assert.equal((await work(s, bing, 'GET', `/board?departmentId=${two.id}`)).json.error.code, 'NOT_FOUND');
  assert.equal((await work(s, bing, 'GET', `/board?departmentId=${center.id}`)).json.error.code, 'NOT_FOUND', '组长看不到上级部门');
  assert.equal((await work(s, ding, 'GET', '/board')).json.error.code, 'FORBIDDEN');
  const drill = (await work(s, yi, 'GET', `/board?departmentId=${one.id}`)).json;
  assert.deepEqual(drill.trail.map(entry => entry.name), ['交付中心', '一组']);
  assert.equal(drill.members.length, 3);

  const global = (await work(s, 'admin', 'GET', '/board')).json;
  assert.equal(global.title, '鲸翼测试公司', '管理员默认看全企业');
  assert.deepEqual(global.departments.map(row => row.name), ['交付中心']);
  assert.ok(global.members.some(row => row.name === '王管理'), '管理端全局看板把没有部门的人也列出来');
  // 每个人的事项：在范围里才查得到。
  const dingItems = (await work(s, bing, 'GET', `/items?assigneeId=${ding.user.id}&category=open`)).json;
  assert.deepEqual(dingItems.items.map(item => item.title), ['丁逾期']);
});

test('项目：管项目的人建项目；项目成员能看项目里的全部事项；结束的项目不能再加事项；有事项的不能删', async t => {
  const { s, ding, wu, bing, geng } = await world(t);
  assert.equal((await work(s, ding, 'POST', '/projects', { name: '丁的项目' })).json.error.code, 'FORBIDDEN');
  const project = (await work(s, bing, 'POST', '/projects', { name: '客户门户', memberIds: [geng.user.id] })).json;
  assert.equal(project.ownerId, bing.user.id);
  assert.equal((await work(s, ding, 'POST', '/items', { title: '丁不是项目成员', projectId: project.id })).json.error.code, 'NOT_FOUND');
  const item = (await work(s, bing, 'POST', '/items', { title: '门户首页', projectId: project.id, assigneeId: ding.user.id })).json;
  assert.equal(item.projectName, '客户门户');
  assert.equal((await work(s, geng, 'GET', `/items/${item.id}`)).status, 200, '项目成员跨组也能看');
  assert.deepEqual((await work(s, geng, 'GET', `/items?projectId=${project.id}`)).json.items.map(entry => entry.title), ['门户首页']);
  assert.deepEqual((await work(s, ding, 'GET', '/projects')).json.projects.map(entry => entry.name), ['客户门户'], '自己有事项在里面的项目也看得到');
  assert.deepEqual((await work(s, wu, 'GET', '/projects')).json.projects, []);
  assert.equal((await work(s, wu, 'POST', '/items', { title: '加进别人的项目', projectId: project.id })).json.error.code, 'NOT_FOUND');

  assert.equal((await work(s, bing, 'DELETE', `/projects/${project.id}`)).json.error.code, 'IN_USE');
  assert.equal((await work(s, geng, 'PATCH', `/projects/${project.id}`, { status: 'closed' })).json.error.code, 'FORBIDDEN', '项目成员不能改项目');
  assert.equal((await work(s, bing, 'PATCH', `/projects/${project.id}`, { status: 'closed' })).json.status, 'closed');
  assert.match((await work(s, ding, 'POST', '/items', { title: '再加一个', projectId: project.id })).json.error.message, /已经结束/);
});

test('事项类型：状态归到大类，统计照样合起来；用着的状态不能删；改大类时已有事项跟着改；专属字段按类型校验', async t => {
  const { s, ding } = await world(t);
  const type = await admin(s, 'POST', '/work-types', {
    name: '开发', prefix: 'KF',
    statuses: [{ name: '待开发', category: 'todo' }, { name: '开发中', category: 'doing' }, { name: '待验收', category: 'waiting' }, { name: '已上线', category: 'done' }],
    fields: [{ name: '模块', kind: 'select', options: ['前端', '后端'] }, { name: '上线日期', kind: 'date' }],
  });
  assert.equal(type.status, 200);
  assert.deepEqual(type.json.statuses.map(status => status.key), ['s1', 's2', 's3', 's4']);
  assert.equal((await admin(s, 'POST', '/work-types', { name: '开发2', prefix: 'KF', statuses: [{ name: '新', category: 'todo' }] })).json.error.code, 'EXISTS');
  assert.equal((await admin(s, 'POST', '/work-types', { name: '坏', prefix: 'kf', statuses: [{ name: '新', category: 'todo' }] })).json.error.code, 'INVALID_INPUT');
  assert.match((await admin(s, 'POST', '/work-types', { name: '坏2', prefix: 'BD', statuses: [{ name: '新', category: 'todo' }], fields: [{ name: '选', kind: 'select' }] })).json.error.message, /写几个选项/);

  const item = await work(s, ding, 'POST', '/items', { title: '订单接口', typeId: type.json.id, status: 's3', fields: { f1: '后端', f2: '2026-12-01' } });
  assert.equal(item.status, 200);
  assert.match(item.json.number, /^KF-\d{6}-001$/);
  assert.deepEqual([item.json.statusName, item.json.category, item.json.fields], ['待验收', 'waiting', { f1: '后端', f2: '2026-12-01' }]);
  assert.match((await work(s, ding, 'POST', '/items', { title: '坏字段', typeId: type.json.id, fields: { f1: '运维' } })).json.error.message, /只能选：前端、后端/);

  const statuses = type.json.statuses;
  assert.equal((await admin(s, 'PATCH', `/work-types/${type.json.id}`, { statuses: statuses.filter(status => status.key !== 's3') })).json.error.code, 'IN_USE');
  const moved = await admin(s, 'PATCH', `/work-types/${type.json.id}`, { statuses: statuses.map(status => status.key === 's3' ? { ...status, name: '已验收', category: 'done' } : status) });
  assert.equal(moved.status, 200);
  const after = (await work(s, ding, 'GET', `/items/${item.json.id}`)).json;
  assert.deepEqual([after.statusName, after.category, after.progress, Boolean(after.completedAt)], ['已验收', 'done', 100, true]);

  assert.equal((await admin(s, 'PATCH', `/work-types/${type.json.id}`, { archived: true })).json.archived, true);
  assert.match((await work(s, ding, 'POST', '/items', { title: '停用的类型', typeId: type.json.id })).json.error.message, /已经停用/);
  assert.equal((await work(s, ding, 'GET', '/context')).json.types.length, 1, '员工端只列能用的类型');
  assert.equal((await admin(s, 'DELETE', `/work-types/${type.json.id}`)).json.error.code, 'IN_USE');
  const preset = (await admin(s, 'GET', '/work-types')).json.types.find(entry => entry.prefix === 'RW');
  assert.match((await admin(s, 'PATCH', `/work-types/${preset.id}`, { archived: true })).json.error.message, /至少要留一个/);
});

test('从表格导入：逐行说清问题；默认有问题就一个都不建，选了跳过才只建好的；导入的记在动态里', async t => {
  const { s, ding, wu, geng } = await world(t);
  const type = (await admin(s, 'GET', '/work-types')).json.types[0];
  const disabled = (await admin(s, 'PATCH', `/users/${geng.user.id}`, { status: 'disabled' })).json;
  const rows = [
    { title: '旧系统的事项一', typeId: type.id, status: 'doing', assigneeId: ding.user.id, dueDate: '2026-11-20', progress: 30, sourceNumber: 'DEV-17' },
    { title: '旧系统的事项二', typeId: type.id, status: 'done', assigneeId: wu.user.id, completedAt: '2026-10-01' },
    { title: '负责人已停用', typeId: type.id, status: 'todo', assigneeId: disabled.id },
    { title: '', typeId: type.id, status: 'todo', assigneeId: ding.user.id },
    { title: '状态对不上', typeId: type.id, status: 'nope', assigneeId: ding.user.id },
  ];
  const dry = (await admin(s, 'POST', '/work/import', { rows, dryRun: true })).json;
  assert.deepEqual([dry.created, dry.valid], [0, 2]);
  assert.deepEqual(dry.problems.map(problem => problem.row), [3, 4, 5]);
  assert.match(dry.problems[0].message, /已停用/);
  assert.match(dry.problems[1].message, /^标题：/);
  assert.equal((await admin(s, 'POST', '/work/import', { rows })).json.created, 0, '有问题时默认一个都不建');
  const done = (await admin(s, 'POST', '/work/import', { rows, skipInvalid: true })).json;
  assert.equal(done.created, 2);
  const mine = (await work(s, ding, 'GET', '/items')).json.items;
  assert.deepEqual(mine.map(item => [item.title, item.progress]), [['旧系统的事项一', 30]]);
  const detail = (await work(s, ding, 'GET', `/items/${mine[0].id}`)).json;
  assert.deepEqual([detail.events[0].kind, detail.events[0].via, detail.events[0].comment], ['import', 'import', '从表格导入，原编号 DEV-17']);
  const wuMine = (await work(s, wu, 'GET', '/mine')).json;
  assert.equal(wuMine.summary.doneThisWeek, 0, '导入的旧完成事项不算进本周完成');
  assert.equal((await work(s, ding, 'POST', '/work/import', { rows })).status, 404, '员工端没有导入接口');
});

test('导出：要“导出”权限，只导范围里的；开头像公式的内容加单引号', async t => {
  const { s, ding, geng, bing, yi } = await world(t);
  await work(s, ding, 'POST', '/items', { title: '=SUM(A1:A9)' });
  await work(s, geng, 'POST', '/items', { title: '二组的' });
  assert.equal((await work(s, bing, 'GET', '/export')).json.error.code, 'FORBIDDEN', '小组长没勾导出');
  const csv = await work(s, yi, 'GET', '/export');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.body.startsWith('﻿编号,标题'));
  assert.match(csv.body, /'=SUM\(A1:A9\)/);
  assert.match(csv.body, /二组的/);
  const lines = csv.body.trim().split('\r\n');
  assert.equal(lines.length, 3);
});
