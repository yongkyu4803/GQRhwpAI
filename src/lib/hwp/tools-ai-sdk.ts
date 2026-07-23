import 'server-only';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { HWP_TOOL_SPECS, type DocHolder } from './tools-core';

/**
 * 공유 도구 스펙(tools-core)을 Vercel AI SDK 의 tool() 형식으로 감쌉니다.
 * OpenAI·Google 등 AI SDK 가 지원하는 어떤 provider 든 이 도구 세트를 그대로 씁니다.
 * (Claude 경로는 tools.ts 에서 같은 스펙을 Agent SDK 형식으로 감쌉니다.)
 */
export function buildHwpAiTools(holder: DocHolder): ToolSet {
  const set: ToolSet = {};
  for (const spec of HWP_TOOL_SPECS) {
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: z.object(spec.schema),
      execute: async (args) => {
        const r = await spec.execute(holder, args as Record<string, unknown>);
        // 실패해도 모델이 상황을 이해하고 복구할 수 있게 텍스트를 그대로 돌려줍니다.
        return r.text;
      },
    });
  }
  return set;
}
