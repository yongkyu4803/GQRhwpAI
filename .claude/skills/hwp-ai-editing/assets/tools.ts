import 'server-only';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { HwpDocument } from '@rhwp/core';

// 문서 인스턴스를 홀더로 감쌉니다. 편집이 일어나면 dirty 를 세워 라우트가
// 턴 종료 후 문서를 export 해 클라이언트로 되돌려 보낼지 판단합니다.
export type DocHolder = { doc: HwpDocument; dirty: boolean };

const MAX_PARAGRAPHS_PER_READ = 40;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value));
}

function parseOk(raw: string): boolean {
  try {
    return JSON.parse(raw)?.ok === true;
  } catch {
    return false;
  }
}

/** 한 문단의 전체 텍스트를 안전하게 읽습니다. */
function readParagraph(doc: HwpDocument, section: number, para: number): string {
  const len = doc.getParagraphLength(section, para);
  return len > 0 ? doc.getTextRange(section, para, 0, len) : '';
}

type TableRef = { section: number; paragraph: number; controlIdx: number; rows: number; cols: number };

// core 에는 "표 목록" API 가 없습니다. 각 문단의 컨트롤 수(getControlTextPositions
// 배열 길이)만큼 control_idx 를 훑으며 getTableDimensions 가 성공하는 것만 표로 간주합니다.
function controlCount(doc: HwpDocument, section: number, para: number): number {
  try {
    const arr = JSON.parse(doc.getControlTextPositions(section, para));
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function tableDimsAt(doc: HwpDocument, section: number, para: number, controlIdx: number): { rows: number; cols: number } | null {
  try {
    const d = JSON.parse(doc.getTableDimensions(section, para, controlIdx));
    if (d?.rowCount && d?.colCount) return { rows: d.rowCount, cols: d.colCount };
  } catch {
    /* 이 control_idx 는 표가 아님 */
  }
  return null;
}

/** 한 문단 안의 표들을 열거합니다. */
function tablesInParagraph(doc: HwpDocument, section: number, para: number): TableRef[] {
  const out: TableRef[] = [];
  const n = controlCount(doc, section, para);
  for (let ci = 0; ci < n; ci++) {
    const dim = tableDimsAt(doc, section, para, ci);
    if (dim) out.push({ section, paragraph: para, controlIdx: ci, ...dim });
  }
  return out;
}

/** 문서 전체의 표를 열거합니다. */
function listAllTables(doc: HwpDocument): TableRef[] {
  const out: TableRef[] = [];
  const sectionCount = doc.getSectionCount();
  for (let s = 0; s < sectionCount; s++) {
    const pc = doc.getParagraphCount(s);
    for (let p = 0; p < pc; p++) out.push(...tablesInParagraph(doc, s, p));
  }
  return out;
}

// (section, paragraph, controlIdx?) 로 표 하나를 찾습니다. controlIdx 생략 시 첫 표.
function findTable(doc: HwpDocument, section: number, para: number, controlIdx?: number): TableRef | undefined {
  const inPara = tablesInParagraph(doc, section, para);
  return controlIdx === undefined ? inPara[0] : inPara.find(t => t.controlIdx === controlIdx);
}

// ── 병합-aware 셀 매핑 ──
// 병합이 있으면 cellIdx = 행×열수 + 열 공식이 깨집니다(cellCount ≠ 행×열).
// getTableCellBboxes 가 모든 셀의 {cellIdx,row,col,rowSpan,colSpan} 를 주므로 이를 진짜 매핑으로 씁니다.
type CellRef = { cellIdx: number; row: number; col: number; rowSpan: number; colSpan: number };

function tableCells(doc: HwpDocument, ref: TableRef): CellRef[] {
  // 1순위: getTableCellBboxes (전체 셀 매핑 + 병합 span)
  try {
    const arr = JSON.parse(doc.getTableCellBboxes(ref.section, ref.paragraph, ref.controlIdx));
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map((b: { cellIdx: number; row: number; col: number; rowSpan?: number; colSpan?: number }) => ({
        cellIdx: b.cellIdx,
        row: b.row,
        col: b.col,
        rowSpan: b.rowSpan ?? 1,
        colSpan: b.colSpan ?? 1,
      }));
    }
  } catch {
    /* 폴백으로 */
  }
  // 2순위: getCellInfo 를 cellIdx 0..cellCount 로 순회
  const out: CellRef[] = [];
  let cellCount = ref.rows * ref.cols;
  try {
    const d = JSON.parse(doc.getTableDimensions(ref.section, ref.paragraph, ref.controlIdx));
    if (d?.cellCount) cellCount = d.cellCount;
  } catch { /* 기본값 */ }
  for (let ci = 0; ci < cellCount; ci++) {
    try {
      const i = JSON.parse(doc.getCellInfo(ref.section, ref.paragraph, ref.controlIdx, ci));
      out.push({ cellIdx: ci, row: i.row, col: i.col, rowSpan: i.rowSpan ?? 1, colSpan: i.colSpan ?? 1 });
    } catch { /* 건너뜀 */ }
  }
  return out;
}

// (row,col) 을 실제 cellIdx 로 해석합니다. 병합 셀은 span 범위 안의 위치를 anchor 셀로 매핑.
function resolveCellIdx(cells: CellRef[], row: number, col: number): number | null {
  const hit = cells.find(c => row >= c.row && row < c.row + c.rowSpan && col >= c.col && col < c.col + c.colSpan);
  return hit ? hit.cellIdx : null;
}

// 셀은 여러 문단을 가질 수 있으므로(한 셀에 십수 문단인 경우도 있음) 문단별로 읽어 합칩니다.
function readCell(doc: HwpDocument, section: number, para: number, controlIdx: number, cellIdx: number): string {
  let n = 1;
  try {
    n = doc.getCellParagraphCount(section, para, controlIdx, cellIdx) || 1;
  } catch {
    /* 기본 1문단으로 처리 */
  }
  const parts: string[] = [];
  for (let cp = 0; cp < n; cp++) {
    try {
      const len = doc.getCellParagraphLength(section, para, controlIdx, cellIdx, cp);
      parts.push(len > 0 ? doc.getTextInCell(section, para, controlIdx, cellIdx, cp, 0, len) : '');
    } catch {
      parts.push('');
    }
  }
  return parts.join('\n');
}

// 셀 하나의 텍스트를 완전히 교체합니다(모든 문단 비우고 첫 문단에 새 텍스트).
function replaceCellText(doc: HwpDocument, ref: TableRef, cellIdx: number, text: string): { ok: boolean; note?: string } {
  let n = 1;
  try { n = doc.getCellParagraphCount(ref.section, ref.paragraph, ref.controlIdx, cellIdx) || 1; } catch { /* 1 */ }
  for (let cp = 0; cp < n; cp++) {
    try {
      const len = doc.getCellParagraphLength(ref.section, ref.paragraph, ref.controlIdx, cellIdx, cp);
      if (len > 0) doc.deleteTextInCell(ref.section, ref.paragraph, ref.controlIdx, cellIdx, cp, 0, len);
    } catch { /* 건너뜀 */ }
  }
  let ok = true;
  if (text.length > 0) {
    ok = parseOk(doc.insertTextInCell(ref.section, ref.paragraph, ref.controlIdx, cellIdx, 0, 0, text));
  }
  return { ok, note: n > 1 ? `셀에 문단 ${n}개가 있어 모두 비우고 첫 문단에 새 텍스트를 넣었습니다(빈 문단은 남을 수 있음).` : undefined };
}

// 글자 서식 입력(모두 선택). fontSize 는 사용자 친화적으로 pt 단위로 받습니다.
const FORMAT_FIELDS = {
  fontName: z.string().optional().describe('글꼴 이름 (예: "맑은 고딕"). 한글·라틴 글자에 적용됩니다.'),
  fontSize: z.number().positive().max(300).optional().describe('글자 크기 (pt, 예: 20)'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe('글자 색 (#RRGGBB)'),
  align: z.enum(['left', 'center', 'right', 'justify']).optional().describe('문단 정렬 (left/center/right/justify)'),
};

type Align = 'left' | 'center' | 'right' | 'justify';
type FormatInput = {
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  align?: Align;
};

// core 의 props_json 을 만듭니다. fontSize 는 pt×100, 글꼴은 findOrCreateFontId 로 ID 화.
function buildCharProps(doc: HwpDocument, f: FormatInput): { props: Record<string, unknown>; applied: string[] } {
  const props: Record<string, unknown> = {};
  const applied: string[] = [];
  if (f.fontName) {
    const id = doc.findOrCreateFontId(f.fontName);
    if (id >= 0) {
      props.fontId = id;
      applied.push(`글꼴=${f.fontName}`);
    }
  }
  if (f.fontSize !== undefined) {
    props.fontSize = Math.round(f.fontSize * 100); // pt → 1/100 pt
    applied.push(`크기=${f.fontSize}pt`);
  }
  if (f.bold !== undefined) { props.bold = f.bold; applied.push(`굵게=${f.bold}`); }
  if (f.italic !== undefined) { props.italic = f.italic; applied.push(`기울임=${f.italic}`); }
  if (f.underline !== undefined) { props.underline = f.underline; applied.push(`밑줄=${f.underline}`); }
  if (f.color) {
    props.textColor = f.color.startsWith('#') ? f.color : `#${f.color}`;
    applied.push(`색=${props.textColor}`);
  }
  return { props, applied };
}

function normalizeHex(c: string): string {
  return c.startsWith('#') ? c : `#${c}`;
}

/**
 * HWP 문서 편집 도구. 문서는 브라우저가 아니라 서버의 HwpDocument 인스턴스(holder.doc)에
 * 있으며, 도구는 인프로세스로 이 인스턴스를 조회·편집합니다.
 */
export function createHwpToolServer(holder: DocHolder) {
  // 셀 하나의 모든 문단에 글자 서식을 적용합니다.
  function formatCellRuns(ref: TableRef, cellIdx: number, propsJson: string): boolean {
    const doc = holder.doc;
    let n = 1;
    try { n = doc.getCellParagraphCount(ref.section, ref.paragraph, ref.controlIdx, cellIdx) || 1; } catch { /* 1 */ }
    let anyOk = false;
    for (let cp = 0; cp < n; cp++) {
      try {
        const len = doc.getCellParagraphLength(ref.section, ref.paragraph, ref.controlIdx, cellIdx, cp);
        if (len <= 0) continue;
        if (parseOk(doc.applyCharFormatInCell(ref.section, ref.paragraph, ref.controlIdx, cellIdx, cp, 0, len, propsJson))) anyOk = true;
      } catch { /* 건너뜀 */ }
    }
    return anyOk;
  }

  // 셀 하나의 모든 문단에 정렬을 적용합니다.
  function alignCellParas(ref: TableRef, cellIdx: number, alignment: Align): boolean {
    const doc = holder.doc;
    let n = 1;
    try { n = doc.getCellParagraphCount(ref.section, ref.paragraph, ref.controlIdx, cellIdx) || 1; } catch { /* 1 */ }
    const propsJson = JSON.stringify({ alignment });
    let anyOk = false;
    for (let cp = 0; cp < n; cp++) {
      try {
        if (parseOk(doc.applyParaFormatInCell(ref.section, ref.paragraph, ref.controlIdx, cellIdx, cp, propsJson))) anyOk = true;
      } catch { /* 건너뜀 */ }
    }
    return anyOk;
  }

  // 셀 테두리/배경: HWP 는 둘을 하나의 borderFill 로 관리합니다. 배경은 테두리와 같은 호출에
  // 있을 때만 반영되고, 테두리만 바꾸면 배경이 사라질 수 있어 항상 현재 값을 읽어 함께 재전송합니다.
  type BorderLine = { type: number; width: number; color: string };
  function writeCellBorderFill(
    ref: TableRef,
    cellIdx: number,
    opts: { sides?: Array<'top' | 'right' | 'bottom' | 'left'>; line?: BorderLine; fillColor?: string | null },
  ): boolean {
    const doc = holder.doc;
    let cur: Record<string, unknown>;
    try {
      cur = JSON.parse(doc.getCellProperties(ref.section, ref.paragraph, ref.controlIdx, cellIdx));
    } catch {
      return false;
    }
    const props: Record<string, unknown> = {
      borderTop: cur.borderTop,
      borderRight: cur.borderRight,
      borderBottom: cur.borderBottom,
      borderLeft: cur.borderLeft,
      fillType: cur.fillType,
      fillColor: cur.fillColor,
    };
    if (opts.line && opts.sides) {
      for (const side of opts.sides) {
        props[`border${side[0].toUpperCase()}${side.slice(1)}`] = opts.line;
      }
    }
    if (opts.fillColor !== undefined) {
      if (opts.fillColor === null) props.fillType = 'none';
      else { props.fillType = 'solid'; props.fillColor = opts.fillColor; }
    }
    return parseOk(doc.setCellProperties(ref.section, ref.paragraph, ref.controlIdx, cellIdx, JSON.stringify(props)));
  }

  // 대상 셀 cellIdx 목록: (row,col) 지정 시 병합-aware 해석으로 한 칸, 둘 다 생략 시 표 전체(anchor 셀들).
  function targetCellIdxs(ref: TableRef, row?: number, col?: number): { ids: number[] } | { error: string } {
    const cells = tableCells(holder.doc, ref);
    if (row === undefined && col === undefined) {
      return { ids: cells.map(c => c.cellIdx) };
    }
    if (row === undefined || col === undefined) {
      return { error: 'row 와 col 은 함께 지정하거나 둘 다 생략(표 전체)해야 합니다.' };
    }
    const idx = resolveCellIdx(cells, row, col);
    if (idx === null) return { error: `칸 (${row},${col}) 없음 — 표 크기 ${ref.rows}×${ref.cols}(병합 포함).` };
    return { ids: [idx] };
  }

  // ────────────────── 읽기 도구 ──────────────────

  const getDocumentInfo = tool(
    'get_document_info',
    '현재 열린 HWP 문서의 구조 요약을 반환합니다. 구역(section) 수, 각 구역의 문단 수, 페이지 수, 사용 글꼴 등. 편집·읽기 전에 문서 구조를 파악할 때 먼저 호출하세요.',
    {},
    async () => {
      const doc = holder.doc;
      const info = JSON.parse(doc.getDocumentInfo());
      const sectionCount = doc.getSectionCount();
      const sections = [];
      for (let s = 0; s < sectionCount; s++) {
        sections.push({ section: s, paragraphCount: doc.getParagraphCount(s) });
      }
      return jsonResult({ ...info, sections });
    },
  );

  const readParagraphs = tool(
    'read_paragraphs',
    `지정한 구역의 문단 텍스트를 읽습니다. 좌표계는 구역(section) → 문단(paragraph, 0-기반) → 글자 오프셋입니다. 한 번에 최대 ${MAX_PARAGRAPHS_PER_READ}개 문단까지 반환합니다.`,
    {
      section: z.number().int().min(0).describe('구역 인덱스 (0-기반)'),
      start: z.number().int().min(0).describe('시작 문단 인덱스 (0-기반)'),
      count: z.number().int().min(1).max(MAX_PARAGRAPHS_PER_READ).optional().describe(`읽을 문단 수 (기본·최대 ${MAX_PARAGRAPHS_PER_READ})`),
    },
    async (args) => {
      const doc = holder.doc;
      const sectionCount = doc.getSectionCount();
      if (args.section >= sectionCount) {
        return { ...textResult(`구역 ${args.section} 없음 (총 ${sectionCount}개).`), isError: true };
      }
      const paraCount = doc.getParagraphCount(args.section);
      if (args.start >= paraCount) {
        return { ...textResult(`문단 ${args.start} 없음 (구역 ${args.section}에 총 ${paraCount}개).`), isError: true };
      }
      const count = Math.min(args.count ?? MAX_PARAGRAPHS_PER_READ, paraCount - args.start);
      const paragraphs = [];
      for (let i = 0; i < count; i++) {
        const p = args.start + i;
        const entry: { paragraph: number; text: string; tables?: Array<{ controlIdx: number; rows: number; cols: number }> } = {
          paragraph: p,
          text: readParagraph(doc, args.section, p),
        };
        const tables = tablesInParagraph(doc, args.section, p);
        if (tables.length > 0) entry.tables = tables.map(t => ({ controlIdx: t.controlIdx, rows: t.rows, cols: t.cols }));
        paragraphs.push(entry);
      }
      return jsonResult({
        section: args.section,
        paragraphCount: paraCount,
        returned: { start: args.start, count },
        paragraphs,
        hint: '표(tables)가 표시된 문단의 셀 내용은 read_table 로 읽으세요.',
      });
    },
  );

  const searchText = tool(
    'search_text',
    '본문에서 문자열을 검색해 위치(구역·문단·글자 오프셋)를 반환합니다. 표 셀 안은 찾지 못합니다 — 표까지 포함해 찾으려면 find_text 를 쓰세요.',
    {
      query: z.string().min(1).describe('검색할 문자열'),
      caseSensitive: z.boolean().optional().describe('대소문자 구분 (기본 false)'),
    },
    async (args) => {
      const doc = holder.doc;
      const hit = JSON.parse(doc.searchText(args.query, 0, 0, 0, true, args.caseSensitive ?? false)) as {
        found: boolean; sec?: number; para?: number; charOffset?: number; length?: number;
      };
      if (!hit.found || hit.sec === undefined || hit.para === undefined) return jsonResult({ found: false });
      return jsonResult({
        found: true, section: hit.sec, paragraph: hit.para, charOffset: hit.charOffset, length: hit.length,
        paragraphText: readParagraph(doc, hit.sec, hit.para),
      });
    },
  );

  const findText = tool(
    'find_text',
    '본문과 표 셀 전체에서 문자열을 찾아 위치 목록을 반환합니다(본문 검색이 못 닿는 표 셀까지 포함). 표 안 내용을 찾아 고칠 때 사용하세요. 셀 매치는 (구역·문단·controlIdx·행·열)을 주므로 set_cell 로 편집할 수 있습니다.',
    {
      query: z.string().min(1).describe('찾을 문자열'),
      caseSensitive: z.boolean().optional().describe('대소문자 구분 (기본 false)'),
    },
    async (args) => {
      const doc = holder.doc;
      const cs = args.caseSensitive ?? false;
      const needle = cs ? args.query : args.query.toLowerCase();
      const has = (s: string) => (cs ? s : s.toLowerCase()).includes(needle);
      const MAX = 50;
      const bodyMatches: Array<{ section: number; paragraph: number; text: string }> = [];
      const cellMatches: Array<{ section: number; paragraph: number; controlIdx: number; row: number; col: number; text: string }> = [];

      const sectionCount = doc.getSectionCount();
      outer:
      for (let s = 0; s < sectionCount; s++) {
        const pc = doc.getParagraphCount(s);
        for (let p = 0; p < pc; p++) {
          const t = readParagraph(doc, s, p);
          if (t && has(t)) {
            bodyMatches.push({ section: s, paragraph: p, text: t.slice(0, 120) });
            if (bodyMatches.length + cellMatches.length >= MAX) break outer;
          }
          for (const ref of tablesInParagraph(doc, s, p)) {
            for (const cell of tableCells(doc, ref)) {
              const ct = readCell(doc, ref.section, ref.paragraph, ref.controlIdx, cell.cellIdx);
              if (ct && has(ct)) {
                cellMatches.push({ section: s, paragraph: p, controlIdx: ref.controlIdx, row: cell.row, col: cell.col, text: ct.slice(0, 120) });
                if (bodyMatches.length + cellMatches.length >= MAX) break outer;
              }
            }
          }
        }
      }
      return jsonResult({
        query: args.query,
        bodyMatches,
        cellMatches,
        truncated: bodyMatches.length + cellMatches.length >= MAX,
      });
    },
  );

  // ────────────────── 본문 편집 도구 ──────────────────

  const insertText = tool(
    'insert_text',
    '지정한 위치(구역·문단·글자 오프셋)에 텍스트를 삽입합니다. 오프셋 0-기반. 편집 전 해당 문단을 읽어 위치를 확인하세요. 표 셀에는 set_cell 을 쓰세요.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), charOffset: z.number().int().min(0), text: z.string().min(1) },
    async (args) => {
      const raw = holder.doc.insertText(args.section, args.paragraph, args.charOffset, args.text);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const deleteRange = tool(
    'delete_range',
    '구역 내 [시작 문단·오프셋, 끝 문단·오프셋) 범위의 본문 내용을 삭제합니다. 오프셋 0-기반. 삭제 전 대상 범위를 읽어 확인하세요.',
    { section: z.number().int().min(0), startParagraph: z.number().int().min(0), startOffset: z.number().int().min(0), endParagraph: z.number().int().min(0), endOffset: z.number().int().min(0) },
    async (args) => {
      const raw = holder.doc.deleteRange(args.section, args.startParagraph, args.startOffset, args.endParagraph, args.endOffset);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const replaceText = tool(
    'replace_text',
    '본문에서 문자열을 찾아 교체합니다(첫 일치). 표 셀 안은 대상이 아닙니다 — 표는 find_text 로 찾아 set_cell 로 고치세요.',
    { query: z.string().min(1), replacement: z.string(), caseSensitive: z.boolean().optional() },
    async (args) => {
      const doc = holder.doc;
      const hit = JSON.parse(doc.searchText(args.query, 0, 0, 0, true, args.caseSensitive ?? false)) as {
        found: boolean; sec?: number; para?: number; charOffset?: number; length?: number;
      };
      if (!hit.found || hit.sec === undefined || hit.para === undefined || hit.charOffset === undefined || hit.length === undefined) {
        return { ...jsonResult({ ok: false, reason: 'not_found', query: args.query }), isError: true };
      }
      const del = doc.deleteText(hit.sec, hit.para, hit.charOffset, hit.length);
      if (!parseOk(del)) return { ...textResult(del), isError: true };
      let ok = true;
      if (args.replacement.length > 0) {
        ok = parseOk(doc.insertText(hit.sec, hit.para, hit.charOffset, args.replacement));
      }
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: hit.sec, paragraph: hit.para, replaced: args.query, with: args.replacement, paragraphText: readParagraph(doc, hit.sec, hit.para) });
    },
  );

  // ────────────────── 표: 생성·읽기 ──────────────────

  const insertTable = tool(
    'insert_table',
    '지정한 위치에 rows×cols 표를 삽입합니다. cells 를 주면 각 칸을 채웁니다(행 우선: cells[행][열]). 새 표는 병합이 없으므로 격자 인덱싱이 안전합니다.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0).describe('표를 넣을 문단 인덱스'),
      charOffset: z.number().int().min(0).describe('삽입 글자 오프셋 (보통 0)'),
      rows: z.number().int().min(1).max(50),
      cols: z.number().int().min(1).max(20),
      cells: z.array(z.array(z.string())).optional().describe('칸 내용 2차원 배열 [행][열]. 생략 시 빈 표.'),
    },
    async (args) => {
      const doc = holder.doc;
      const raw = doc.createTable(args.section, args.paragraph, args.charOffset, args.rows, args.cols);
      let created: { ok?: boolean; paraIdx?: number; controlIdx?: number } | null = null;
      try { created = JSON.parse(raw); } catch { /* null */ }
      if (!created?.ok || created.paraIdx === undefined || created.controlIdx === undefined) {
        return { ...textResult(raw), isError: true };
      }
      holder.dirty = true;
      const filled: string[] = [];
      if (args.cells) {
        for (let r = 0; r < args.rows; r++) {
          for (let c = 0; c < args.cols; c++) {
            const text = args.cells[r]?.[c];
            if (!text) continue;
            const ins = doc.insertTextInCell(args.section, created.paraIdx, created.controlIdx, r * args.cols + c, 0, 0, text);
            if (parseOk(ins)) filled.push(`(${r},${c})`);
          }
        }
      }
      return jsonResult({ ok: true, section: args.section, paragraph: created.paraIdx, controlIdx: created.controlIdx, rows: args.rows, cols: args.cols, filled });
    },
  );

  const listTables = tool(
    'list_tables',
    '문서 전체의 표 목록을 반환합니다. 각 표의 위치(구역·문단·controlIdx), 크기(행×열), 병합 여부, 그리고 첫 행 미리보기(headerPreview)를 함께 주어 "예산 표" 같이 내용으로 표를 찾을 수 있게 합니다.',
    {},
    async () => {
      const doc = holder.doc;
      const tables = listAllTables(doc).map(ref => {
        const cells = tableCells(doc, ref);
        const merged = cells.some(c => c.rowSpan > 1 || c.colSpan > 1);
        const headerPreview = cells
          .filter(c => c.row === 0)
          .sort((a, b) => a.col - b.col)
          .map(c => readCell(doc, ref.section, ref.paragraph, ref.controlIdx, c.cellIdx).replace(/\n/g, ' ').slice(0, 24));
        return { section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, rows: ref.rows, cols: ref.cols, merged, headerPreview };
      });
      return jsonResult({ count: tables.length, tables });
    },
  );

  const readTable = tool(
    'read_table',
    '표의 모든 셀을 반환합니다. 병합을 고려해 각 셀의 (행·열·rowSpan·colSpan·텍스트) 목록(cells)으로 줍니다. 편집은 이 (행,열)을 set_cell/format_cell 등에 그대로 쓰면 됩니다. controlIdx 생략 시 해당 문단의 첫 표.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional() },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      const cells = tableCells(doc, ref).map(c => ({
        row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
        text: readCell(doc, ref.section, ref.paragraph, ref.controlIdx, c.cellIdx),
      }));
      return jsonResult({ section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, rows: ref.rows, cols: ref.cols, merged: cells.some(c => c.rowSpan > 1 || c.colSpan > 1), cells });
    },
  );

  // ────────────────── 표: 셀 내용 편집 ──────────────────

  const setCell = tool(
    'set_cell',
    '표의 특정 칸(행·열, 0-기반) 내용을 새 텍스트로 교체합니다. 병합 셀도 올바르게 처리하며, 병합된 칸은 그 영역 아무 (행,열)로 지정해도 됩니다. 편집 전 read_table 로 현재 값을 확인하세요.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0), col: z.number().int().min(0),
      text: z.string().describe('셀에 넣을 텍스트 (빈 문자열이면 비움)'),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      const cellIdx = resolveCellIdx(tableCells(doc, ref), args.row, args.col);
      if (cellIdx === null) return { ...textResult(`칸 (${args.row},${args.col}) 없음 — 표 크기 ${ref.rows}×${ref.cols}(병합 포함).`), isError: true };
      const { ok, note } = replaceCellText(doc, ref, cellIdx, args.text);
      if (!ok) return { ...textResult('셀 텍스트 교체 실패.'), isError: true };
      holder.dirty = true;
      return jsonResult({ ok: true, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, row: args.row, col: args.col, text: args.text, note });
    },
  );

  // ────────────────── 표: 구조 편집 ──────────────────

  const addTableRow = tool(
    'add_table_row',
    '표에 행을 추가합니다. atRow 기준으로 above/below 위치에 삽입합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      atRow: z.number().int().min(0).describe('기준 행 (0-기반)'),
      position: z.enum(['above', 'below']).optional().describe('기본 below'),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const raw = doc.insertTableRow(ref.section, ref.paragraph, ref.controlIdx, args.atRow, (args.position ?? 'below') === 'below');
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const addTableColumn = tool(
    'add_table_column',
    '표에 열을 추가합니다. atCol 기준으로 left/right 위치에 삽입합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      atCol: z.number().int().min(0).describe('기준 열 (0-기반)'),
      position: z.enum(['left', 'right']).optional().describe('기본 right'),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const raw = doc.insertTableColumn(ref.section, ref.paragraph, ref.controlIdx, args.atCol, (args.position ?? 'right') === 'right');
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const deleteTableRow = tool(
    'delete_table_row',
    '표의 특정 행을 삭제합니다.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(), row: z.number().int().min(0) },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const raw = doc.deleteTableRow(ref.section, ref.paragraph, ref.controlIdx, args.row);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const deleteTableColumn = tool(
    'delete_table_column',
    '표의 특정 열을 삭제합니다.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(), col: z.number().int().min(0) },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const raw = doc.deleteTableColumn(ref.section, ref.paragraph, ref.controlIdx, args.col);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const deleteTable = tool(
    'delete_table',
    '표 전체를 삭제합니다. 되돌릴 수 없으니 대상 표를 read_table/list_tables 로 먼저 확인하세요.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional() },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const raw = doc.deleteTableControl(ref.section, ref.paragraph, ref.controlIdx);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  // ────────────────── 서식 ──────────────────

  const formatText = tool(
    'format_text',
    '본문 문단의 서식(글꼴·크기·굵게·기울임·밑줄·색)과 문단 정렬(align)을 바꿉니다. 오프셋 생략 시 문단 전체. 표 셀에는 format_cell 을 쓰세요.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0),
      startOffset: z.number().int().min(0).optional(), endOffset: z.number().int().min(0).optional(),
      ...FORMAT_FIELDS,
    },
    async (args) => {
      const doc = holder.doc;
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return { ...textResult('적용할 서식이 지정되지 않았습니다.'), isError: true };
      let ok = true;
      if (applied.length > 0) {
        const len = doc.getParagraphLength(args.section, args.paragraph);
        ok = parseOk(doc.applyCharFormat(args.section, args.paragraph, args.startOffset ?? 0, args.endOffset ?? len, JSON.stringify(props))) && ok;
      }
      if (args.align) {
        ok = parseOk(doc.applyParaFormat(args.section, args.paragraph, JSON.stringify({ alignment: args.align }))) && ok;
        applied.push(`정렬=${args.align}`);
      }
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: args.section, paragraph: args.paragraph, applied });
    },
  );

  const formatCell = tool(
    'format_cell',
    '표의 특정 칸(행·열) 전체에 글자 서식과 문단 정렬(align)을 적용합니다. 병합 셀도 올바르게 처리합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0), col: z.number().int().min(0),
      ...FORMAT_FIELDS,
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const cellIdx = resolveCellIdx(tableCells(doc, ref), args.row, args.col);
      if (cellIdx === null) return { ...textResult(`칸 (${args.row},${args.col}) 없음.`), isError: true };
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return { ...textResult('적용할 서식이 지정되지 않았습니다.'), isError: true };
      let ok = false;
      if (applied.length > 0) ok = formatCellRuns(ref, cellIdx, JSON.stringify(props)) || ok;
      if (args.align) { ok = alignCellParas(ref, cellIdx, args.align) || ok; applied.push(`정렬=${args.align}`); }
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, row: args.row, col: args.col, applied });
    },
  );

  const formatTable = tool(
    'format_table',
    '표의 모든 칸에 글자 서식과 문단 정렬(align)을 한 번에 적용합니다. 병합 셀 포함 실제 셀만 정확히 처리합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      ...FORMAT_FIELDS,
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return { ...textResult('적용할 서식이 지정되지 않았습니다.'), isError: true };
      const propsJson = JSON.stringify(props);
      let cells = 0;
      for (const c of tableCells(doc, ref)) {
        let cellOk = false;
        if (applied.length > 0) cellOk = formatCellRuns(ref, c.cellIdx, propsJson) || cellOk;
        if (args.align) cellOk = alignCellParas(ref, c.cellIdx, args.align) || cellOk;
        if (cellOk) cells++;
      }
      if (args.align) applied.push(`정렬=${args.align}`);
      if (cells > 0) holder.dirty = true;
      return jsonResult({ ok: cells > 0, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, cellsFormatted: cells, applied });
    },
  );

  const setCellBackground = tool(
    'set_cell_background',
    '표 셀의 배경색을 설정합니다. row·col 지정 시 그 칸만(병합-aware), 둘 다 생략 시 표 전체. 색은 #RRGGBB, "none" 이면 배경 제거. 테두리는 보존됩니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      color: z.union([z.string().regex(/^#?[0-9a-fA-F]{6}$/), z.literal('none')]).describe('#RRGGBB 또는 "none"'),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const t = targetCellIdxs(ref, args.row, args.col);
      if ('error' in t) return { ...textResult(t.error), isError: true };
      const fillColor = args.color === 'none' ? null : normalizeHex(args.color);
      let n = 0;
      for (const cellIdx of t.ids) if (writeCellBorderFill(ref, cellIdx, { fillColor })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.ids.length === 1 ? 'cell' : 'table', color: args.color });
    },
  );

  const setCellBorder = tool(
    'set_cell_border',
    '표 셀의 테두리를 설정합니다. row·col 지정 시 그 칸만(병합-aware), 둘 다 생략 시 표 전체. sides=all/top/bottom/left/right, style=solid/none. 배경은 보존됩니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      sides: z.enum(['all', 'top', 'bottom', 'left', 'right']).optional().describe('기본 all'),
      style: z.enum(['solid', 'none']).optional().describe('기본 solid'),
      width: z.number().int().min(0).max(16).optional().describe('선 굵기 단계(0~16). 기본 2'),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe('선 색 #RRGGBB. 기본 #000000'),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const t = targetCellIdxs(ref, args.row, args.col);
      if ('error' in t) return { ...textResult(t.error), isError: true };
      const sidesArg = args.sides ?? 'all';
      const sides = sidesArg === 'all' ? (['top', 'right', 'bottom', 'left'] as const).slice() : [sidesArg];
      const line: BorderLine = { type: (args.style ?? 'solid') === 'none' ? 0 : 1, width: args.width ?? 2, color: normalizeHex(args.color ?? '#000000') };
      let n = 0;
      for (const cellIdx of t.ids) if (writeCellBorderFill(ref, cellIdx, { sides: sides as Array<'top' | 'right' | 'bottom' | 'left'>, line })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.ids.length === 1 ? 'cell' : 'table', sides: sidesArg, style: args.style ?? 'solid' });
    },
  );

  const setCellLayout = tool(
    'set_cell_layout',
    '표 셀의 세로 정렬(verticalAlign: top/middle/bottom)을 설정합니다. row·col 지정 시 그 칸만(병합-aware), 둘 다 생략 시 표 전체.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      verticalAlign: z.enum(['top', 'middle', 'bottom']),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      const t = targetCellIdxs(ref, args.row, args.col);
      if ('error' in t) return { ...textResult(t.error), isError: true };
      const va = args.verticalAlign === 'top' ? 0 : args.verticalAlign === 'bottom' ? 2 : 1;
      let n = 0;
      for (const cellIdx of t.ids) {
        try {
          const cur = JSON.parse(doc.getCellProperties(ref.section, ref.paragraph, ref.controlIdx, cellIdx));
          const props = { borderTop: cur.borderTop, borderRight: cur.borderRight, borderBottom: cur.borderBottom, borderLeft: cur.borderLeft, fillType: cur.fillType, fillColor: cur.fillColor, verticalAlign: va };
          if (parseOk(doc.setCellProperties(ref.section, ref.paragraph, ref.controlIdx, cellIdx, JSON.stringify(props)))) n++;
        } catch { /* 건너뜀 */ }
      }
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.ids.length === 1 ? 'cell' : 'table', verticalAlign: args.verticalAlign });
    },
  );

  const setTableOptions = tool(
    'set_table_options',
    '표 옵션을 설정합니다. repeatHeader=true 면 표가 페이지를 넘길 때 첫 행(제목행)을 매 페이지 반복합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      repeatHeader: z.boolean().optional(),
    },
    async (args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return { ...textResult('표가 없습니다.'), isError: true };
      if (args.repeatHeader === undefined) return { ...textResult('설정할 옵션이 없습니다.'), isError: true };
      const raw = doc.setTableProperties(ref.section, ref.paragraph, ref.controlIdx, JSON.stringify({ repeatHeader: args.repeatHeader }));
      if (parseOk(raw)) holder.dirty = true;
      return jsonResult({ ok: parseOk(raw), section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, repeatHeader: args.repeatHeader });
    },
  );

  return createSdkMcpServer({
    name: 'hwp',
    version: '0.2.0',
    tools: [
      getDocumentInfo, readParagraphs, searchText, findText,
      insertText, deleteRange, replaceText,
      insertTable, listTables, readTable, setCell,
      addTableRow, addTableColumn, deleteTableRow, deleteTableColumn, deleteTable,
      formatText, formatCell, formatTable,
      setCellBackground, setCellBorder, setCellLayout, setTableOptions,
    ],
  });
}

/** allowedTools 에 넘길 정규화된 도구 이름 목록. */
export const HWP_TOOL_NAMES = [
  'mcp__hwp__get_document_info',
  'mcp__hwp__read_paragraphs',
  'mcp__hwp__search_text',
  'mcp__hwp__find_text',
  'mcp__hwp__insert_text',
  'mcp__hwp__delete_range',
  'mcp__hwp__replace_text',
  'mcp__hwp__insert_table',
  'mcp__hwp__list_tables',
  'mcp__hwp__read_table',
  'mcp__hwp__set_cell',
  'mcp__hwp__add_table_row',
  'mcp__hwp__add_table_column',
  'mcp__hwp__delete_table_row',
  'mcp__hwp__delete_table_column',
  'mcp__hwp__delete_table',
  'mcp__hwp__format_text',
  'mcp__hwp__format_cell',
  'mcp__hwp__format_table',
  'mcp__hwp__set_cell_background',
  'mcp__hwp__set_cell_border',
  'mcp__hwp__set_cell_layout',
  'mcp__hwp__set_table_options',
];
