import 'server-only';

import { z } from 'zod';
import type { HwpDocument } from '@rhwp/core';

// 문서 인스턴스를 홀더로 감쌉니다. 편집이 일어나면 dirty 를 세워 라우트가
// 턴 종료 후 문서를 export 해 클라이언트로 되돌려 보낼지 판단합니다.
export type DocHolder = { doc: HwpDocument; dirty: boolean };

// ─────────────────────────────────────────────────────────────────────────
// provider-무관 도구 스펙.
//
// 각 도구는 { name, description, schema(zod raw shape), execute } 로 표현됩니다.
// - Claude 경로(tools.ts)는 이 스펙을 Agent SDK 의 tool() 로 감쌉니다.
// - 그 외 provider(tools-ai-sdk.ts)는 Vercel AI SDK 의 tool() 로 감쌉니다.
// 실제 문서 조작 로직(HwpDocument 호출)은 전부 여기 있으며 provider 와 무관합니다.
// ─────────────────────────────────────────────────────────────────────────

/** 도구 실행 결과. text 는 모델에게 돌려줄 내용(JSON 문자열 또는 메시지), isError 는 실패 여부. */
export type ToolResult = { text: string; isError?: boolean };

export type HwpToolSpec = {
  name: string;
  description: string;
  /** zod raw shape (필드→zod 타입). 어댑터가 provider 별 스키마로 변환합니다. */
  schema: z.ZodRawShape;
  execute: (holder: DocHolder, args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

type InferShape<S extends z.ZodRawShape> = { [K in keyof S]: z.infer<S[K]> };

// 스펙을 정의하며 execute 의 args 를 스키마에서 추론해 타입 안전하게 씁니다.
function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  execute: (holder: DocHolder, args: InferShape<S>) => Promise<ToolResult> | ToolResult,
): HwpToolSpec {
  return { name, description, schema, execute: execute as HwpToolSpec['execute'] };
}

const MAX_PARAGRAPHS_PER_READ = 40;
const MAX_OUTLINE_ITEMS = 100;
// 수준 1단당 기본 들여쓰기. 공문서에서 흔한 "스페이스 1~2칸" 정도의 폭입니다.
const DEFAULT_INDENT_MM_PER_LEVEL = 5;

function textResult(text: string): ToolResult {
  return { text };
}

function jsonResult(value: unknown): ToolResult {
  return { text: JSON.stringify(value) };
}

function errResult(text: string): ToolResult {
  return { text, isError: true };
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

// ── 문단 머리(글머리표·문단 번호) ──
// 화면에 보이는 □·○ 같은 기호가 문단 속성(headType)일 수 있습니다. 이건 본문 텍스트가
// 아니라서 getTextRange/searchText 로는 전혀 안 보이고, 그래서 replace_text 로 바꿀 수도
// 없습니다. 모델이 이 상태를 인지해 set_paragraph_bullet 으로 가도록 read_paragraphs 에
// 함께 실어 보냅니다.
type ParaHead = { headType: string; level: number; numberingId?: number; bulletChar?: string };

/** 문서에 정의된 글머리표 목록을 id→문자 맵으로 읽습니다(문단마다 재조회하지 않도록 캐시해 씁니다). */
function bulletCharsById(doc: HwpDocument): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const list = JSON.parse(doc.getBulletList()) as Array<{ id: number; char: string }>;
    if (Array.isArray(list)) for (const b of list) if (b?.id) map.set(b.id, b.char);
  } catch {
    /* 글머리표 정의 없음 */
  }
  return map;
}

/** 문단의 머리 정보. 글머리표/번호가 없으면(headType=None) null. */
function paragraphHead(doc: HwpDocument, section: number, para: number, bullets: Map<number, string>): ParaHead | null {
  let props: { headType?: string; paraLevel?: number; numberingId?: number };
  try {
    props = JSON.parse(doc.getParaPropertiesAt(section, para));
  } catch {
    return null;
  }
  const headType = props.headType ?? 'None';
  if (!headType || headType === 'None') return null;
  const head: ParaHead = { headType, level: props.paraLevel ?? 0 };
  if (props.numberingId) head.numberingId = props.numberingId;
  if (headType === 'Bullet') {
    const ch = props.numberingId === undefined ? undefined : bullets.get(props.numberingId);
    if (ch) head.bulletChar = ch;
  }
  return head;
}

// 본문 텍스트에는 없지만 화면에는 보이는 기호를 검색/치환하려 할 때 모델에게 줄 안내.
const HEAD_HINT =
  '화면에 보이는 □·○ 같은 글머리표 기호가 문단 속성일 수 있습니다(본문 텍스트가 아니므로 검색·치환 대상이 아님). read_paragraphs 의 head 를 확인하고, 글머리표라면 set_paragraph_bullet 으로 바꾸세요.';

// mm → applyParaFormat 의 문단 여백 단위. 셀 쪽(mmToHwpUnit)과 달리 HWPUNIT 의 1/2
// 스케일입니다. core 0.7.19 실측: marginLeft 7200 입력 → HWPX 에 <hc:left value="3600"
// unit="HWPUNIT"/> (=0.5인치)로 기록되고 렌더도 0.5인치 들여쓰기.
function mmToParaMargin(mm: number): number {
  return Math.round((mm * 14400) / 25.4);
}

// ── 여러 줄 → 여러 문단 ──
// core 의 insertText 는 "\n" 을 문단 구분으로 보지 않고 한 문단 안의 강제 개행으로 넣습니다.
// 글머리표·문단 서식은 문단 단위라서 그 상태로는 줄마다 다른 기호·크기를 줄 수 없습니다.
// 그래서 줄 하나당 splitParagraph 로 실제 문단을 만들어 넣습니다.
// 반환: 각 줄이 들어간 문단 인덱스 배열(줄 수와 길이가 같음).
function insertLines(doc: HwpDocument, section: number, para: number, charOffset: number, lines: string[]): number[] {
  const used: number[] = [];
  let cur = para;
  let off = charOffset;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // 커서 뒤 내용은 새 문단으로 넘어갑니다(원래 문단의 꼬리는 마지막 줄 뒤에 남음).
      const split = JSON.parse(doc.splitParagraph(section, cur, off)) as { ok?: boolean; paraIdx?: number };
      if (split?.ok !== true || split.paraIdx === undefined) {
        throw new Error(`문단 분리 실패 (문단 ${cur}, 오프셋 ${off})`);
      }
      cur = split.paraIdx;
      off = 0;
    }
    if (lines[i].length > 0) {
      if (!parseOk(doc.insertText(section, cur, off, lines[i]))) {
        throw new Error(`텍스트 삽입 실패 (문단 ${cur}, 오프셋 ${off})`);
      }
      off += lines[i].length;
    }
    used.push(cur);
  }
  return used;
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

