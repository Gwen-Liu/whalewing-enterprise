import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { member, server } from './helpers.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const createItem = (s, body) => s.request('POST', '/api/v1/admin/items', { cookie: s.adminCookie, body });
const put = (s, token, url, content, baseHash = null) => s.request('PUT', url, { token, body: { content, baseHash } });

async function setupOrg(s) {
  const dept = name => s.request('POST', '/api/v1/admin/departments', { cookie: s.adminCookie, body: { name, parentId: null } }).then(r => r.json);
  const rd = await dept('研发部');
  const backend = (await s.request('POST', '/api/v1/admin/departments', { cookie: s.adminCookie, body: { name: '后端组', parentId: rd.id } })).json;
  const sales = await dept('销售部');
  const dev = await member(s, { username: 'dev', departmentId: backend.id });
  const seller = await member(s, { username: 'seller', departmentId: sales.id });
  const lead = await member(s, { username: 'lead', departmentId: rd.id });
  return { rd, backend, sales, dev, seller, lead };
}

test('新建的专家和技能自带合规的文件，DSH 和个人版都认', async t => {
  const s = await server(t);
  const expert = await createItem(s, { kind: 'expert', slug: 'presales', title: '售前专家', description: '方案和投标' });
  assert.equal(expert.status, 200);
  assert.equal(expert.json.files, 1);
  const skill = await createItem(s, { kind: 'skill', slug: 'weekly-report', title: '周报', description: '按团队格式写周报' });
  assert.equal(skill.json.files, 1);
  const detail = await s.request('GET', '/api/v1/admin/items/skill/weekly-report', { cookie: s.adminCookie });
  assert.deepEqual(detail.json.files.map(file => file.path), ['SKILL.md']);
  const file = await s.request('GET', '/api/v1/items/skill/weekly-report/files/SKILL.md', { cookie: s.adminCookie });
  assert.match(file.body, /^---\nname: weekly-report\ndescription: "按团队格式写周报"\n---/);
  assert.equal(file.headers['content-security-policy'], "sandbox; default-src 'none'");
  assert.equal((await createItem(s, { kind: 'skill', slug: 'weekly-report', title: '重复' })).json.error.code, 'EXISTS');
  assert.equal((await createItem(s, { kind: 'skill', slug: 'Bad_Slug', title: '坏标识' })).json.error.code, 'INVALID_INPUT');
});

test('可见范围：部门包含下级部门；看不到的一律说不存在；维护人才能改', async t => {
  const s = await server(t);
  const { rd, dev, seller, lead } = await setupOrg(s);
  await createItem(s, { kind: 'knowledge', slug: 'rd-handbook', title: '研发手册',
    access: { view: [{ type: 'department', id: rd.id }], maintain: [{ type: 'user', id: lead.user.id }] } });
  await createItem(s, { kind: 'knowledge', slug: 'company', title: '公司制度' });

  const manifest = async who => (await s.request('GET', '/api/v1/sync', { token: who.token })).json;
  const devView = await manifest(dev);
  assert.deepEqual(devView.items.map(item => item.slug).sort(), ['company', 'rd-handbook'], '后端组属于研发部，能看研发手册');
  assert.equal(devView.items.find(item => item.slug === 'rd-handbook').canMaintain, false);
  assert.deepEqual((await manifest(seller)).items.map(item => item.slug), ['company']);
  assert.equal((await manifest(lead)).items.find(item => item.slug === 'rd-handbook').canMaintain, true);

  const url = '/api/v1/items/knowledge/rd-handbook/files/规范/代码评审.md';
  assert.equal((await put(s, seller.token, url, '# 评审')).json.error.code, 'NOT_FOUND', '看不到的不说有这项');
  assert.equal((await put(s, dev.token, url, '# 评审')).json.error.code, 'FORBIDDEN', '看得到但不是维护人');
  const created = await put(s, lead.token, url, '# 代码评审\n\n两人以上看过才合并。');
  assert.equal(created.status, 200);
  assert.equal(created.json.hash, sha('# 代码评审\n\n两人以上看过才合并。'));

  const read = await s.request('GET', '/api/v1/items/knowledge/rd-handbook/files/' + encodeURIComponent('规范') + '/' + encodeURIComponent('代码评审.md'), { token: dev.token });
  assert.equal(read.status, 200);
  assert.match(read.body, /两人以上/);
  assert.equal((await s.request('GET', '/api/v1/items/knowledge/rd-handbook/files/规范/代码评审.md', { token: seller.token })).status, 404);
});

test('同时改同一篇：后保存的人被拒，不会互相覆盖', async t => {
  const s = await server(t);
  const { lead } = await setupOrg(s);
  await createItem(s, { kind: 'knowledge', slug: 'notes', title: '笔记', access: { view: [{ type: 'all' }], maintain: [{ type: 'all' }] } });
  const url = '/api/v1/items/knowledge/notes/files/a.md';
  const first = await put(s, lead.token, url, '第一版');
  assert.equal((await put(s, lead.token, url, '又新建一次')).json.error.code, 'CONFLICT', '已存在时不能当新建');
  const [a, b] = await Promise.all([put(s, lead.token, url, 'A 改的', first.json.hash), put(s, lead.token, url, 'B 改的', first.json.hash)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await put(s, lead.token, '/api/v1/items/knowledge/notes/files/A.md', '大小写')).json.error.code, 'EXISTS');
  assert.equal((await put(s, lead.token, '/api/v1/items/knowledge/notes/files/b.txt', 'x')).json.error.code, 'INVALID_INPUT');
  assert.equal((await put(s, lead.token, '/api/v1/items/knowledge/notes/files/..%2Fescape.md', 'x')).json.error.code, 'INVALID_INPUT');
  assert.equal((await put(s, lead.token, '/api/v1/items/knowledge/notes/files/con.md', 'x')).json.error.code, 'INVALID_INPUT');

  const latest = (await s.request('GET', '/api/v1/sync', { token: lead.token })).json.items[0].files[0];
  const stale = await s.request('DELETE', `${url}?baseHash=${first.json.hash}`, { token: lead.token });
  assert.equal(stale.json.error.code, 'CONFLICT');
  assert.equal((await s.request('DELETE', `${url}?baseHash=${latest.hash}`, { token: lead.token })).status, 200);
});

