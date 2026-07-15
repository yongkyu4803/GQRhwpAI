import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Agent SDK는 Claude Code 바이너리를 서브프로세스로 띄우므로 서버 번들에서 제외합니다.
  // (@rhwp/core는 순수 ESM+WASM이라 Turbopack이 externalize 하지 못합니다 —
  //  server-core.ts 에서 런타임 file:// 동적 import 로 로드해 번들링 자체를 회피합니다.)
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
};

export default nextConfig;
