import { query } from '@anthropic-ai/claude-agent-sdk';

import { loadDocument } from '@/lib/hwp/server-core';
import { createHwpToolServer, HWP_TOOL_NAMES, type DocHolder } from '@/lib/hwp/tools';

// Agent SDK 는 Claude Code 바이너리를 서브프로세스로 띄우므로 Node 런타임 필수.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MODEL = process.env.HWP_AGENT_MODEL ?? 'claude-sonnet-5';

const SYSTEM_PROMPT = `당신은 한글(HWP) 문서 편집을 돕는 어시스턴트입니다.

문서 좌표계:
- 문서는 구역(section) → 문단(paragraph, 0-기반) → 글자 오프셋(0-기반)으로 구성됩니다.
- 표는 문단 안의 컨트롤이며 셀 내용은 본문 텍스트(read_paragraphs)에 안 나옵니다. 표를 다루려면
  list_tables 로 위치를 찾고 read_table 로 셀을 읽은 뒤 (행,열)로 편집합니다.
- 표 셀은 (행,열, 0-기반)으로 지정합니다. 병합 셀도 처리되며, 병합된 칸은 그 영역 안 아무 (행,열)로 지정해도 됩니다.
  read_table 은 각 셀의 rowSpan/colSpan 을 함께 주니 병합 구조를 파악하고 편집하세요.
- 도구로만 문서에 접근할 수 있습니다. 문서 내용을 추측하지 말고 항상 도구로 확인하세요.
- 대화가 이어질 때 지난 턴 이후 문서가 바뀌어 인덱스·내용이 달라졌을 수 있습니다. 편집·답변 전
  read_paragraphs / read_table / list_tables 로 현재 상태를 다시 확인하세요.

읽기: get_document_info, read_paragraphs, search_text(본문), find_text(본문+표 셀), list_tables, read_table
본문 편집: insert_text, delete_range, replace_text, insert_table
표 셀 내용: set_cell(행,열 지정)
표 구조: add_table_row, add_table_column, delete_table_row, delete_table_column, delete_table
서식: format_text(본문), format_cell(표 한 칸), format_table(표 전체) — 글꼴·크기(pt)·굵게·기울임·밑줄·색·정렬(align)
표 셀 꾸밈: set_cell_background(배경색), set_cell_border(테두리), set_cell_layout(세로정렬), set_table_options(repeatHeader=제목행 반복)
표 간격·크기: set_cell_padding(셀 안 여백 mm), set_column_width(열 너비 mm), set_table_cell_spacing(셀 간격 mm)
- 배경/테두리/세로정렬/여백 대상: row+col=그 칸, **row만=그 행 전체**, col만=그 열 전체, 둘 다 생략=표 전체. 여백·너비·간격은 mm 단위.
- "제목행(1행)은 여유있게, 2·3행은 타이트하게" 같은 행별 조정 → set_cell_padding 을 행마다 col 없이 호출: set_cell_padding(row:0, top:3, bottom:3), set_cell_padding(row:1, top:1.5, bottom:1.5) …

작업 원칙:
- 표 안 내용을 찾을 땐 find_text 를 씁니다(search_text/replace_text 는 표 셀에 못 닿음). 표 셀을 고칠 땐 read_table 로
  현재 값·행·열을 확인한 뒤 set_cell 로 교체합니다. "표에서 A를 B로" → find_text 로 (행,열) 찾기 → set_cell.
- 본문 편집은 가능하면 replace_text. 오프셋 기반 insert_text/delete_range 는 대상 문단을 먼저 읽고 사용합니다.
- 서식은 내용 편집과 별개입니다. "표 전체 맑은 고딕 20pt 가운데" → format_table(fontName:"맑은 고딕", fontSize:20, align:"center"). 크기는 pt.
- 예: "가운데 정렬"→format_*(align:"center"), "3번째 행 삭제"→delete_table_row(row:2), "표 아래 행 추가"→add_table_row(atRow, position:"below"), "머리행 회색"→set_cell_background(row:0 각 열 또는 표전체).
- 한국어로 간결하게. 요청한 것만 수행하고, 편집 후 무엇을 바꿨는지 한두 문장 요약.`;