test('专家文件要是合规的专家模板；技能的 SKILL.md 名字要和标识一样', async t => {
  const s = await server(t);
  await createItem(s, { kind: 'expert', slug: 'pm', title: '产品专家' });
  await createItem(s, { kind: 'skill', slug: 'review', title: '评审' });
  const expertUrl = '/api/v1/items/expert/pm/files/expert.md';
  const current = (await s.request('GET', '/api/v1/sync', { cookie: s.adminCookie })).json.items.find(item => item.slug === 'pm').files[0].hash;
  const bad = await s.request('PUT', expertUrl, { cookie: s.adminCookie, body: { content: '没有开头', baseHash: current } });
  assert.match(bad.json.error.message, /专家模板格式不对/);
  const good = await s.request('PUT', expertUrl, { cookie: s.adminCookie, body: { content: '---\nname: 产品专家\ndescription: 写需求\nskills:\n  - whalewing-writing\n---\n你是产品专家。', baseHash: current } });
  assert.equal(good.status, 200);
  assert.equal((await s.request('DELETE', `${expertUrl}?baseHash=${good.json.hash}`, { cookie: s.adminCookie })).json.error.code, 'INVALID_INPUT');

  const skillHash = (await s.request('GET', '/api/v1/sync', { cookie: s.adminCookie })).json.items.find(item => item.slug === 'review').files[0].hash;
  const wrongName = await s.request('PUT', '/api/v1/items/skill/review/files/SKILL.md', { cookie: s.adminCookie, body: { content: '---\nname: other\ndescription: x\n---\n', baseHash: skillHash } });
  assert.match(wrongName.json.error.message, /name: review/);
});

test('上传技能压缩包：外面多一层目录也认，整体替换；路径不对、缺 SKILL.md 都拒收', async t => {
  const s = await server(t);
  await createItem(s, { kind: 'skill', slug: 'deploy', title: '发布' });
  const upload = files => s.request('POST', '/api/v1/admin/items/skill/deploy/archive', { cookie: s.adminCookie, body: { archive: Buffer.from(zipSync(files)).toString('base64') } });
  const ok = await upload({ 'deploy/SKILL.md': strToU8('---\nname: deploy\ndescription: 发布流程\n---\n先测试再发布。'), 'deploy/scripts/check.sh': strToU8('echo ok') });
  assert.equal(ok.status, 200);
  const files = (await s.request('GET', '/api/v1/admin/items/skill/deploy', { cookie: s.adminCookie })).json.files.map(file => file.path);
  assert.deepEqual(files, ['SKILL.md', 'scripts/check.sh']);

  const replaced = await upload({ 'SKILL.md': strToU8('---\nname: deploy\ndescription: 新流程\n---\n新的。') });
  assert.equal(replaced.json.files, 1, '压缩包里没有的文件被删掉');
  assert.equal((await upload({ 'README.md': strToU8('x') })).json.error.message, '压缩包的根目录要有 SKILL.md');
  assert.equal((await upload({ 'SKILL.md': strToU8('---\nname: deploy\ndescription: x\n---\n'), '../evil.sh': strToU8('x') })).json.error.code, 'INVALID_INPUT');
  const notZip = await s.request('POST', '/api/v1/admin/items/skill/deploy/archive', { cookie: s.adminCookie, body: { archive: Buffer.from('not a zip').toString('base64') } });
  assert.equal(notZip.json.error.message, '这不是有效的 zip 压缩包');
});

test('同步清单带 ETag：没变化时返回 304；改了可见范围后看不到的马上从清单里消失', async t => {
  const s = await server(t);
  const { seller } = await setupOrg(s);
  await createItem(s, { kind: 'knowledge', slug: 'open', title: '公开' });
  const first = await s.request('GET', '/api/v1/sync', { token: seller.token });
  assert.equal(first.json.items.length, 1);
  const again = await s.request('GET', '/api/v1/sync', { token: seller.token, headers: { 'if-none-match': first.headers.etag } });
  assert.equal(again.status, 304);
  await s.request('PATCH', '/api/v1/admin/items/knowledge/open', { cookie: s.adminCookie, body: { access: { view: [], maintain: [] } } });
  const after = await s.request('GET', '/api/v1/sync', { token: seller.token, headers: { 'if-none-match': first.headers.etag } });
  assert.equal(after.status, 200);
  assert.deepEqual(after.json.items, []);
});

test('删除内容项连文件一起删', async t => {
  const s = await server(t);
  await createItem(s, { kind: 'skill', slug: 'temp', title: '临时' });
  assert.equal((await s.request('DELETE', '/api/v1/admin/items/skill/temp', { cookie: s.adminCookie })).status, 200);
  assert.equal((await s.request('GET', '/api/v1/items/skill/temp/files/SKILL.md', { cookie: s.adminCookie })).status, 404);
  assert.equal((await s.request('GET', '/api/v1/admin/items', { cookie: s.adminCookie })).json.items.length, 0);
});
