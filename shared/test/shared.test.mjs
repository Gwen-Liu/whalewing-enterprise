import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, normalizeContentPath, parseExpertTemplate, parseInviteLink, parseServerAddress, renderExpertTemplate, schemas } from '../src/index.js';

test('内网地址：10、172.16～31、192.168、本机和 IPv6 内网段', () => {
  for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.10', '127.0.0.1', '::1', 'fd12:3456::1', '::ffff:192.168.0.2']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.64.0.1', '2001:db8::1', 'example.com']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('服务器地址：补上 https，去掉结尾斜杠，带账号密码或 ? 的拒收', () => {
  assert.deepEqual(parseServerAddress('team.example.com/'), { ok: true, origin: 'https://team.example.com', protocol: 'https', hostname: 'team.example.com' });
  assert.equal(parseServerAddress('http://192.168.1.5:8730').origin, 'http://192.168.1.5:8730');
  assert.equal(parseServerAddress('https://a.com/team/').origin, 'https://a.com/team');
  assert.equal(parseServerAddress('ftp://a.com').ok, false);
  assert.equal(parseServerAddress('https://u:p@a.com').ok, false);
  assert.equal(parseServerAddress('https://a.com/?x=1').ok, false);
  assert.equal(parseServerAddress('').ok, false);
});

test('邀请链接：取出服务器地址和邀请码', () => {
  const parsed = parseInviteLink('  https://team.example.com/join/abcdefghijklmnopqrstuvwxyzABCDEF ');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.server.origin, 'https://team.example.com');
  assert.equal(parsed.code, 'abcdefghijklmnopqrstuvwxyzABCDEF');
  assert.equal(parseInviteLink('https://team.example.com/abc').ok, false);
});

test('内容路径：拦住 ..、隐藏文件、Windows 不允许的名字和错的扩展名', () => {
  assert.equal(normalizeContentPath('knowledge', '规范/代码评审.md'), '规范/代码评审.md');
  assert.equal(normalizeContentPath('skill', 'scripts/run.sh'), 'scripts/run.sh');
  for (const bad of ['../a.md', 'a/../b.md', '/a.md', 'a//b.md', '.git/x.md', 'con.md', 'a:b.md', 'a\\b.md', 'a /b.md', 'note.txt']) {
    assert.throws(() => normalizeContentPath('knowledge', bad), error => error.code === 'INVALID_INPUT', bad);
  }
  assert.throws(() => normalizeContentPath('expert', 'other.md'));
});

test('专家模板：和个人版同一种写法，写回再读一致', () => {
  const text = renderExpertTemplate({ name: '售前专家', description: '方案: 投标和汇报', skills: ['whalewing-writing'], prompt: '你是售前专家。' });
  assert.deepEqual(parseExpertTemplate(text), { name: '售前专家', description: '方案: 投标和汇报', skills: ['whalewing-writing'], prompt: '你是售前专家。', avatar: null });
  assert.throws(() => parseExpertTemplate('---\nname: x\n---\n'), /description/);
  assert.throws(() => parseExpertTemplate('---\nname: x\ndescription: y\nother: z\n---\n正文'), /看不懂这一行/);
});

test('接口定义：登录名和密码规则', () => {
  assert.equal(schemas.username.safeParse('zhang.san').success, true);
  assert.equal(schemas.username.safeParse('张三').success, false);
  assert.equal(schemas.password.safeParse('1234567').success, false);
  assert.equal(schemas.publicUrl.safeParse('https://team.example.com').success, true);
  assert.equal(schemas.publicUrl.safeParse('team.example.com').success, false);
});
