import 'server-only';

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { HwpDocument } from '@rhwp/core';

type RhwpCore = typeof import('@rhwp/core');

// 참고: @rhwp/core 는 브라우저용 빌드지만 wasm-bindgen 이 window/document/self 를
// `typeof x === 'undefined'` 로 안전하게 가드하므로 Node 에서 DOM 스텁 없이 로드됩니다.
// 텍스트 읽기/편집/직렬화(exportHwp·exportHwpVerify 포함)는 canvas 콜백을 호출하지
// 않으므로 스텁이 불필요합니다. (globalThis.window 를 심으면 Next 의 서버/클라이언트
// 감지가 깨지므로 절대 정의하지 않습니다.)

// WASM 초기화는 프로세스당 한 번만 (브라우저 싱글턴과 동일 패턴).
let corePromise: Promise<RhwpCore> | null = null;

function loadCore(): Promise<RhwpCore> {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    // @rhwp/core 는 순수 ESM+WASM 이라 Turbopack 이 번들/externalize 하지 못합니다.
    // 스펙시파이어를 변수로 두면 Turbopack 정적 분석 대상에서 빠지므로, 런타임에
    // node 모듈 해석 → file:// 동적 import 로 로드해 번들링을 완전히 회피합니다.
    // createRequire 는 반드시 실제 파일시스템 경로(cwd)에 앵커합니다. Turbopack
    // 번들 안에서 import.meta.url 은 가상 경로(`[project]`)라 해석이 틀립니다.
    const require = createRequire(pathToFileURL(path.join(process.cwd(), 'index.js')).href);
    const spec = process.env.RHWP_CORE_PKG || '@rhwp/core';
    const coreJs = require.resolve(spec); // .../@rhwp/core/rhwp.js
    const coreUrl = pathToFileURL(coreJs).href;
    const core = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ coreUrl)) as RhwpCore;
    const wasmBytes = await readFile(path.join(path.dirname(coreJs), 'rhwp_bg.wasm'));
    await core.default({ module_or_path: wasmBytes });
    return core;
  })();
  return corePromise;
}

/** HWP 바이트로부터 서버 측 편집용 HwpDocument 인스턴스를 생성합니다. */
export async function loadDocument(bytes: Uint8Array): Promise<HwpDocument> {
  const core = await loadCore();
  return new core.HwpDocument(bytes);
}
