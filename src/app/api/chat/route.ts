import { query } from '@anthropic-ai/claude-agent-sdk';

import { loadDocument } from '@/lib/hwp/server-core';
import { createHwpToolServer, HWP_TOOL_NAMES, type DocHolder } from '@/lib/hwp/tools';
import { HWP_SYSTEM_PROMPT } from '@/lib/hwp/system-prompt';

// Agent SDK 는 Claude Code 바이너리를 서브프로세스로 띄우므로 Node 런타임 필수.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MODEL = process.env.HWP_AGENT_MODEL ?? 'claude-sonnet-5';

const SYSTEM_PROMPT = HWP_SYSTEM_PROMPT;

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
