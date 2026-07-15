# 호스트 파일 패치 지침

assets 파일 복사만으로는 부족합니다. 아래 3개 호스트 파일을 **비파괴적으로(기존 코드 유지, 추가만)** 수정합니다. 반드시 대상 파일을 먼저 읽고, 아래 앵커가 실제로 있는지 확인한 뒤 편집하세요. 앵커가 다르면 동등한 위치를 찾아 적용합니다.

## 1) `next.config.ts` (또는 .js/.mjs)

`nextConfig` 객체에 다음을 추가:

```ts
serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
```

이유: Agent SDK는 Claude Code 바이너리를 서브프로세스로 띄우므로 서버 번들에서 제외. (`@rhwp/core`는 넣지 말 것 — 순수 ESM+WASM이라 Turbopack이 externalize 못 하고 오히려 깨짐. server-core.ts가 런타임 동적 import로 우회함.)

## 2) `src/app/components/HwpEditor.tsx` — 에디터 핸들에 `loadBytes` 추가

`HwpEditorHandle` 타입에 추가:

```ts
/** 주어진 HWP 바이트를 에디터에 다시 로드합니다 (AI 편집 결과 반영). */
loadBytes(bytes: Uint8Array, fileName?: string): Promise<void>;
```

`useImperativeHandle(ref, () => ({ ... }))` 반환 객체에 추가:

```ts
loadBytes: async (bytes, name) => {
  await editorInstanceRef.current?.loadFile(bytes, name ?? fileName);
},
```

(에디터 인스턴스 ref 이름이 다르면 해당 이름으로 맞춥니다. 핵심은 `RhwpEditor.loadFile(bytes, name)` 호출.)

## 3) `src/app/components/HwpViewer.tsx` — 채팅 패널 연결

a. 상단 import 추가: `import ChatPanel from './ChatPanel';`

b. 상태 추가(다른 useState 옆): `const [chatOpen, setChatOpen] = useState(false);`

c. 콜백 2개 추가(에디터 ref·모드·editorReady·fileName 이름은 호스트에 맞춤):

```ts
// AI 채팅에 넘길 현재 문서 바이트
const getDocBytes = useCallback(async (): Promise<Uint8Array | null> => {
  if (mode === 'editor' && editorReady) {
    const bytes = await editorRef.current?.exportHwp();
    if (bytes && bytes.length > 0) return bytes;
  }
  return fileBufferRef.current;
}, [mode, editorReady]);

// AI 편집 결과를 에디터에 반영
const applyEdit = useCallback(async (bytes: Uint8Array): Promise<boolean> => {
  fileBufferRef.current = bytes;
  if (mode === 'editor' && editorReady && editorRef.current) {
    await editorRef.current.loadBytes(bytes, fileName);
    return true;
  }
  return false;
}, [mode, editorReady, fileName]);
```

d. 헤더 툴바에 AI 토글 버튼 추가(문서 준비된 조건에서만 렌더). `onClick={() => setChatOpen(o => !o)}`.

e. 본문 flex 레이아웃(사이드바+메인이 들어있는 `<div className="flex ...">`)에서 `</main>` 뒤, 그 div 닫기 전에 패널 렌더:

```tsx
{chatOpen && (
  <ChatPanel getDocBytes={getDocBytes} onApplyEdit={applyEdit} docId={fileName} onClose={() => setChatOpen(false)} />
)}
```

주의: `getDocBytes`/`applyEdit`는 호스트의 실제 식별자(`editorRef`, `mode`, `editorReady`, `fileBufferRef`, `fileName`)에 의존합니다. 이름이 다르면 그 이름으로 치환하세요. 에디터가 없는 뷰어 전용 앱이면 `applyEdit`는 항상 false를 반환해도 되고(읽기 전용), 편집 반영은 파일 버퍼 교체 후 재로드로 처리합니다.

## 4) `.env`, `.gitignore`

- `assets/env.example` → 프로젝트 루트 `.env.example` 로 복사. 사용자가 `.env.local` 로 복사해 `CLAUDE_CODE_OAUTH_TOKEN` 채움.
- `.gitignore` 에 `.env*` 가 없으면 추가(있으면 `!.env.example` 예외로 예시만 커밋 허용).

## 5) wasm 복사 (라이선스 안전)

- `assets/copy-wasm.mjs` → 프로젝트 루트로 복사.
- `package.json` 에 `"postinstall": "node copy-wasm.mjs"` 추가 → 설치 시 `public/rhwp_bg.wasm` 자동 생성.
- **`public/rhwp_bg.wasm` 은 커밋하지 않습니다**(`.gitignore` 에 `/public/rhwp_bg.wasm` 추가). 이러면 상류 산출물 재배포 고지 의무가 사라집니다.
- `assets/NOTICE.template` → 루트 `NOTICE` 로 복사(선택이지만 권장). README에 "rhwp(edwardkim/rhwp, MIT) 엔진 기반" 크레딧 추가.
