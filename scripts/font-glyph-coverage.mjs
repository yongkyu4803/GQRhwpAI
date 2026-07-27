// 번들된 웹폰트의 글머리표/도형 글리프 커버리지를 점검합니다.
//
// 왜 필요한가: CanvasKit 은 브라우저 시스템 폰트 폴백을 쓰지 않으므로, 문단에 적용된
// 글꼴의 woff2 에 □(U+25A1) 글리프가 없으면 글머리표가 화면에서 그냥 사라집니다.
// 글머리표 head 는 그 문단의 글꼴을 그대로 따라가므로(실측), "바탕"처럼 도형 글리프가
// 빠진 폰트로 서식을 바꾸면 □·○ 가 안 보입니다.
//
// 이 스크립트는 studio 번들의 (HWP 글꼴 이름 → woff2 파일) 매핑을 읽고, 각 파일의 cmap 을
// 직접 파싱해 커버리지를 표로 출력합니다. studio 번들이나 fonts/ 를 갱신한 뒤 다시 돌려
// src/lib/hwp/font-coverage.ts 의 목록을 맞추세요.
//
//   node scripts/font-glyph-coverage.mjs            # 전체 표
//   node scripts/font-glyph-coverage.mjs --gaps     # 도형 글리프가 빠진 글꼴 이름만
//
// woff2 는 brotli 압축이라 node:zlib 로 풀고, cmap 은 변환되지 않는 테이블이라
// 테이블 디렉터리의 길이만 누적하면 오프셋을 찾을 수 있습니다(glyf/loca 변환은 무관).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO_ASSETS = path.join(ROOT, 'public/studio/assets');

// 점검 대상 문자. 글머리표로 쓰는 도형과, 비교용으로 항상 있는 문자(·, 가).
const CHECK_CHARS = [
  ['□', 0x25a1], ['■', 0x25a0], ['○', 0x25cb], ['●', 0x25cf], ['◦', 0x25e6],
  ['◇', 0x25c7], ['◆', 0x25c6], ['▶', 0x25b6], ['·', 0x00b7], ['가', 0xac00],
];
// 이 문자들이 없으면 "글머리표에 쓸 수 없는 글꼴"로 봅니다.
const BULLET_CRITICAL = [0x25a1, 0x25cb];

// woff2 표준 known-tag 순서 (spec 5.2 Table 3).
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function readUIntBase128(buf, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return [value, pos];
  }
  throw new Error('잘못된 UIntBase128');
}

/** woff2/woff 파일에서 cmap 테이블 버퍼만 뽑아냅니다. */
function readCmapTable(file) {
  const buf = fs.readFileSync(file);
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'wOFF') {
    const numTables = buf.readUInt16BE(12);
    for (let i = 0; i < numTables; i++) {
      const rec = 44 + i * 20;
      if (buf.toString('latin1', rec, rec + 4) !== 'cmap') continue;
      const offset = buf.readUInt32BE(rec + 4);
      const compLength = buf.readUInt32BE(rec + 8);
      const origLength = buf.readUInt32BE(rec + 12);
      const data = buf.subarray(offset, offset + compLength);
      return compLength < origLength ? zlib.inflateSync(data) : data;
    }
    throw new Error('cmap 없음');
  }
  if (tag !== 'wOF2') throw new Error(`알 수 없는 형식: ${tag}`);

  const numTables = buf.readUInt16BE(12);
  let pos = 48;
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos++];
    let name;
    if ((flags & 0x3f) === 0x3f) {
      name = buf.toString('latin1', pos, pos + 4);
      pos += 4;
    } else {
      name = KNOWN_TAGS[flags & 0x3f];
    }
    let origLength;
    [origLength, pos] = readUIntBase128(buf, pos);
    // glyf/loca 는 변환(0)이 기본, 나머지는 무변환(0)이 기본 — 기본이 아니면 변환 길이가 따라옵니다.
    const xform = (flags >> 6) & 0x3;
    let transformLength = null;
    const hasTransformLength = name === 'glyf' || name === 'loca' ? xform === 0 : xform !== 0;
    if (hasTransformLength) [transformLength, pos] = readUIntBase128(buf, pos);
    tables.push({ name, length: transformLength ?? origLength });
  }
  const font = zlib.brotliDecompressSync(buf.subarray(pos));
  let offset = 0;
  for (const table of tables) {
    if (table.name === 'cmap') return font.subarray(offset, offset + table.length);
    offset += table.length;
  }
  throw new Error('cmap 없음');
}

