import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { generateText, stepCountIs, type LanguageModel } from 'ai';

import { loadDocument } from '@/lib/hwp/server-core';
import { buildHwpAiTools } from '@/lib/hwp/tools-ai-sdk';
import { HWP_SYSTEM_PROMPT } from '@/lib/hwp/system-prompt';
import type { DocHolder } from '@/lib/hwp/tools-core';

// WASM(@rhwp/core) 로드가 필요하므로 Node 런타임 필수.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// 비-Claude 프로바이더 PoC 라우트 (Vercel AI SDK).
// Claude 라우트(/api/chat)와 달리 API 키(사용량 과금)로 인증합니다.
//   - openai:  OPENAI_API_KEY
//   - google:  GOOGLE_GENERATIVE_AI_API_KEY
// provider·model 은 요청(폼 필드)으로 지정하며, 없으면 환경변수로 폴백합니다.
// 도구·시스템 프롬프트는 Claude 경로와 동일하게 공유합니다.
const ENV_PROVIDER = (process.env.HWP_AI_PROVIDER ?? 'openai').toLowerCase();
const ENV_MODEL = process.env.HWP_AI_MODEL;
// 표/좌표 편집은 다단계라 여유있게. 필요 시 환경변수로 조정.
const MAX_STEPS = Number(process.env.HWP_AI_MAX_STEPS ?? 24);

function defaultModelFor(provider: string): string {
  return provider === 'google' ? 'gemini-2.5-flash' : 'gpt-4o-mini';
}

function resolveModel(provider: string, modelId: string): LanguageModel {
  if (provider === 'google') return google(modelId);
  if (provider === 'openai') return openai(modelId);
  throw new Error(`알 수 없는 provider: "${provider}" (openai 또는 google)`);
}

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
  let provider: string;
  let modelId: string;
  try {
    const form = await request.formData();
    prompt = String(form.get('prompt') ?? '').trim();
    provider = (String(form.get('provider') ?? '').trim().toLowerCase()) || ENV_PROVIDER;
    modelId = String(form.get('model') ?? '').trim() || ENV_MODEL || defaultModelFor(provider);
    const file = form.get('file');
    if (!prompt) return Response.json({ error: '메시지가 비어 있습니다.' }, { status: 400 });
    if (!(file instanceof Blob)) return Response.json({ error: '문서 파일이 없습니다.' }, { status: 400 });
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  let model: LanguageModel;
  try {
    model = resolveModel(provider, modelId);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const holder: DocHolder = { doc: await loadDocument(bytes), dirty: false };
  // 배치 모드: 편집 커맨드마다 재-pagination 하지 않고 export 직전에 한 번만 처리.
  holder.doc.beginBatch();
  const tools = buildHwpAiTools(holder);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      send({ type: 'system', sessionId: `${provider}:${modelId}` });
      try {
        const result = await generateText({
          model,
          system: HWP_SYSTEM_PROMPT,
          prompt,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          // 각 스텝(LLM 호출)이 끝날 때마다 도구 호출·생성 텍스트를 스트림으로 흘려보냅니다.
          onStepFinish: (step) => {
            for (const call of step.toolCalls) {
              // ChatPanel 라벨(mcp__hwp__* 키)과 맞추려고 접두사를 붙여 보냅니다.
              send({ type: 'tool', name: `mcp__hwp__${call.toolName}`, input: call.input });
            }
            if (step.text) send({ type: 'text', text: step.text });
          },
        });
        // 편집이 있었으면 문서를 직렬화해 클라이언트로 되돌려 보냅니다.
        if (holder.dirty) {
          holder.doc.endBatch();
          // 편집으로 미계산된 줄 배치(lineseg)를 재계산해 "HWPX 비표준" 경고·렌더 품질 저하를 완화.
          try { holder.doc.reflowLinesegs(); } catch { /* 헤드리스에서 실패해도 무시 */ }
          const out = holder.doc.exportHwp();
          const base64 = Buffer.from(out).toString('base64');
          send({ type: 'document', hwpBase64: base64 });
        }
        send({ type: 'result', text: result.text, isError: false });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // API 키 관련 오류면 설정법을 덧붙여 안내.
        const isAuth = /api[_ ]?key|unauthor|401|invalid.*key|missing.*key|credential/i.test(raw);
        const keyVar = provider === 'google' ? 'GOOGLE_GENERATIVE_AI_API_KEY' : 'OPENAI_API_KEY';
        const message = isAuth
          ? `${raw}\n\n${provider} API 키가 필요합니다. .env.local 의 ${keyVar} 에 키를 넣으세요. (.env.example 참고)`
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
