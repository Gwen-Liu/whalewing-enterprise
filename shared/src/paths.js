import { LIMITS } from './protocol.js';

// 团队内容的标识：小写字母、数字和短横线，用在网址和本机缓存目录名里。
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Windows 不允许的文件名；员工电脑多是 Windows，缓存要能落盘。
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f\u007f]/;

function fail(message) { return Object.assign(new Error(message), { code: 'INVALID_INPUT' }); }

/**
 * 校验并整理一类内容里的相对路径，返回用 / 连接的路径。
 * knowledge 只放 .md 笔记；expert 只有 expert.md；skill 可以放任意文件，但根目录要有 SKILL.md。
 */
export function normalizeContentPath(kind, raw) {
  if (typeof raw !== 'string' || !raw) throw fail('路径不能为空');
  const text = raw.normalize('NFC');
  if (text.length > LIMITS.pathChars) throw fail(`路径最长 ${LIMITS.pathChars} 个字符`);
  if (text.startsWith('/') || text.endsWith('/')) throw fail('路径不能以 / 开头或结尾');
  const segments = text.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw fail('路径里不能有空的部分、. 或 ..');
    if (segment.length > LIMITS.segmentChars) throw fail(`路径里每一段最长 ${LIMITS.segmentChars} 个字符`);
    if (BAD_CHARS.test(segment)) throw fail('路径里不能有 < > : " | ? * \ 和控制字符');
    if (segment !== segment.trim() || segment.endsWith('.')) throw fail('路径每一段的开头结尾不能是空格，结尾不能是点');
    if (RESERVED.test(segment)) throw fail(`“${segment}”在 Windows 上不能当文件名`);
    if (segment.startsWith('.')) throw fail('不能用以点开头的隐藏文件或目录');
  }
  if (kind === 'knowledge' && !text.toLowerCase().endsWith('.md')) throw fail('团队知识只放 .md 笔记');
  if (kind === 'expert' && text !== 'expert.md') throw fail('专家只有一个文件 expert.md');
  return text;
}

/** 同一目录里只差大小写的两个文件在 Windows 上会撞，用这个键判断。 */
export const pathKey = value => value.normalize('NFC').toLowerCase();