type ChatEvent =
  | { type: 'system'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'document'; hwpBase64: string }
  | { type: 'result'; text: string; isError: boolean }
  | { type: 'error'; message: string };

export async function POST(request: Request): Promise<Response> {
  let prompt: string;
  let bytes: Uint8Array;
  let resumeSessionId: string | undefined;
  try {
    const form = await request.formData();
    prompt = String(form.get('prompt') ?? '').trim();
    resumeSessionId = String(form.get('sessionId') ?? '').trim() || undefined;
    const file = form.get('file');
    if (!prompt) return Response.json({ error: '메시지가 비어 있습니다.' }, { status: 400 });
    if (!(file instanceof Blob)) return Response.json({ error: '문서 파일이 없습니다.' }, { status: 400 });
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const holder: DocHolder = { doc: await loadDocument(bytes), dirty: false };
  // 배치 모드: 편집 커맨드마다 재-pagination 하지 않고 export 직전에 한 번만 처리.
  holder.doc.beginBatch();
  const toolServer = createHwpToolServer(holder);

  // 구독제(Claude Pro/Max) 인증을 강제합니다. 서브프로세스는 CLAUDE_CODE_OAUTH_TOKEN
  // (`claude setup-token` 으로 발급) 또는 이미 로그인된 Claude Code 자격증명(~/.claude)을
  // 사용합니다. env 를 지정하면 process.env 를 통째로 치환하므로 직접 스프레드하고,
  // ANTHROPIC_API_KEY 는 제거해 사용량 과금이 구독 인증을 가리지 못하게 합니다.
  const subprocessEnv: Record<string, string | undefined> = { ...process.env };
  delete subprocessEnv.ANTHROPIC_API_KEY;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      try {
        for await (const message of query({
          prompt,
          options: {
            model: MODEL,
            systemPrompt: SYSTEM_PROMPT,
            mcpServers: { hwp: toolServer },
            allowedTools: HWP_TOOL_NAMES,
            tools: [], // 내장 도구(파일시스템·Bash 등) 전부 비활성화 — 우리 MCP 도구만.
            settingSources: [], // 파일시스템 설정/CLAUDE.md 로드 안 함.
            permissionMode: 'dontAsk', // 사전 승인 도구만 실행, 나머지 거부, 프롬프트 없음.
            env: subprocessEnv, // 구독 토큰 우선 (위에서 API 키 제거).
            // 이전 대화 맥락 유지: 클라이언트가 보낸 세션 ID 가 있으면 그 세션을 이어갑니다.
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          },
        })) {
          if (message.type === 'system' && message.subtype === 'init') {
            send({ type: 'system', sessionId: message.session_id });
          } else if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                send({ type: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                send({ type: 'tool', name: block.name, input: block.input });
              }
            }
          } else if (message.type === 'result') {
            send({
              type: 'result',
              text: message.subtype === 'success' ? message.result : `(${message.subtype})`,
              isError: message.subtype !== 'success',
            });
          }
        }
        // 편집이 있었으면 문서를 직렬화해 클라이언트로 되돌려 보냅니다.
        if (holder.dirty) {
          holder.doc.endBatch();
          // 편집으로 미계산된 줄 배치(lineseg)를 재계산해 "HWPX 비표준" 경고·렌더 품질 저하를 완화.
          try { holder.doc.reflowLinesegs(); } catch { /* 헤드리스에서 실패해도 무시 */ }
          const out = holder.doc.exportHwp();
          const base64 = Buffer.from(out).toString('base64');
          send({ type: 'document', hwpBase64: base64 });
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // 인증 관련 오류면 구독 설정법을 덧붙여 안내(특히 갓 클론한 사용자).
        const isAuth = /auth|login|token|oauth|credential|api[_ ]?key|unauthor|not logged/i.test(raw);
        const message = isAuth
          ? `${raw}\n\n구독(Claude Pro/Max) 인증이 필요합니다. \`claude setup-token\` 으로 발급한 토큰을 .env.local 의 CLAUDE_CODE_OAUTH_TOKEN 에 넣거나 Claude Code 에 로그인하세요. (.env.example 참고)`
          : raw;
        send({ type: 'error', message });
      } finally {
        holder.doc.free?.();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
