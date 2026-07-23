import 'server-only';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { HWP_TOOL_SPECS, type DocHolder } from './tools-core';

export type { DocHolder } from './tools-core';
export { HWP_TOOL_NAMES } from './tools-core';

/**
 * 공유 도구 스펙(tools-core)을 Claude Agent SDK 의 tool() 로 감싸는 어댑터입니다.
 * 실제 문서 조작 로직은 전부 tools-core 에 있으며 provider 와 무관합니다.
 * (다른 provider 는 tools-ai-sdk.ts 에서 같은 스펙을 Vercel AI SDK 형식으로 감쌉니다.)
 */
export function createHwpToolServer(holder: DocHolder) {
  const tools = HWP_TOOL_SPECS.map(spec =>
    tool(spec.name, spec.description, spec.schema, async (args) => {
      const r = await spec.execute(holder, args as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: r.text }],
        ...(r.isError ? { isError: true } : {}),
      };
    }),
  );
  return createSdkMcpServer({ name: 'hwp', version: '0.3.0', tools });
}
