// 读表格：CSV 和 Excel（.xlsx）都在浏览器里解析，文件不上传到服务端，只发整理好的行。
// .xlsx 是一个 zip，里面是 XML：用 fflate 解开，用浏览器自带的 DOMParser 读第一张工作表。
import { strFromU8, unzipSync } from 'fflate';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 文本文件的编码：先按 UTF-8 读，不是就按 GBK（中文 Excel 另存 CSV 常见）。 */
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return new TextDecoder('gbk').decode(bytes); }
}

/** CSV：支持引号、引号里的换行和逗号；分隔符按第一行猜（逗号、制表符、分号）。 */
export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', '\t', ';'].map(char => [char, firstLine.split(char).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Excel 的日期是从 1899-12-30 起的天数。 */
export function excelSerialToDate(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

const columnIndex = ref => {
  const letters = ref.replace(/\d+$/, '');
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
};

/** .xlsx 的第一张工作表，返回二维数组（都是字符串；日期格式的单元格换成 2026-11-02）。 */
export function readXlsx(buffer) {
  let files;
  try { files = unzipSync(new Uint8Array(buffer)); } catch { throw new Error('读不了这个文件：不是有效的 .xlsx。老的 .xls 请先在 Excel 里另存为 .xlsx 或 CSV'); }
  const xml = name => files[name] ? new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml') : null;
  const all = (node, name) => [...node.getElementsByTagNameNS('*', name)];
  const shared = [];
  const strings = xml('xl/sharedStrings.xml');
  if (strings) for (const item of all(strings, 'si')) shared.push(all(item, 't').map(text => text.textContent).join(''));

  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new Error('这个 .xlsx 里没有工作表');
  const sheet = all(workbook, 'sheet')[0];
  const relationId = sheet?.getAttributeNS(REL_NS, 'id') ?? sheet?.getAttribute('r:id');
  const relation = all(xml('xl/_rels/workbook.xml.rels'), 'Relationship').find(entry => entry.getAttribute('Id') === relationId);
  const target = relation?.getAttribute('Target') ?? 'worksheets/sheet1.xml';
  const sheetXml = xml(target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  if (!sheetXml) throw new Error('这个 .xlsx 里找不到第一张工作表');

  // 哪些单元格样式是日期格式。
  const dateStyles = new Set();
  const styles = xml('xl/styles.xml');
  if (styles) {
    const custom = new Map(all(styles, 'numFmt').map(format => [Number(format.getAttribute('numFmtId')), format.getAttribute('formatCode') ?? '']));
    const cellXfs = all(styles, 'cellXfs')[0];
    if (cellXfs) all(cellXfs, 'xf').forEach((xf, index) => {
      const id = Number(xf.getAttribute('numFmtId') ?? 0);
      const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? '';
      if (BUILTIN_DATE_FORMATS.has(id) || (/[yd]/i.test(code) && !/^[#0.,%]+$/.test(code))) dateStyles.add(index);
    });
  }

  const rows = [];
  for (const rowNode of all(sheetXml, 'row')) {
    const rowIndex = Number(rowNode.getAttribute('r') ?? rows.length + 1) - 1;
    const row = [];
    for (const cell of all(rowNode, 'c')) {
      const ref = cell.getAttribute('r');
      const index = ref ? columnIndex(ref) : row.length;
      const type = cell.getAttribute('t');
      const raw = all(cell, 'v')[0]?.textContent ?? '';
      let value;
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = all(cell, 't').map(text => text.textContent).join('');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = raw;
      else value = raw !== '' && dateStyles.has(Number(cell.getAttribute('s') ?? -1)) ? excelSerialToDate(raw) : raw;
      while (row.length < index) row.push('');
      row[index] = value;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = row;
  }
  return rows;
}

export async function readSheet(file) {
  const buffer = await file.arrayBuffer();
  if (/\.xlsx$/i.test(file.name)) return readXlsx(buffer);
  if (/\.xls$/i.test(file.name)) throw new Error('老的 .xls 格式读不了，请先在 Excel 里另存为 .xlsx 或 CSV');
  return parseCsv(decodeText(buffer));
}

/** 各种写法的日期整理成 2026-11-02；认不出来就原样返回，交给服务端说哪一行不对。 */
export function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{5}(\.\d+)?$/.test(text) && Number(text) > 20000 && Number(text) < 80000) return excelSerialToDate(text);
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T].*)?$/);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

export function normalizeProgress(value) {
  const text = String(value ?? '').trim().replace(/%$/, '');
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number <= 1 && text.includes('.') ? number * 100 : number)));
}