// mm → HWPUNIT(1/7200 인치). 셀 너비·여백·간격 입력을 사용자 친화적 mm 로 받습니다.
function mmToHwpUnit(mm: number): number {
  return Math.round((mm * 7200) / 25.4);
}

// getCellProperties 가 돌려주는 값 중 setCellProperties 로 되돌려 쓸 수 있는(쓰기 가능) 필드만 추립니다.
// setCellProperties 는 "전체 교체"라 일부만 보내면 나머지가 초기화되므로, 항상 이 전체 집합에
// 변경분만 덮어써서 보내야 width/여백/세로정렬 등이 유실되지 않습니다. (borderFillId 등 읽기전용 제외)
function fullCellProps(cur: Record<string, unknown>): Record<string, unknown> {
  return {
    width: cur.width, height: cur.height,
    paddingLeft: cur.paddingLeft, paddingRight: cur.paddingRight, paddingTop: cur.paddingTop, paddingBottom: cur.paddingBottom,
    verticalAlign: cur.verticalAlign, textDirection: cur.textDirection, isHeader: cur.isHeader,
    borderTop: cur.borderTop, borderRight: cur.borderRight, borderBottom: cur.borderBottom, borderLeft: cur.borderLeft,
    fillType: cur.fillType, fillColor: cur.fillColor,
  };
}