function glyphIdIn(cmap, subtableOffset, code) {
  const format = cmap.readUInt16BE(subtableOffset);
  if (format === 4) {
    const segX2 = cmap.readUInt16BE(subtableOffset + 6);
    const endBase = subtableOffset + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = cmap.readUInt16BE(endBase + i * 2);
      if (code > end) continue;
      const start = cmap.readUInt16BE(startBase + i * 2);
      if (code < start) return 0;
      const delta = cmap.readInt16BE(deltaBase + i * 2);
      const rangeOffset = cmap.readUInt16BE(rangeBase + i * 2);
      if (rangeOffset === 0) return (code + delta) & 0xffff;
      const gid = cmap.readUInt16BE(rangeBase + i * 2 + rangeOffset + (code - start) * 2);
      return gid === 0 ? 0 : (gid + delta) & 0xffff;
    }
    return 0;
  }
  if (format === 12) {
    const groups = cmap.readUInt32BE(subtableOffset + 12);
    for (let i = 0; i < groups; i++) {
      const g = subtableOffset + 16 + i * 12;
      const start = cmap.readUInt32BE(g);
      const end = cmap.readUInt32BE(g + 4);
      if (code >= start && code <= end) return cmap.readUInt32BE(g + 8) + (code - start);
    }
    return 0;
  }
  return 0;
}

/** 파일 하나의 커버리지: { 0x25a1: true, ... } */
function coverageOf(file) {
  const cmap = readCmapTable(file);
  const count = cmap.readUInt16BE(2);
  const unicodeSubtables = [];
  for (let i = 0; i < count; i++) {
    const rec = 4 + i * 8;
    const platform = cmap.readUInt16BE(rec);
    const encoding = cmap.readUInt16BE(rec + 2);
    const offset = cmap.readUInt32BE(rec + 4);
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) unicodeSubtables.push(offset);
  }
  const out = {};
  for (const [, code] of CHECK_CHARS) {
    out[code] = unicodeSubtables.some(offset => glyphIdIn(cmap, offset, code) > 0);
  }
  return out;
}

/** studio 번들에서 (HWP 글꼴 이름 → 폰트 파일/URL) 매핑을 읽습니다. */
function studioFontMap() {
  const assets = fs.readdirSync(STUDIO_ASSETS).filter(f => f.endsWith('.js'));
  const map = new Map();
  for (const asset of assets) {
    const src = fs.readFileSync(path.join(STUDIO_ASSETS, asset), 'utf8');
    // 번들은 `{name:`바탕`,file:`fonts/NotoSerifKR-Regular.woff2`}` 형태이고,
    // CDN 폰트(함초롬 계열)는 file 이 변수라 URL 을 따로 잡아냅니다.
    const cdnVars = new Map();
    for (const m of src.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*`(https:\/\/[^`]+\.woff2?)`/g)) {
      cdnVars.set(m[1], m[2]);
    }
    for (const m of src.matchAll(/\{name:`([^`]+)`,file:(?:`([^`]+)`|(\w+))/g)) {
      const [, name, literal, variable] = m;
      const target = literal ?? cdnVars.get(variable);
      if (target && !map.has(name)) map.set(name, target);
    }
  }
  return map;
}

const gapsOnly = process.argv.includes('--gaps');
const fontMap = studioFontMap();
const cache = new Map();
const rows = [];
const gaps = [];

for (const [name, target] of [...fontMap].sort((a, b) => a[0].localeCompare(b[0], 'ko'))) {
  const isLocal = !target.startsWith('http');
  const file = isLocal ? path.join(ROOT, 'public/studio', target) : null;
  let cov = null;
  let note = '';
  if (!isLocal) {
    note = 'CDN(별도 확인 필요)';
  } else if (!fs.existsSync(file)) {
    note = '파일 없음';
  } else {
    if (!cache.has(file)) {
      try {
        cache.set(file, coverageOf(file));
      } catch (e) {
        cache.set(file, null);
        note = `파싱 실패: ${e.message}`;
      }
    }
    cov = cache.get(file);
  }
  const marks = cov ? CHECK_CHARS.map(([ch, code]) => (cov[code] ? ch : '·')).join('') : note;
  rows.push([name, path.basename(target), marks]);
  if (cov && BULLET_CRITICAL.some(code => !cov[code])) gaps.push(name);
}

if (gapsOnly) {
  console.log(gaps.map(n => `  '${n}',`).join('\n'));
  console.log(`\n// ${gaps.length}개 글꼴에 □(U+25A1) 또는 ○(U+25CB) 글리프가 없습니다.`);
} else {
  console.log(`글꼴 ${rows.length}개 / 검사 문자: ${CHECK_CHARS.map(c => c[0]).join('')}\n`);
  for (const [name, file, marks] of rows) {
    console.log(name.padEnd(20), marks.padEnd(12), file);
  }
  console.log(`\n글머리표에 쓸 수 없는 글꼴(□ 또는 ○ 없음) ${gaps.length}개:\n  ${gaps.join(', ')}`);
}
