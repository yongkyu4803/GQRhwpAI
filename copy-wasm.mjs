// 라이선스 안전: 상류 WASM 산출물을 레포에 커밋(재배포)하지 않고,
// 설치 시 node_modules 에서 public/ 으로 복사합니다.
// package.json 의 "scripts.postinstall": "node copy-wasm.mjs" 로 연결하세요.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const src = require.resolve('@rhwp/core/rhwp_bg.wasm');
const destDir = path.join(process.cwd(), 'public');
const dest = path.join(destDir, 'rhwp_bg.wasm');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log(`[copy-wasm] ${src} -> ${dest}`);