// 셀 하나의 모든 문단에 글자 서식을 적용합니다.
function formatCellRuns(doc: HwpDocument, ref: TableRef, cellIdx: number, propsJson: string): boolean {
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
function alignCellParas(doc: HwpDocument, ref: TableRef, cellIdx: number, alignment: Align): boolean {
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

// 셀 속성 변경의 공통 경로: 현재 전체 속성을 읽어 override 만 덮어써서 setCellProperties 에 보냅니다.
// (setCellProperties 는 전체 교체이므로 이렇게 해야 width·여백·세로정렬 등이 유실되지 않습니다.)
function mergeCellProps(doc: HwpDocument, ref: TableRef, cellIdx: number, override: Record<string, unknown>): boolean {
  let cur: Record<string, unknown>;
  try {
    cur = JSON.parse(doc.getCellProperties(ref.section, ref.paragraph, ref.controlIdx, cellIdx));
  } catch {
    return false;
  }
  return parseOk(doc.setCellProperties(ref.section, ref.paragraph, ref.controlIdx, cellIdx, JSON.stringify({ ...fullCellProps(cur), ...override })));
}

// 셀 테두리/배경: HWP 는 둘을 하나의 borderFill 로 관리하므로 항상 함께(그리고 나머지 속성도 보존해) 재전송합니다.
type BorderLine = { type: number; width: number; color: string };
function writeCellBorderFill(
  doc: HwpDocument,
  ref: TableRef,
  cellIdx: number,
  opts: { sides?: Array<'top' | 'right' | 'bottom' | 'left'>; line?: BorderLine; fillColor?: string | null },
): boolean {
  const override: Record<string, unknown> = {};
  if (opts.line && opts.sides) {
    for (const side of opts.sides) override[`border${side[0].toUpperCase()}${side.slice(1)}`] = opts.line;
  }
  if (opts.fillColor !== undefined) {
    if (opts.fillColor === null) override.fillType = 'none';
    else { override.fillType = 'solid'; override.fillColor = opts.fillColor; }
  }
  return mergeCellProps(doc, ref, cellIdx, override);
}

// 대상 셀 cellIdx 목록(병합-aware):
//   row+col → 그 칸 하나 / row만 → 그 행 전체 / col만 → 그 열 전체 / 둘 다 생략 → 표 전체.
function targetCellIdxs(doc: HwpDocument, ref: TableRef, row?: number, col?: number): { ids: number[]; scope: string } | { error: string } {
  const cells = tableCells(doc, ref);
  const uniq = (a: number[]) => [...new Set(a)];
  if (row === undefined && col === undefined) return { ids: uniq(cells.map(c => c.cellIdx)), scope: 'table' };
  if (col === undefined) {
    const ids = cells.filter(c => row! >= c.row && row! < c.row + c.rowSpan).map(c => c.cellIdx);
    if (!ids.length) return { error: `행 ${row} 없음 — 표 크기 ${ref.rows}×${ref.cols}.` };
    return { ids: uniq(ids), scope: `row ${row}` };
  }
  if (row === undefined) {
    const ids = cells.filter(c => col! >= c.col && col! < c.col + c.colSpan).map(c => c.cellIdx);
    if (!ids.length) return { error: `열 ${col} 없음 — 표 크기 ${ref.rows}×${ref.cols}.` };
    return { ids: uniq(ids), scope: `col ${col}` };
  }
  const idx = resolveCellIdx(cells, row, col);
  if (idx === null) return { error: `칸 (${row},${col}) 없음 — 표 크기 ${ref.rows}×${ref.cols}(병합 포함).` };
  return { ids: [idx], scope: `cell (${row},${col})` };
}

// 표 속성도 setTableProperties 가 전체 교체이므로 현재 쓰기가능 필드를 읽어 override 만 덮어씁니다.
function mergeTableProps(doc: HwpDocument, ref: TableRef, override: Record<string, unknown>): boolean {
  let cur: Record<string, unknown>;
  try { cur = JSON.parse(doc.getTableProperties(ref.section, ref.paragraph, ref.controlIdx)); } catch { return false; }
  const base = {
    cellSpacing: cur.cellSpacing,
    paddingLeft: cur.paddingLeft, paddingRight: cur.paddingRight, paddingTop: cur.paddingTop, paddingBottom: cur.paddingBottom,
    pageBreak: cur.pageBreak, repeatHeader: cur.repeatHeader,
  };
  return parseOk(doc.setTableProperties(ref.section, ref.paragraph, ref.controlIdx, JSON.stringify({ ...base, ...override })));
}

/**
 * HWP 문서 편집 도구 스펙 목록(30개). 문서는 서버의 HwpDocument 인스턴스(holder.doc)에 있으며,
 * 각 execute 는 인프로세스로 이 인스턴스를 조회·편집합니다. provider 와 무관합니다.
 */
export const HWP_TOOL_SPECS: HwpToolSpec[] = [
  // ────────────────── 읽기 도구 ──────────────────
  defineTool(
    'get_document_info',
    '현재 열린 HWP 문서의 구조 요약을 반환합니다. 구역(section) 수, 각 구역의 문단 수, 페이지 수, 사용 글꼴 등. 편집·읽기 전에 문서 구조를 파악할 때 먼저 호출하세요.',
    {},
    (holder) => {
      const doc = holder.doc;
      const info = JSON.parse(doc.getDocumentInfo());
      const sectionCount = doc.getSectionCount();
      const sections = [];
      for (let s = 0; s < sectionCount; s++) {
        sections.push({ section: s, paragraphCount: doc.getParagraphCount(s) });
      }
      return jsonResult({ ...info, sections });
    },
  ),

  defineTool(
    'read_paragraphs',
    `지정한 구역의 문단 텍스트를 읽습니다. 좌표계는 구역(section) → 문단(paragraph, 0-기반) → 글자 오프셋입니다. 한 번에 최대 ${MAX_PARAGRAPHS_PER_READ}개 문단까지 반환합니다. 문단에 글머리표·문단 번호가 걸려 있으면 head(headType/level/bulletChar)로 함께 알려줍니다 — head 의 기호는 문단 속성이라 text 에는 없습니다.`,
    {
      section: z.number().int().min(0).describe('구역 인덱스 (0-기반)'),
      start: z.number().int().min(0).describe('시작 문단 인덱스 (0-기반)'),
      count: z.number().int().min(1).max(MAX_PARAGRAPHS_PER_READ).optional().describe(`읽을 문단 수 (기본·최대 ${MAX_PARAGRAPHS_PER_READ})`),
    },
    (holder, args) => {
      const doc = holder.doc;
      const sectionCount = doc.getSectionCount();
      if (args.section >= sectionCount) {
        return errResult(`구역 ${args.section} 없음 (총 ${sectionCount}개).`);
      }
      const paraCount = doc.getParagraphCount(args.section);
      if (args.start >= paraCount) {
        return errResult(`문단 ${args.start} 없음 (구역 ${args.section}에 총 ${paraCount}개).`);
      }
      const count = Math.min(args.count ?? MAX_PARAGRAPHS_PER_READ, paraCount - args.start);
      const bullets = bulletCharsById(doc);
      const paragraphs = [];
      let headCount = 0;
      for (let i = 0; i < count; i++) {
        const p = args.start + i;
        const entry: {
          paragraph: number;
          text: string;
          head?: ParaHead;
          tables?: Array<{ controlIdx: number; rows: number; cols: number }>;
        } = {
          paragraph: p,
          text: readParagraph(doc, args.section, p),
        };
        const head = paragraphHead(doc, args.section, p, bullets);
        if (head) { entry.head = head; headCount++; }
        const tables = tablesInParagraph(doc, args.section, p);
        if (tables.length > 0) entry.tables = tables.map(t => ({ controlIdx: t.controlIdx, rows: t.rows, cols: t.cols }));
        paragraphs.push(entry);
      }
      const hints = ['표(tables)가 표시된 문단의 셀 내용은 read_table 로 읽으세요.'];
      if (headCount > 0) {
        hints.push(
          `head 가 있는 문단 ${headCount}개: 그 기호(bulletChar)는 문단 속성이라 text 에 없고 search_text/replace_text 로 찾거나 바꿀 수 없습니다. 기호를 바꾸거나 없애려면 set_paragraph_bullet 을 쓰세요.`,
        );
      }
      return jsonResult({
        section: args.section,
        paragraphCount: paraCount,
        returned: { start: args.start, count },
        paragraphs,
        hint: hints.join(' '),
      });
    },
  ),

  defineTool(
    'search_text',
    '본문에서 문자열을 검색해 위치(구역·문단·글자 오프셋)를 반환합니다. 표 셀 안은 찾지 못합니다 — 표까지 포함해 찾으려면 find_text 를 쓰세요.',
    {
      query: z.string().min(1).describe('검색할 문자열'),
      caseSensitive: z.boolean().optional().describe('대소문자 구분 (기본 false)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const hit = JSON.parse(doc.searchText(args.query, 0, 0, 0, true, args.caseSensitive ?? false)) as {
        found: boolean; sec?: number; para?: number; charOffset?: number; length?: number;
      };
      if (!hit.found || hit.sec === undefined || hit.para === undefined) return jsonResult({ found: false, hint: HEAD_HINT });
      return jsonResult({
        found: true, section: hit.sec, paragraph: hit.para, charOffset: hit.charOffset, length: hit.length,
        paragraphText: readParagraph(doc, hit.sec, hit.para),
      });
    },
  ),

  defineTool(
    'find_text',
    '본문과 표 셀 전체에서 문자열을 찾아 위치 목록을 반환합니다(본문 검색이 못 닿는 표 셀까지 포함). 표 안 내용을 찾아 고칠 때 사용하세요. 셀 매치는 (구역·문단·controlIdx·행·열)을 주므로 set_cell 로 편집할 수 있습니다.',
    {
      query: z.string().min(1).describe('찾을 문자열'),
      caseSensitive: z.boolean().optional().describe('대소문자 구분 (기본 false)'),
    },
    (holder, args) => {
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
  ),

  // ────────────────── 본문 편집 도구 ──────────────────
  defineTool(
    'insert_text',
    '지정한 위치(구역·문단·글자 오프셋)에 텍스트를 삽입합니다. 오프셋 0-기반. 편집 전 해당 문단을 읽어 위치를 확인하세요. 표 셀에는 set_cell 을 쓰세요. 줄바꿈(\\n)이 있으면 줄마다 **별도 문단**으로 나눠 넣고 사용된 문단 인덱스(paragraphs)를 돌려줍니다 — 그 인덱스로 줄마다 글머리표·서식을 걸 수 있습니다. 글머리표가 있는 계층 문서를 새로 만들 때는 insert_outline 이 더 편합니다.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), charOffset: z.number().int().min(0), text: z.string().min(1) },
    (holder, args) => {
      const doc = holder.doc;
      // \r\n·\r 도 줄바꿈으로 취급합니다(모델이 어떤 형태로 보내도 문단이 나뉘도록).
      const lines = args.text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) {
        const raw = doc.insertText(args.section, args.paragraph, args.charOffset, args.text);
        if (parseOk(raw)) holder.dirty = true;
        return textResult(raw);
      }
      let used: number[];
      try {
        used = insertLines(doc, args.section, args.paragraph, args.charOffset, lines);
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
      holder.dirty = true;
      return jsonResult({
        ok: true,
        section: args.section,
        paragraphs: used,
        note: `줄바꿈 ${lines.length - 1}개를 문단 ${lines.length}개로 나눠 넣었습니다. 줄마다 글머리표·서식을 주려면 이 paragraphs 인덱스를 쓰세요.`,
      });
    },
  ),

  defineTool(
    'delete_range',
    '구역 내 [시작 문단·오프셋, 끝 문단·오프셋) 범위의 본문 내용을 삭제합니다. 오프셋 0-기반. 삭제 전 대상 범위를 읽어 확인하세요.',
    { section: z.number().int().min(0), startParagraph: z.number().int().min(0), startOffset: z.number().int().min(0), endParagraph: z.number().int().min(0), endOffset: z.number().int().min(0) },
    (holder, args) => {
      const raw = holder.doc.deleteRange(args.section, args.startParagraph, args.startOffset, args.endParagraph, args.endOffset);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  ),

  defineTool(
    'replace_text',
    '본문에서 문자열을 찾아 교체합니다(첫 일치). 표 셀 안은 대상이 아닙니다 — 표는 find_text 로 찾아 set_cell 로 고치세요.',
    { query: z.string().min(1), replacement: z.string(), caseSensitive: z.boolean().optional() },
    (holder, args) => {
      const doc = holder.doc;
      const hit = JSON.parse(doc.searchText(args.query, 0, 0, 0, true, args.caseSensitive ?? false)) as {
        found: boolean; sec?: number; para?: number; charOffset?: number; length?: number;
      };
      if (!hit.found || hit.sec === undefined || hit.para === undefined || hit.charOffset === undefined || hit.length === undefined) {
        return { ...jsonResult({ ok: false, reason: 'not_found', query: args.query, hint: HEAD_HINT }), isError: true };
      }
      const del = doc.deleteText(hit.sec, hit.para, hit.charOffset, hit.length);
      if (!parseOk(del)) return errResult(del);
      let ok = true;
      if (args.replacement.length > 0) {
        ok = parseOk(doc.insertText(hit.sec, hit.para, hit.charOffset, args.replacement));
      }
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: hit.sec, paragraph: hit.para, replaced: args.query, with: args.replacement, paragraphText: readParagraph(doc, hit.sec, hit.para) });
    },
  ),

  defineTool(
    'insert_outline',
    '글머리표 계층(트리) 문서를 한 번에 만듭니다. items 의 각 항목이 **문단 하나**가 되고, 항목마다 글머리표(bullet)·수준(level)·글자크기(fontSize)·굵게(bold)를 지정할 수 있습니다. 들여쓰기는 level×indentMmPerLevel(기본 5mm ≒ 스페이스 1~2칸)로 자동 적용되며 indentMm 으로 항목별 직접 지정도 됩니다. "네모-동그라미-하이픈 3단 트리에 글자크기 17-15-13" 같은 요청은 이 도구 한 번으로 끝내세요 — insert_text 로 기호를 타이핑하거나 문단을 따로 나눌 필요가 없습니다.',
    {
      section: z.number().int().min(0).describe('구역 인덱스 (0-기반)'),
      paragraph: z.number().int().min(0).describe('넣을 시작 문단 인덱스 (0-기반). 첫 항목이 이 문단에 들어가고 나머지는 뒤에 새 문단으로 이어집니다'),
      charOffset: z.number().int().min(0).optional().describe('시작 문단 안 글자 오프셋 (기본 0)'),
      items: z.array(z.object({
        text: z.string().describe('그 줄의 내용(기호는 넣지 마세요 — bullet 이 글머리표로 붙습니다)'),
        level: z.number().int().min(0).max(6).optional().describe('수준 (0-기반, 기본 0)'),
        bullet: z.string().min(1).max(4).optional().describe('글머리표 문자(네모=□, 동그라미=○, 점=·, 하이픈=-). 생략하면 글머리표 없음'),
        fontSize: z.number().positive().max(300).optional().describe('글자 크기 (pt)'),
        bold: z.boolean().optional().describe('굵게'),
        indentMm: z.number().min(0).max(200).optional().describe('왼쪽 들여쓰기(mm) 직접 지정. 생략 시 level×indentMmPerLevel'),
      })).min(1).max(MAX_OUTLINE_ITEMS).describe(`계층 항목 목록 (최대 ${MAX_OUTLINE_ITEMS}개)`),
      indentMmPerLevel: z.number().min(0).max(50).optional().describe('수준 1단당 들여쓰기 (mm, 기본 5)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const sectionCount = doc.getSectionCount();
      if (args.section >= sectionCount) {
        return errResult(`구역 ${args.section} 없음 (총 ${sectionCount}개).`);
      }
      const paraCount = doc.getParagraphCount(args.section);
      if (args.paragraph >= paraCount) {
        return errResult(`문단 ${args.paragraph} 없음 (구역 ${args.section}에 총 ${paraCount}개). 문서 끝에 붙이려면 마지막 문단 인덱스를 쓰세요.`);
      }
      const step = args.indentMmPerLevel ?? DEFAULT_INDENT_MM_PER_LEVEL;

      // 항목 텍스트 안의 줄바꿈도 문단으로 나누고, 나뉜 줄들은 그 항목의 서식을 함께 받습니다.
      const lines: string[] = [];
      const ownerOfLine: number[] = [];
      args.items.forEach((item, idx) => {
        for (const line of item.text.replace(/\r\n?/g, '\n').split('\n')) {
          lines.push(line);
          ownerOfLine.push(idx);
        }
      });

      let used: number[];
      try {
        used = insertLines(doc, args.section, args.paragraph, args.charOffset ?? 0, lines);
      } catch (e) {
        return errResult(e instanceof Error ? e.message : String(e));
      }
      holder.dirty = true;

      const applied: Array<{ paragraph: number; level: number; bullet?: string; fontSize?: number; indentMm: number }> = [];
      const warnings: string[] = [];
      used.forEach((p, li) => {
        const item = args.items[ownerOfLine[li]];
        const level = item.level ?? 0;
        const indentMm = item.indentMm ?? level * step;

        // 내용 없는 줄(빈 항목이나 줄바꿈으로 생긴 빈 줄)에는 글머리표를 달지 않습니다.
        // 기호만 덩그러니 남은 줄이 생기기 때문입니다. 간격용 빈 줄로 그대로 둡니다.
        const isBlank = lines[li].length === 0;
        const props: Record<string, unknown> = { paraLevel: level, marginLeft: mmToParaMargin(indentMm) };
        if (item.bullet && !isBlank) {
          const ch = [...item.bullet.trim()][0];
          const bulletId = ch ? doc.ensureDefaultBullet(ch) : 0;
          if (bulletId) {
            props.headType = 'Bullet';
            props.numberingId = bulletId;
          } else {
            warnings.push(`문단 ${p}: 글머리표 '${item.bullet}' 정의 실패`);
          }
        }
        if (!parseOk(doc.applyParaFormat(args.section, p, JSON.stringify(props)))) {
          warnings.push(`문단 ${p}: 문단 서식 적용 실패`);
        }

        // 글자 서식은 그 문단 전체에 적용합니다(빈 줄은 적용할 글자가 없으므로 건너뜀).
        const { props: charProps, applied: charApplied } = buildCharProps(doc, { fontSize: item.fontSize, bold: item.bold });
        if (charApplied.length > 0) {
          const len = doc.getParagraphLength(args.section, p);
          if (len > 0 && !parseOk(doc.applyCharFormat(args.section, p, 0, len, JSON.stringify(charProps)))) {
            warnings.push(`문단 ${p}: 글자 서식 적용 실패`);
          }
        }
        applied.push({
          paragraph: p,
          level,
          // 실제로 붙은 글머리표만 보고합니다(빈 줄은 없음).
          bullet: props.headType === 'Bullet' ? (props.numberingId ? [...(item.bullet as string).trim()][0] : undefined) : undefined,
          fontSize: item.fontSize,
          indentMm,
        });
      });

      return jsonResult({
        ok: warnings.length === 0,
        section: args.section,
        paragraphs: applied,
        indentMmPerLevel: step,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    },
  ),

  defineTool(
    'set_paragraph_bullet',
    '본문 문단의 글머리표(□·○··-)를 지정/변경/제거합니다. 글머리표는 문단 속성이므로 본문 텍스트에 들어가지 않습니다 — 화면에 보이는 기호가 read_paragraphs 의 text 에 없고 head 에만 있으면 replace_text 로는 절대 못 바꾸고 이 도구로 바꿔야 합니다. endParagraph 를 주면 그 범위 문단 전체에 적용합니다. 계층(트리) 구조를 만들 땐 level 과 indentMm 을 함께 주세요 — level 만으로는 들여쓰기가 되지 않습니다(권장: 수준 0/1/2/3 → indentMm 0/5/10/15). 표 셀 안 문단은 대상이 아닙니다.',
    {
      section: z.number().int().min(0).describe('구역 인덱스 (0-기반)'),
      paragraph: z.number().int().min(0).describe('시작 문단 인덱스 (0-기반)'),
      endParagraph: z.number().int().min(0).optional().describe('끝 문단 인덱스(포함). 생략 시 paragraph 한 문단만'),
      char: z.string().min(1).max(4).optional().describe('글머리표 문자. 네모=□, 검정네모=■, 동그라미=○, 검정동그라미=●, 작은동그라미=◦, 점=·, 하이픈=-, 다이아=◆, 삼각=▶. remove 를 쓸 때는 생략'),
      level: z.number().int().min(0).max(6).optional().describe('문단 수준 (0-기반, 기본 0)'),
      indentMm: z.number().min(0).max(200).optional().describe('왼쪽 들여쓰기 (mm). 생략하면 문단 여백을 건드리지 않습니다'),
      remove: z.boolean().optional().describe('true 면 글머리표를 제거합니다(headType=None)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const sectionCount = doc.getSectionCount();
      if (args.section >= sectionCount) {
        return errResult(`구역 ${args.section} 없음 (총 ${sectionCount}개).`);
      }
      const paraCount = doc.getParagraphCount(args.section);
      if (args.paragraph >= paraCount) {
        return errResult(`문단 ${args.paragraph} 없음 (구역 ${args.section}에 총 ${paraCount}개).`);
      }
      const end = args.endParagraph ?? args.paragraph;
      if (end < args.paragraph) {
        return errResult(`endParagraph(${end}) 가 paragraph(${args.paragraph}) 보다 앞입니다.`);
      }
      const last = Math.min(end, paraCount - 1);
      const remove = args.remove === true;
      // 글머리표 문자는 코드포인트 1개만 씁니다(모델이 "□ " 처럼 공백을 붙여 보내도 안전하게).
      const char = remove ? undefined : [...(args.char ?? '').trim()][0];
      if (!remove && !char) {
        return errResult('char(글머리표 문자) 또는 remove:true 중 하나가 필요합니다.');
      }

      const props: Record<string, unknown> = {};
      let bulletId: number | undefined;
      if (remove) {
        props.headType = 'None';
      } else {
        // 같은 문자의 정의가 이미 있으면 그 ID 를 재사용합니다(문서에 중복 정의가 쌓이지 않음).
        bulletId = doc.ensureDefaultBullet(char as string);
        if (!bulletId) return errResult(`글머리표 정의를 만들 수 없습니다: ${char}`);
        props.headType = 'Bullet';
        props.numberingId = bulletId;
        props.paraLevel = args.level ?? 0;
      }
      if (args.indentMm !== undefined) props.marginLeft = mmToParaMargin(args.indentMm);

      const json = JSON.stringify(props);
      const applied: number[] = [];
      const failed: number[] = [];
      for (let p = args.paragraph; p <= last; p++) {
        if (parseOk(doc.applyParaFormat(args.section, p, json))) applied.push(p);
        else failed.push(p);
      }
      if (applied.length > 0) holder.dirty = true;
      return jsonResult({
        ok: failed.length === 0 && applied.length > 0,
        section: args.section,
        paragraphs: applied,
        failed: failed.length > 0 ? failed : undefined,
        truncated: end > last ? `문단 ${last} 까지만 적용(구역에 총 ${paraCount}개)` : undefined,
        ...(remove
          ? { removed: true }
          : { bulletChar: char, bulletId, level: args.level ?? 0 }),
        indentMm: args.indentMm,
      });
    },
  ),

  // ────────────────── 표: 생성·읽기 ──────────────────
  defineTool(
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
    (holder, args) => {
      const doc = holder.doc;
      const raw = doc.createTable(args.section, args.paragraph, args.charOffset, args.rows, args.cols);
      let created: { ok?: boolean; paraIdx?: number; controlIdx?: number } | null = null;
      try { created = JSON.parse(raw); } catch { /* null */ }
      if (!created?.ok || created.paraIdx === undefined || created.controlIdx === undefined) {
        return errResult(raw);
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
  ),

  defineTool(
    'list_tables',
    '문서 전체의 표 목록을 반환합니다. 각 표의 위치(구역·문단·controlIdx), 크기(행×열), 병합 여부, 그리고 첫 행 미리보기(headerPreview)를 함께 주어 "예산 표" 같이 내용으로 표를 찾을 수 있게 합니다.',
    {},
    (holder) => {
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
  ),

  defineTool(
    'read_table',
    '표의 모든 셀을 반환합니다. 병합을 고려해 각 셀의 (행·열·rowSpan·colSpan·텍스트) 목록(cells)으로 줍니다. 편집은 이 (행,열)을 set_cell/format_cell 등에 그대로 쓰면 됩니다. controlIdx 생략 시 해당 문단의 첫 표.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional() },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`);
      const cells = tableCells(doc, ref).map(c => ({
        row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
        text: readCell(doc, ref.section, ref.paragraph, ref.controlIdx, c.cellIdx),
      }));
      return jsonResult({ section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, rows: ref.rows, cols: ref.cols, merged: cells.some(c => c.rowSpan > 1 || c.colSpan > 1), cells });
    },
  ),

  // ────────────────── 표: 셀 내용 편집 ──────────────────
  defineTool(
    'set_cell',
    '표의 특정 칸(행·열, 0-기반) 내용을 새 텍스트로 교체합니다. 병합 셀도 올바르게 처리하며, 병합된 칸은 그 영역 아무 (행,열)로 지정해도 됩니다. 편집 전 read_table 로 현재 값을 확인하세요.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0), col: z.number().int().min(0),
      text: z.string().describe('셀에 넣을 텍스트 (빈 문자열이면 비움)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`);
      const cellIdx = resolveCellIdx(tableCells(doc, ref), args.row, args.col);
      if (cellIdx === null) return errResult(`칸 (${args.row},${args.col}) 없음 — 표 크기 ${ref.rows}×${ref.cols}(병합 포함).`);
      const { ok, note } = replaceCellText(doc, ref, cellIdx, args.text);
      if (!ok) return errResult('셀 텍스트 교체 실패.');
      holder.dirty = true;
      return jsonResult({ ok: true, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, row: args.row, col: args.col, text: args.text, note });
    },
  ),

  // ────────────────── 표: 구조 편집 ──────────────────
  defineTool(
    'add_table_row',
    '표에 행을 추가합니다. atRow 기준으로 above/below 위치에 삽입합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      atRow: z.number().int().min(0).describe('기준 행 (0-기반)'),
      position: z.enum(['above', 'below']).optional().describe('기본 below'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const raw = doc.insertTableRow(ref.section, ref.paragraph, ref.controlIdx, args.atRow, (args.position ?? 'below') === 'below');
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  ),

  defineTool(
    'add_table_column',
    '표에 열을 추가합니다. atCol 기준으로 left/right 위치에 삽입합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      atCol: z.number().int().min(0).describe('기준 열 (0-기반)'),
      position: z.enum(['left', 'right']).optional().describe('기본 right'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const raw = doc.insertTableColumn(ref.section, ref.paragraph, ref.controlIdx, args.atCol, (args.position ?? 'right') === 'right');
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  ),

  defineTool(
    'delete_table_row',
    '표의 특정 행을 삭제합니다.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(), row: z.number().int().min(0) },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const raw = doc.deleteTableRow(ref.section, ref.paragraph, ref.controlIdx, args.row);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  ),

  defineTool(
    'delete_table_column',
    '표의 특정 열을 삭제합니다.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(), col: z.number().int().min(0) },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const raw = doc.deleteTableColumn(ref.section, ref.paragraph, ref.controlIdx, args.col);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  ),

  defineTool(
    'delete_table',
    '표 전체를 삭제합니다. 되돌릴 수 없으니 대상 표를 read_table/list_tables 로 먼저 확인하세요.',
    { section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional() },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const raw = doc.deleteTableControl(ref.section, ref.paragraph, ref.controlIdx);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  ),

  // ────────────────── 서식 ──────────────────
  defineTool(
    'format_text',
    '본문 문단의 서식(글꼴·크기·굵게·기울임·밑줄·색)과 문단 정렬(align)을 바꿉니다. 오프셋 생략 시 문단 전체. 표 셀에는 format_cell 을 쓰세요.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0),
      startOffset: z.number().int().min(0).optional(), endOffset: z.number().int().min(0).optional(),
      ...FORMAT_FIELDS,
    },
    (holder, args) => {
      const doc = holder.doc;
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return errResult('적용할 서식이 지정되지 않았습니다.');
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
  ),

  defineTool(
    'format_cell',
    '표의 특정 칸(행·열) 전체에 글자 서식과 문단 정렬(align)을 적용합니다. 병합 셀도 올바르게 처리합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0), col: z.number().int().min(0),
      ...FORMAT_FIELDS,
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const cellIdx = resolveCellIdx(tableCells(doc, ref), args.row, args.col);
      if (cellIdx === null) return errResult(`칸 (${args.row},${args.col}) 없음.`);
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return errResult('적용할 서식이 지정되지 않았습니다.');
      let ok = false;
      if (applied.length > 0) ok = formatCellRuns(doc, ref, cellIdx, JSON.stringify(props)) || ok;
      if (args.align) { ok = alignCellParas(doc, ref, cellIdx, args.align) || ok; applied.push(`정렬=${args.align}`); }
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, row: args.row, col: args.col, applied });
    },
  ),

  defineTool(
    'format_table',
    '표의 모든 칸에 글자 서식과 문단 정렬(align)을 한 번에 적용합니다. 병합 셀 포함 실제 셀만 정확히 처리합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      ...FORMAT_FIELDS,
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return errResult('적용할 서식이 지정되지 않았습니다.');
      const propsJson = JSON.stringify(props);
      let cells = 0;
      for (const c of tableCells(doc, ref)) {
        let cellOk = false;
        if (applied.length > 0) cellOk = formatCellRuns(doc, ref, c.cellIdx, propsJson) || cellOk;
        if (args.align) cellOk = alignCellParas(doc, ref, c.cellIdx, args.align) || cellOk;
        if (cellOk) cells++;
      }
      if (args.align) applied.push(`정렬=${args.align}`);
      if (cells > 0) holder.dirty = true;
      return jsonResult({ ok: cells > 0, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, cellsFormatted: cells, applied });
    },
  ),

  defineTool(
    'set_cell_background',
    '표 셀의 배경색을 설정합니다. 대상: row+col=그 칸, row만=그 행 전체, col만=그 열 전체, 둘 다 생략=표 전체 (병합-aware). 색은 #RRGGBB, "none" 이면 배경 제거. 테두리는 보존됩니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      color: z.union([z.string().regex(/^#?[0-9a-fA-F]{6}$/), z.literal('none')]).describe('#RRGGBB 또는 "none"'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const t = targetCellIdxs(doc, ref, args.row, args.col);
      if ('error' in t) return errResult(t.error);
      const fillColor = args.color === 'none' ? null : normalizeHex(args.color);
      let n = 0;
      for (const cellIdx of t.ids) if (writeCellBorderFill(doc, ref, cellIdx, { fillColor })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.scope, color: args.color });
    },
  ),

  defineTool(
    'set_cell_border',
    '표 셀의 테두리를 설정합니다. 대상: row+col=그 칸, row만=그 행 전체, col만=그 열 전체, 둘 다 생략=표 전체 (병합-aware). sides=all/top/bottom/left/right, style=solid/none. 배경은 보존됩니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      sides: z.enum(['all', 'top', 'bottom', 'left', 'right']).optional().describe('기본 all'),
      style: z.enum(['solid', 'none']).optional().describe('기본 solid'),
      width: z.number().int().min(0).max(16).optional().describe('선 굵기 단계(0~16). 기본 2'),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe('선 색 #RRGGBB. 기본 #000000'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const t = targetCellIdxs(doc, ref, args.row, args.col);
      if ('error' in t) return errResult(t.error);
      const sidesArg = args.sides ?? 'all';
      const sides = sidesArg === 'all' ? (['top', 'right', 'bottom', 'left'] as const).slice() : [sidesArg];
      const line: BorderLine = { type: (args.style ?? 'solid') === 'none' ? 0 : 1, width: args.width ?? 2, color: normalizeHex(args.color ?? '#000000') };
      let n = 0;
      for (const cellIdx of t.ids) if (writeCellBorderFill(doc, ref, cellIdx, { sides: sides as Array<'top' | 'right' | 'bottom' | 'left'>, line })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.scope, sides: sidesArg, style: args.style ?? 'solid' });
    },
  ),

  defineTool(
    'set_cell_layout',
    '표 셀의 세로 정렬(verticalAlign: top/middle/bottom)을 설정합니다. 대상: row+col=그 칸, row만=그 행 전체, col만=그 열 전체, 둘 다 생략=표 전체 (병합-aware).',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      verticalAlign: z.enum(['top', 'middle', 'bottom']),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const t = targetCellIdxs(doc, ref, args.row, args.col);
      if ('error' in t) return errResult(t.error);
      const va = args.verticalAlign === 'top' ? 0 : args.verticalAlign === 'bottom' ? 2 : 1;
      let n = 0;
      for (const cellIdx of t.ids) if (mergeCellProps(doc, ref, cellIdx, { verticalAlign: va })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.scope, verticalAlign: args.verticalAlign });
    },
  ),

  defineTool(
    'set_table_options',
    '표 옵션을 설정합니다. repeatHeader=true 면 표가 페이지를 넘길 때 첫 행(제목행)을 매 페이지 반복합니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      repeatHeader: z.boolean().optional(),
    },
    (holder, args) => {
      const ref = findTable(holder.doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      if (args.repeatHeader === undefined) return errResult('설정할 옵션이 없습니다.');
      const ok = mergeTableProps(holder.doc, ref, { repeatHeader: args.repeatHeader });
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, repeatHeader: args.repeatHeader });
    },
  ),

  defineTool(
    'set_cell_padding',
    '표 셀의 안쪽 여백(padding)을 mm 단위로 설정합니다. 대상: row+col=그 칸, row만=그 행 전체, col만=그 열 전체, 둘 다 생략=표 전체 (병합-aware). left/right/top/bottom 중 준 것만 바뀝니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).optional(), col: z.number().int().min(0).optional(),
      left: z.number().min(0).max(50).optional().describe('왼쪽 여백(mm)'),
      right: z.number().min(0).max(50).optional().describe('오른쪽 여백(mm)'),
      top: z.number().min(0).max(50).optional().describe('위 여백(mm)'),
      bottom: z.number().min(0).max(50).optional().describe('아래 여백(mm)'),
    },
    (holder, args) => {
      const ref = findTable(holder.doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const override: Record<string, unknown> = {};
      if (args.left !== undefined) override.paddingLeft = mmToHwpUnit(args.left);
      if (args.right !== undefined) override.paddingRight = mmToHwpUnit(args.right);
      if (args.top !== undefined) override.paddingTop = mmToHwpUnit(args.top);
      if (args.bottom !== undefined) override.paddingBottom = mmToHwpUnit(args.bottom);
      if (Object.keys(override).length === 0) return errResult('설정할 여백(left/right/top/bottom)이 없습니다.');
      const t = targetCellIdxs(holder.doc, ref, args.row, args.col);
      if ('error' in t) return errResult(t.error);
      let n = 0;
      for (const cellIdx of t.ids) if (mergeCellProps(holder.doc, ref, cellIdx, override)) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: t.scope, paddingMm: { left: args.left, right: args.right, top: args.top, bottom: args.bottom } });
    },
  ),

  defineTool(
    'set_column_width',
    '표의 특정 열(col, 0-기반) 너비를 mm 단위로 설정합니다(해당 열의 모든 단일 셀에 적용). 표 전체 너비는 고정이라 한 열을 넓히면 다른 열이 좁아질 수 있습니다. 병합으로 여러 열을 걸친 셀은 건너뜁니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      col: z.number().int().min(0).describe('대상 열 (0-기반)'),
      widthMm: z.number().positive().max(400).describe('열 너비(mm)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const cells = tableCells(doc, ref).filter(c => c.col === args.col && c.colSpan === 1);
      if (cells.length === 0) return errResult(`열 ${args.col} 에 너비를 조정할 단일 셀이 없습니다(범위 초과 또는 전부 병합).`);
      const w = mmToHwpUnit(args.widthMm);
      let n = 0;
      for (const c of cells) if (mergeCellProps(doc, ref, c.cellIdx, { width: w })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, col: args.col, cellsChanged: n, widthMm: args.widthMm });
    },
  ),

  defineTool(
    'set_table_cell_spacing',
    '표의 셀 간격(cellSpacing)을 mm 단위로 설정합니다. 0 이면 셀이 서로 붙습니다. 표 전체에 적용됩니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      spacingMm: z.number().min(0).max(20).describe('셀 간격(mm)'),
    },
    (holder, args) => {
      const ref = findTable(holder.doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const ok = mergeTableProps(holder.doc, ref, { cellSpacing: mmToHwpUnit(args.spacingMm) });
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, spacingMm: args.spacingMm });
    },
  ),

  defineTool(
    'resize_table',
    '표 전체 너비를 mm 단위로 조정합니다. 모든 열 너비를 현재 비율을 유지한 채 목표 너비에 맞춰 비례 확대/축소합니다. (한글의 "표 가장자리 끌어 크기 조정"에 해당. 표 전체 너비 자체는 레이아웃 계산값이라, 실제로는 열 너비를 비례 조정하는 방식입니다.)',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      widthMm: z.number().positive().max(500).describe('목표 표 전체 너비(mm)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const cells = tableCells(doc, ref);
      const single = cells.filter(c => c.colSpan === 1);
      if (single.length === 0) return errResult('너비를 조정할 단일 열 셀이 없습니다.');
      // 각 열의 대표 너비(그 열 첫 단일셀)를 모아 현재 전체 너비 추정.
      const repByCol = new Map<number, number>();
      for (const c of single) {
        if (!repByCol.has(c.col)) {
          try { repByCol.set(c.col, JSON.parse(doc.getCellProperties(ref.section, ref.paragraph, ref.controlIdx, c.cellIdx)).width); } catch { /* skip */ }
        }
      }
      const curTotal = [...repByCol.values()].reduce((a, b) => a + b, 0);
      if (curTotal <= 0) return errResult('현재 열 너비를 읽을 수 없습니다.');
      const scale = mmToHwpUnit(args.widthMm) / curTotal;
      let n = 0;
      for (const c of single) {
        try {
          const cur = JSON.parse(doc.getCellProperties(ref.section, ref.paragraph, ref.controlIdx, c.cellIdx));
          if (mergeCellProps(doc, ref, c.cellIdx, { width: Math.max(1, Math.round((cur.width as number) * scale)) })) n++;
        } catch { /* skip */ }
      }
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, targetWidthMm: args.widthMm, scale: Number(scale.toFixed(3)) });
    },
  ),

  defineTool(
    'set_row_height',
    '표의 특정 행(row, 0-기반) 높이를 mm 단위로 설정합니다(그 행 셀들의 최소 높이). 표 전체 높이는 각 행 높이의 합으로 계산됩니다. 내용이 많으면 지정 높이보다 커질 수 있습니다(최소 높이로 동작). 여러 행을 걸친 병합 셀은 건너뜁니다.',
    {
      section: z.number().int().min(0), paragraph: z.number().int().min(0), controlIdx: z.number().int().min(0).optional(),
      row: z.number().int().min(0).describe('대상 행 (0-기반)'),
      heightMm: z.number().positive().max(400).describe('행 높이(mm)'),
    },
    (holder, args) => {
      const doc = holder.doc;
      const ref = findTable(doc, args.section, args.paragraph, args.controlIdx);
      if (!ref) return errResult('표가 없습니다.');
      const cells = tableCells(doc, ref).filter(c => c.row === args.row && c.rowSpan === 1);
      if (cells.length === 0) return errResult(`행 ${args.row} 에 높이를 조정할 단일 셀이 없습니다(범위 초과 또는 전부 병합).`);
      const h = mmToHwpUnit(args.heightMm);
      let n = 0;
      for (const c of cells) if (mergeCellProps(doc, ref, c.cellIdx, { height: h })) n++;
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, row: args.row, cellsChanged: n, heightMm: args.heightMm });
    },
  ),
];

/** MCP 정규화 이름(mcp__hwp__*). Claude allowedTools 에 씁니다. */
export const HWP_TOOL_NAMES = HWP_TOOL_SPECS.map(s => `mcp__hwp__${s.name}`);
