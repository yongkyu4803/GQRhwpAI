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
- 표는 문단 안의 컨트롤입니다. 표의 셀 내용은 본문 텍스트(read_paragraphs)에 나오지 않습니다.
  표를 다루려면 list_tables 로 위치(구역·문단·controlIdx)를 찾고, read_table 로 셀 그리드를 읽은 뒤,
  set_cell 로 특정 칸(행·열, 0-기반)을 편집합니다. search_text / replace_text 는 셀 안을 찾지 못합니다.
- 도구로만 문서에 접근할 수 있습니다. 문서 내용을 추측하지 말고 항상 도구로 확인하세요.
- 대화가 이어지는 경우, 지난 턴 이후 사용자의 수정이나 이전 편집으로 문서가 바뀌어 문단·표 인덱스와
  내용이 달라졌을 수 있습니다. 지난 턴의 도구 결과를 그대로 신뢰하지 말고, 편집·답변 전 read_paragraphs /
  read_table / list_tables 로 현재 상태를 다시 확인하세요.

읽기 도구: get_document_info, read_paragraphs, search_text, list_tables, read_table
내용 편집 도구: insert_text, delete_range, replace_text, insert_table, set_cell
서식 도구(글꼴·크기·굵게·기울임·밑줄·색·문단 정렬): format_text(본문), format_cell(표 한 칸), format_table(표 전체)
- 문단 정렬은 서식 도구의 align 인자로 지정합니다: "left"|"center"|"right"|"justify". 예: "이 표 가운데 정렬" → format_table(align:"center").
표 셀 배경·테두리: set_cell_background(배경색), set_cell_border(테두리)
- 둘 다 row·col 지정 시 그 칸만, 생략 시 표 전체에 적용됩니다. 예: "표 전체 배경 노랑" → set_cell_background(color:"#FFFF00"),
  "3번째 칸 테두리 빨간 실선" → set_cell_border(row,col, style:"solid", color:"#FF0000").

작업 원칙:
- 답변하거나 편집하기 전에 필요한 부분을 read_paragraphs / search_text / read_table 로 먼저 읽어 실제 내용을 확인합니다.
- 구조가 불확실하면 get_document_info 로 구역·문단 수를, 표가 관련되면 list_tables 로 표 목록을 먼저 파악합니다.
- 본문 편집은 가능하면 replace_text 를 사용하세요. 정확한 오프셋을 몰라도 되어 실수가 적습니다.
  오프셋 기반 insert_text / delete_range 는 대상 문단을 먼저 읽어 위치를 확인한 뒤에만 사용합니다.
- 표 셀 편집은 set_cell 을 사용합니다. 편집 전 read_table 로 현재 값과 행·열을 확인하세요.
- 서식 변경(글꼴·크기 등)은 내용 편집과 별개입니다. "표 전체 글꼴을 맑은 고딕 20pt로" → format_table(fontName:"맑은 고딕", fontSize:20).
  글자 크기는 pt 단위로 지정합니다(예: 20).
- 한국어로 간결하게 답합니다. 사용자가 요청한 것만 수행하고, 요청하지 않은 편집은 하지 않습니다.
- 편집을 마치면 무엇을 어떻게 바꿨는지 한두 문장으로 요약합니다.`;

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
