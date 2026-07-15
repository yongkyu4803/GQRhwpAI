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

/** 표를 rows×cols 그리드(행 우선)로 읽습니다. */
function readTableGrid(doc: HwpDocument, ref: TableRef): string[][] {
  const grid: string[][] = [];
  for (let r = 0; r < ref.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < ref.cols; c++) {
      row.push(readCell(doc, ref.section, ref.paragraph, ref.controlIdx, r * ref.cols + c));
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Phase 1: 읽기 전용 도구 3종. 문서는 브라우저가 아니라 서버의 HwpDocument
 * 인스턴스(holder.doc)에 있으며, 도구는 인프로세스로 이 인스턴스를 조회합니다.
 */
export function createHwpToolServer(holder: DocHolder) {
  const getDocumentInfo = tool(
    'get_document_info',
    '현재 열린 HWP 문서의 구조 요약을 반환합니다. 구역(section) 수, 각 구역의 문단(paragraph) 수, 페이지 수, 사용 글꼴 등. 편집·읽기 전에 문서 구조를 파악할 때 먼저 호출하세요.',
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
    `지정한 구역의 문단 텍스트를 읽습니다. 좌표계는 구역(section) → 문단(paragraph, 0-기반) → 글자 오프셋입니다. 한 번에 최대 ${MAX_PARAGRAPHS_PER_READ}개 문단까지 반환합니다. 넓은 범위는 start 를 옮겨가며 여러 번 호출하세요.`,
    {
      section: z.number().int().min(0).describe('구역 인덱스 (0-기반)'),
      start: z.number().int().min(0).describe('시작 문단 인덱스 (0-기반)'),
      count: z
        .number()
        .int()
        .min(1)
        .max(MAX_PARAGRAPHS_PER_READ)
        .optional()
        .describe(`읽을 문단 수 (기본 ${MAX_PARAGRAPHS_PER_READ}, 최대 ${MAX_PARAGRAPHS_PER_READ})`),
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
        // 이 문단에 표가 있으면 표시합니다(본문 텍스트에는 셀 내용이 안 나오므로).
        const tables = tablesInParagraph(doc, args.section, p);
        if (tables.length > 0) {
          entry.tables = tables.map(t => ({ controlIdx: t.controlIdx, rows: t.rows, cols: t.cols }));
        }
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
    '문서 전체에서 문자열을 검색해 위치(구역·문단·글자 오프셋)와 해당 문단 텍스트를 반환합니다. 특정 내용을 찾아 편집 대상 위치를 파악할 때 사용하세요.',
    {
      query: z.string().min(1).describe('검색할 문자열'),
      caseSensitive: z.boolean().optional().describe('대소문자 구분 (기본 false)'),
    },
    async (args) => {
      const doc = holder.doc;
      const raw = doc.searchText(args.query, 0, 0, 0, true, args.caseSensitive ?? false);
      const hit = JSON.parse(raw) as {
        found: boolean;
        sec?: number;
        para?: number;
        charOffset?: number;
        length?: number;
      };
      if (!hit.found || hit.sec === undefined || hit.para === undefined) {
        return jsonResult({ found: false });
      }
      return jsonResult({
        found: true,
        section: hit.sec,
        paragraph: hit.para,
        charOffset: hit.charOffset,
        length: hit.length,
        paragraphText: readParagraph(doc, hit.sec, hit.para),
      });
    },
  );

  // ── 편집 도구 (Phase 2) ──
  // core 메서드는 성공 시 {"ok":true,...}, 실패 시 오류 문자열/JSON 을 반환합니다.
  // 반환 문자열을 그대로 모델에 돌려주고, 성공하면 holder.dirty 를 세웁니다.
  function parseOk(raw: string): boolean {
    try {
      return JSON.parse(raw)?.ok === true;
    } catch {
      return false;
    }
  }

  const insertText = tool(
    'insert_text',
    '지정한 위치(구역·문단·글자 오프셋)에 텍스트를 삽입합니다. 오프셋은 0-기반이며, 문단 끝에 붙이려면 read_paragraphs 로 확인한 글자 길이를 오프셋으로 사용합니다. 편집 전 반드시 해당 문단을 읽어 위치를 확인하세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      charOffset: z.number().int().min(0).describe('삽입할 글자 오프셋 (0-기반)'),
      text: z.string().min(1).describe('삽입할 텍스트'),
    },
    async (args) => {
      const raw = holder.doc.insertText(args.section, args.paragraph, args.charOffset, args.text);
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const deleteRange = tool(
    'delete_range',
    '구역 내 [시작 문단·오프셋, 끝 문단·오프셋) 범위의 내용을 삭제합니다. 오프셋은 0-기반. 한 문단 안에서 지우려면 시작·끝 문단을 같게 두고 오프셋만 다르게 지정합니다. 삭제 전 반드시 대상 범위를 읽어 확인하세요.',
    {
      section: z.number().int().min(0),
      startParagraph: z.number().int().min(0),
      startOffset: z.number().int().min(0),
      endParagraph: z.number().int().min(0),
      endOffset: z.number().int().min(0),
    },
    async (args) => {
      const raw = holder.doc.deleteRange(
        args.section,
        args.startParagraph,
        args.startOffset,
        args.endParagraph,
        args.endOffset,
      );
      if (parseOk(raw)) holder.dirty = true;
      return textResult(raw);
    },
  );

  const replaceText = tool(
    'replace_text',
    '문서에서 문자열을 찾아 다른 문자열로 교체합니다. 첫 번째 일치 위치를 교체하며, 정확한 오프셋을 몰라도 되므로 편집의 기본 수단으로 권장합니다. 같은 문자열이 여러 번 나오면 여러 번 호출하세요.',
    {
      query: z.string().min(1).describe('찾을 문자열'),
      replacement: z.string().describe('바꿀 문자열 (빈 문자열이면 삭제)'),
      caseSensitive: z.boolean().optional(),
    },
    async (args) => {
      const doc = holder.doc;
      const hit = JSON.parse(doc.searchText(args.query, 0, 0, 0, true, args.caseSensitive ?? false)) as {
        found: boolean;
        sec?: number;
        para?: number;
        charOffset?: number;
        length?: number;
      };
      if (!hit.found || hit.sec === undefined || hit.para === undefined || hit.charOffset === undefined || hit.length === undefined) {
        return { ...jsonResult({ ok: false, reason: 'not_found', query: args.query }), isError: true };
      }
      const del = doc.deleteText(hit.sec, hit.para, hit.charOffset, hit.length);
      if (!parseOk(del)) return { ...textResult(del), isError: true };
      let ok = true;
      if (args.replacement.length > 0) {
        const ins = doc.insertText(hit.sec, hit.para, hit.charOffset, args.replacement);
        ok = parseOk(ins);
        if (!ok) return { ...textResult(ins), isError: true };
      }
      holder.dirty = true;
      return jsonResult({
        ok,
        section: hit.sec,
        paragraph: hit.para,
        charOffset: hit.charOffset,
        replaced: args.query,
        with: args.replacement,
        paragraphText: readParagraph(doc, hit.sec, hit.para),
      });
    },
  );

  const insertTable = tool(
    'insert_table',
    '지정한 위치(구역·문단·글자 오프셋)에 rows×cols 표를 삽입합니다. cells 를 주면 각 칸을 채웁니다(행 우선: cells[행][열]). 예: 2×2 표에 구분/내용 헤더 → rows=2, cols=2, cells=[["구분","내용"],["",""]].',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0).describe('표를 넣을 문단 인덱스 (0-기반)'),
      charOffset: z.number().int().min(0).describe('삽입 글자 오프셋 (보통 0)'),
      rows: z.number().int().min(1).max(50),
      cols: z.number().int().min(1).max(20),
      cells: z
        .array(z.array(z.string()))
        .optional()
        .describe('칸 내용 2차원 배열 [행][열]. 생략 시 빈 표.'),
    },
    async (args) => {
      const doc = holder.doc;
      const raw = doc.createTable(args.section, args.paragraph, args.charOffset, args.rows, args.cols);
      const created = (() => {
        try {
          return JSON.parse(raw) as { ok?: boolean; paraIdx?: number; controlIdx?: number };
        } catch {
          return null;
        }
      })();
      if (!created?.ok || created.paraIdx === undefined || created.controlIdx === undefined) {
        return { ...textResult(raw), isError: true };
      }
      holder.dirty = true;
      // 칸 채우기 (행 우선 선형 인덱스: row*cols + col).
      const filled: string[] = [];
      if (args.cells) {
        for (let r = 0; r < args.rows; r++) {
          for (let c = 0; c < args.cols; c++) {
            const text = args.cells[r]?.[c];
            if (!text) continue;
            const cellIdx = r * args.cols + c;
            const ins = doc.insertTextInCell(args.section, created.paraIdx, created.controlIdx, cellIdx, 0, 0, text);
            if (parseOk(ins)) filled.push(`(${r},${c})="${text}"`);
          }
        }
      }
      return jsonResult({
        ok: true,
        section: args.section,
        paragraph: created.paraIdx,
        controlIdx: created.controlIdx,
        rows: args.rows,
        cols: args.cols,
        filled,
      });
    },
  );

  const listTables = tool(
    'list_tables',
    '문서 전체의 표 목록을 반환합니다. 각 표의 위치(구역·문단·controlIdx)와 크기(행×열). 표를 다루기 전에 먼저 호출해 어떤 표가 어디 있는지 파악하세요. 셀 내용은 read_table 로 읽습니다.',
    {},
    async () => {
      const tables = listAllTables(holder.doc);
      return jsonResult({ count: tables.length, tables });
    },
  );

  const readTable = tool(
    'read_table',
    '지정한 표의 모든 셀 내용을 행×열 그리드(grid[행][열])로 반환합니다. controlIdx 를 생략하면 해당 문단의 첫 표를 읽습니다. 위치는 list_tables 또는 read_paragraphs 의 표 표시로 확인하세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      controlIdx: z.number().int().min(0).optional().describe('생략 시 해당 문단의 첫 표'),
    },
    async (args) => {
      const doc = holder.doc;
      const inPara = tablesInParagraph(doc, args.section, args.paragraph);
      const ref = args.controlIdx === undefined
        ? inPara[0]
        : inPara.find(t => t.controlIdx === args.controlIdx);
      if (!ref) {
        return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      }
      return jsonResult({
        section: ref.section,
        paragraph: ref.paragraph,
        controlIdx: ref.controlIdx,
        rows: ref.rows,
        cols: ref.cols,
        grid: readTableGrid(doc, ref),
      });
    },
  );

  const setCell = tool(
    'set_cell',
    '표의 특정 칸(행·열, 0-기반) 내용을 새 텍스트로 교체합니다. 편집 전 read_table 로 현재 값을 확인하세요. 셀이 여러 문단이면 첫 문단만 교체하고 나머지는 남겨 둡니다.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      controlIdx: z.number().int().min(0).optional().describe('생략 시 해당 문단의 첫 표'),
      row: z.number().int().min(0),
      col: z.number().int().min(0),
      text: z.string().describe('셀에 넣을 텍스트 (빈 문자열이면 비움)'),
    },
    async (args) => {
      const doc = holder.doc;
      const inPara = tablesInParagraph(doc, args.section, args.paragraph);
      const ref = args.controlIdx === undefined
        ? inPara[0]
        : inPara.find(t => t.controlIdx === args.controlIdx);
      if (!ref) {
        return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      }
      if (args.row >= ref.rows || args.col >= ref.cols) {
        return { ...textResult(`칸 (${args.row},${args.col}) 범위 초과 — 표 크기 ${ref.rows}×${ref.cols}.`), isError: true };
      }
      const cellIdx = args.row * ref.cols + args.col;
      // 첫 문단 기존 내용을 지우고 새 텍스트 삽입.
      let multiParaNote: string | undefined;
      try {
        if ((doc.getCellParagraphCount(ref.section, ref.paragraph, ref.controlIdx, cellIdx) || 1) > 1) {
          multiParaNote = '셀에 여러 문단이 있어 첫 문단만 교체했습니다.';
        }
      } catch { /* noop */ }
      const len0 = doc.getCellParagraphLength(ref.section, ref.paragraph, ref.controlIdx, cellIdx, 0);
      if (len0 > 0) {
        const del = doc.deleteTextInCell(ref.section, ref.paragraph, ref.controlIdx, cellIdx, 0, 0, len0);
        if (!parseOk(del)) return { ...textResult(del), isError: true };
      }
      if (args.text.length > 0) {
        const ins = doc.insertTextInCell(ref.section, ref.paragraph, ref.controlIdx, cellIdx, 0, 0, args.text);
        if (!parseOk(ins)) return { ...textResult(ins), isError: true };
      }
      holder.dirty = true;
      return jsonResult({
        ok: true,
        section: ref.section,
        paragraph: ref.paragraph,
        controlIdx: ref.controlIdx,
        row: args.row,
        col: args.col,
        text: args.text,
        note: multiParaNote,
      });
    },
  );

  // 셀 하나의 모든 문단에 글자 서식을 적용합니다.
  function formatCellRuns(section: number, para: number, controlIdx: number, cellIdx: number, propsJson: string): boolean {
    const doc = holder.doc;
    let n = 1;
    try {
      n = doc.getCellParagraphCount(section, para, controlIdx, cellIdx) || 1;
    } catch {
      /* 기본 1문단 */
    }
    let anyOk = false;
    for (let cp = 0; cp < n; cp++) {
      try {
        const len = doc.getCellParagraphLength(section, para, controlIdx, cellIdx, cp);
        if (len <= 0) continue;
        if (parseOk(doc.applyCharFormatInCell(section, para, controlIdx, cellIdx, cp, 0, len, propsJson))) anyOk = true;
      } catch {
        /* 빈/없는 문단 건너뜀 */
      }
    }
    return anyOk;
  }

  // 셀 하나의 모든 문단에 정렬을 적용합니다(문단 서식이라 글자 범위가 없음).
  function alignCellParas(section: number, para: number, controlIdx: number, cellIdx: number, alignment: Align): boolean {
    const doc = holder.doc;
    let n = 1;
    try {
      n = doc.getCellParagraphCount(section, para, controlIdx, cellIdx) || 1;
    } catch {
      /* 기본 1문단 */
    }
    const propsJson = JSON.stringify({ alignment });
    let anyOk = false;
    for (let cp = 0; cp < n; cp++) {
      try {
        if (parseOk(doc.applyParaFormatInCell(section, para, controlIdx, cellIdx, cp, propsJson))) anyOk = true;
      } catch {
        /* 없는 문단 건너뜀 */
      }
    }
    return anyOk;
  }

  // 셀 테두리/배경은 HWP 의 borderFill 레코드로 함께 관리됩니다. 배경(fill)은 테두리와
  // 같은 setCellProperties 호출에 있을 때만 반영되고, 테두리만 바꾸면 기존 배경이 사라질 수
  // 있습니다. 그래서 항상 현재 속성을 읽어 border+fill 전체를 재전송하며 요청분만 덮어씁니다.
  type BorderLine = { type: number; width: number; color: string };
  function writeCellBorderFill(
    section: number,
    para: number,
    controlIdx: number,
    cellIdx: number,
    opts: { sides?: Array<'top' | 'right' | 'bottom' | 'left'>; line?: BorderLine; fillColor?: string | null },
  ): boolean {
    const doc = holder.doc;
    let cur: Record<string, unknown>;
    try {
      cur = JSON.parse(doc.getCellProperties(section, para, controlIdx, cellIdx));
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
      if (opts.fillColor === null) {
        props.fillType = 'none';
      } else {
        props.fillType = 'solid';
        props.fillColor = opts.fillColor;
      }
    }
    return parseOk(doc.setCellProperties(section, para, controlIdx, cellIdx, JSON.stringify(props)));
  }

  function normalizeHex(c: string): string {
    return c.startsWith('#') ? c : `#${c}`;
  }

  // 대상 셀 목록: row·col 지정 시 그 칸 하나, 둘 다 생략 시 표 전체.
  function resolveTargetCells(ref: TableRef, row?: number, col?: number): number[] | { error: string } {
    if (row === undefined && col === undefined) {
      return Array.from({ length: ref.rows * ref.cols }, (_, i) => i);
    }
    if (row === undefined || col === undefined) {
      return { error: 'row 와 col 은 함께 지정하거나 둘 다 생략(표 전체)해야 합니다.' };
    }
    if (row >= ref.rows || col >= ref.cols) {
      return { error: `칸 (${row},${col}) 범위 초과 — 표 크기 ${ref.rows}×${ref.cols}.` };
    }
    return [row * ref.cols + col];
  }

  const setCellBackground = tool(
    'set_cell_background',
    '표 셀의 배경색을 설정합니다. row·col 을 지정하면 그 칸만, 둘 다 생략하면 표 전체에 적용합니다. 색은 #RRGGBB, "none" 이면 배경을 없앱니다. 테두리는 보존됩니다. 위치는 list_tables 로 확인하세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      controlIdx: z.number().int().min(0).optional().describe('생략 시 해당 문단의 첫 표'),
      row: z.number().int().min(0).optional().describe('생략(+col 생략) 시 표 전체'),
      col: z.number().int().min(0).optional(),
      color: z.union([z.string().regex(/^#?[0-9a-fA-F]{6}$/), z.literal('none')]).describe('#RRGGBB 또는 "none"'),
    },
    async (args) => {
      const doc = holder.doc;
      const inPara = tablesInParagraph(doc, args.section, args.paragraph);
      const ref = args.controlIdx === undefined ? inPara[0] : inPara.find(t => t.controlIdx === args.controlIdx);
      if (!ref) return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      const target = resolveTargetCells(ref, args.row, args.col);
      if (!Array.isArray(target)) return { ...textResult(target.error), isError: true };
      const fillColor = args.color === 'none' ? null : normalizeHex(args.color);
      let n = 0;
      for (const cellIdx of target) {
        if (writeCellBorderFill(ref.section, ref.paragraph, ref.controlIdx, cellIdx, { fillColor })) n++;
      }
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: target.length === 1 ? 'cell' : 'table', color: args.color });
    },
  );

  const setCellBorder = tool(
    'set_cell_border',
    '표 셀의 테두리를 설정합니다. row·col 지정 시 그 칸만, 둘 다 생략 시 표 전체. sides 는 all/top/bottom/left/right, style 은 solid(실선)/none(없음). 배경은 보존됩니다. 위치는 list_tables 로 확인하세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      controlIdx: z.number().int().min(0).optional().describe('생략 시 해당 문단의 첫 표'),
      row: z.number().int().min(0).optional().describe('생략(+col 생략) 시 표 전체'),
      col: z.number().int().min(0).optional(),
      sides: z.enum(['all', 'top', 'bottom', 'left', 'right']).optional().describe('기본 all'),
      style: z.enum(['solid', 'none']).optional().describe('기본 solid'),
      width: z.number().int().min(0).max(16).optional().describe('선 굵기 단계(0~16, 클수록 두꺼움). 기본 2'),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe('선 색 #RRGGBB. 기본 #000000'),
    },
    async (args) => {
      const doc = holder.doc;
      const inPara = tablesInParagraph(doc, args.section, args.paragraph);
      const ref = args.controlIdx === undefined ? inPara[0] : inPara.find(t => t.controlIdx === args.controlIdx);
      if (!ref) return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      const target = resolveTargetCells(ref, args.row, args.col);
      if (!Array.isArray(target)) return { ...textResult(target.error), isError: true };
      const sidesArg = args.sides ?? 'all';
      const sides = sidesArg === 'all' ? (['top', 'right', 'bottom', 'left'] as const).slice() : [sidesArg];
      const line: BorderLine = {
        type: (args.style ?? 'solid') === 'none' ? 0 : 1, // 0=없음, 1=실선
        width: args.width ?? 2,
        color: normalizeHex(args.color ?? '#000000'),
      };
      let n = 0;
      for (const cellIdx of target) {
        if (writeCellBorderFill(ref.section, ref.paragraph, ref.controlIdx, cellIdx, { sides: sides as Array<'top' | 'right' | 'bottom' | 'left'>, line })) n++;
      }
      if (n > 0) holder.dirty = true;
      return jsonResult({ ok: n > 0, cellsChanged: n, scope: target.length === 1 ? 'cell' : 'table', sides: sidesArg, style: args.style ?? 'solid' });
    },
  );

  const formatText = tool(
    'format_text',
    '본문 문단의 서식을 바꿉니다: 글자 서식(글꼴·크기·굵게·기울임·밑줄·색)과 문단 정렬(align). 글자 서식은 오프셋을 생략하면 문단 전체에, 정렬은 항상 문단 전체에 적용됩니다. 표 셀에는 format_cell 을 쓰세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      startOffset: z.number().int().min(0).optional().describe('생략 시 0 (글자 서식 범위)'),
      endOffset: z.number().int().min(0).optional().describe('생략 시 문단 끝 (글자 서식 범위)'),
      ...FORMAT_FIELDS,
    },
    async (args) => {
      const doc = holder.doc;
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) {
        return { ...textResult('적용할 서식이 지정되지 않았습니다.'), isError: true };
      }
      let ok = true;
      if (applied.length > 0) {
        const len = doc.getParagraphLength(args.section, args.paragraph);
        const start = args.startOffset ?? 0;
        const end = args.endOffset ?? len;
        ok = parseOk(doc.applyCharFormat(args.section, args.paragraph, start, end, JSON.stringify(props))) && ok;
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
    '표의 특정 칸(행·열, 0-기반) 전체에 글자 서식과 문단 정렬(align)을 적용합니다. 셀 안 모든 문단에 적용됩니다. 위치는 list_tables 로 확인하세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      controlIdx: z.number().int().min(0).optional().describe('생략 시 해당 문단의 첫 표'),
      row: z.number().int().min(0),
      col: z.number().int().min(0),
      ...FORMAT_FIELDS,
    },
    async (args) => {
      const doc = holder.doc;
      const inPara = tablesInParagraph(doc, args.section, args.paragraph);
      const ref = args.controlIdx === undefined ? inPara[0] : inPara.find(t => t.controlIdx === args.controlIdx);
      if (!ref) return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      if (args.row >= ref.rows || args.col >= ref.cols) {
        return { ...textResult(`칸 (${args.row},${args.col}) 범위 초과 — 표 크기 ${ref.rows}×${ref.cols}.`), isError: true };
      }
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return { ...textResult('적용할 서식이 지정되지 않았습니다.'), isError: true };
      const cellIdx = args.row * ref.cols + args.col;
      let ok = false;
      if (applied.length > 0) ok = formatCellRuns(ref.section, ref.paragraph, ref.controlIdx, cellIdx, JSON.stringify(props)) || ok;
      if (args.align) {
        ok = alignCellParas(ref.section, ref.paragraph, ref.controlIdx, cellIdx, args.align) || ok;
        applied.push(`정렬=${args.align}`);
      }
      if (ok) holder.dirty = true;
      return jsonResult({ ok, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, row: args.row, col: args.col, applied });
    },
  );

  const formatTable = tool(
    'format_table',
    '표의 모든 칸에 글자 서식과 문단 정렬(align)을 한 번에 적용합니다. "표 전체 글꼴/크기/정렬을 바꿔줘" 같은 요청에 사용하세요. 위치는 list_tables 로 확인하세요.',
    {
      section: z.number().int().min(0),
      paragraph: z.number().int().min(0),
      controlIdx: z.number().int().min(0).optional().describe('생략 시 해당 문단의 첫 표'),
      ...FORMAT_FIELDS,
    },
    async (args) => {
      const doc = holder.doc;
      const inPara = tablesInParagraph(doc, args.section, args.paragraph);
      const ref = args.controlIdx === undefined ? inPara[0] : inPara.find(t => t.controlIdx === args.controlIdx);
      if (!ref) return { ...textResult(`구역 ${args.section} 문단 ${args.paragraph} 에 표가 없습니다.`), isError: true };
      const { props, applied } = buildCharProps(doc, args);
      if (applied.length === 0 && !args.align) return { ...textResult('적용할 서식이 지정되지 않았습니다.'), isError: true };
      const propsJson = JSON.stringify(props);
      const total = ref.rows * ref.cols;
      let cells = 0;
      for (let cell = 0; cell < total; cell++) {
        let cellOk = false;
        if (applied.length > 0) cellOk = formatCellRuns(ref.section, ref.paragraph, ref.controlIdx, cell, propsJson) || cellOk;
        if (args.align) cellOk = alignCellParas(ref.section, ref.paragraph, ref.controlIdx, cell, args.align) || cellOk;
        if (cellOk) cells++;
      }
      if (args.align) applied.push(`정렬=${args.align}`);
      if (cells > 0) holder.dirty = true;
      return jsonResult({ ok: cells > 0, section: ref.section, paragraph: ref.paragraph, controlIdx: ref.controlIdx, cellsFormatted: cells, applied });
    },
  );

  return createSdkMcpServer({
    name: 'hwp',
    version: '0.1.0',
    tools: [
      getDocumentInfo,
      readParagraphs,
      searchText,
      insertText,
      deleteRange,
      replaceText,
      insertTable,
      listTables,
      readTable,
      setCell,
      formatText,
      formatCell,
      formatTable,
      setCellBackground,
      setCellBorder,
    ],
  });
}

/** allowedTools 에 넘길 정규화된 도구 이름 목록. */
export const HWP_TOOL_NAMES = [
  'mcp__hwp__get_document_info',
  'mcp__hwp__read_paragraphs',
  'mcp__hwp__search_text',
  'mcp__hwp__insert_text',
  'mcp__hwp__delete_range',
  'mcp__hwp__replace_text',
  'mcp__hwp__insert_table',
  'mcp__hwp__list_tables',
  'mcp__hwp__read_table',
  'mcp__hwp__set_cell',
  'mcp__hwp__format_text',
  'mcp__hwp__format_cell',
  'mcp__hwp__format_table',
  'mcp__hwp__set_cell_background',
  'mcp__hwp__set_cell_border',
];
