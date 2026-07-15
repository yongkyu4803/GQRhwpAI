---
name: hwp-ai-editing
description: rhwp(@rhwp/core·@rhwp/editor) 기반 Next.js 앱에 Claude Agent SDK를 접목해, AI 채팅으로 한글(HWP) 문서를 읽고 편집하는 기능을 추가한다. 서버측 WASM으로 문서를 조작하는 커스텀 도구(텍스트·표·서식·정렬·셀 배경/테두리), 스트리밍 채팅 UI, 구독제 인증, 대화 맥락 유지까지 설정한다. 사용자가 "rhwp 앱에 AI 편집/채팅을 넣어줘", "한글 문서 AI 편집 기능 추가" 등을 요청할 때 사용.
---

# rhwp AI 편집 기능 추가 스킬

`@rhwp/editor`(+`@rhwp/core`)를 쓰는 Next.js(App Router) 앱에 **Claude Agent SDK 기반 AI 채팅 문서 편집**을 추가한다. 문서는 브라우저가 아니라 **서버측 WASM(`@rhwp/core`)** 에 로드되어, 인프로세스 커스텀 도구로 조작된다(A안: 서버 섀도 문서). 편집 결과는 base64로 클라이언트에 돌아와 에디터에 다시 로드된다.

## 이 스킬이 넣는 기능
- 커스텀 도구 15종: 읽기(문서정보·문단·검색·표목록·표읽기), 편집(텍스트 삽입/삭제/치환·표 삽입·셀 편집), 서식(글꼴·크기·굵게·기울임·밑줄·색·문단정렬), 셀 배경색·테두리
- `/api/chat` 스트리밍 라우트(NDJSON), 우측 채팅 패널 UI("새 대화" 포함)
- 구독제(Claude Pro/Max) 인증, 대화 맥락 유지(session resume)

## 전제조건 (먼저 확인)
1. Next.js **App Router** 앱이며 `src/app/` 구조. (Turbopack 여부 무관하게 동작하도록 설계됨)
2. `@rhwp/editor`, `@rhwp/core` 가 설치돼 있고 **에디터 컴포넌트가 있음**(예: `HwpEditor.tsx` 로 `RhwpEditor.loadFile/exportHwp` 노출, `HwpViewer.tsx` 로 마운트). 없으면 사용자에게 먼저 rhwp 뷰어/에디터를 구성해야 한다고 알린다.
3. TypeScript `@/*` → `./src/*` 경로 별칭. 다르면 assets 파일의 import 경로를 그에 맞게 바꾼다.
4. 인증: 사용자가 Claude Pro/Max 구독 로그인(또는 `claude setup-token`) 가능. API 키 방식도 폴백 지원.

전제가 안 맞으면 **멈추고 사용자에게 확인**한다. 특히 2번(에디터 컴포넌트 부재)은 이 스킬 범위 밖이다.

## 절차

> 자산 경로는 이 스킬 폴더 기준. 실제 파일 내용은 `assets/` 에 있으니 **그대로 복사**하고, import 경로/식별자만 대상 앱에 맞춘다. 비파괴 편집 원칙: 기존 코드를 지우지 말고 추가한다.

### 1. 의존성 설치
```
npm install @anthropic-ai/claude-agent-sdk zod server-only
```
(zod/server-only 이미 있으면 생략 가능)

### 2. 서버측 파일 복사
- `assets/server-core.ts` → `src/lib/hwp/server-core.ts`
- `assets/tools.ts` → `src/lib/hwp/tools.ts`
- `assets/route.ts` → `src/app/api/chat/route.ts`
- `assets/ChatPanel.tsx` → `src/app/components/ChatPanel.tsx`

### 3. 호스트 파일 패치
`references/wiring.md` 를 그대로 따른다: `next.config`(serverExternalPackages), `HwpEditor.tsx`(loadBytes 핸들), `HwpViewer.tsx`(ChatPanel 연결·AI 버튼·getDocBytes·applyEdit·docId).
**패치 전 대상 파일을 읽어** 앵커/식별자를 확인하고, 이름이 다르면 치환한다.

### 4. 인증·환경
- `assets/env.example` → 루트 `.env.example`. 사용자에게 `.env.local` 로 복사 후 `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token`) 채우라고 안내.
- `.gitignore` 에 `.env*` (+`!.env.example`) 확인.

### 5. wasm 복사 (라이선스 안전 — 가장 안전한 방식)
- `assets/copy-wasm.mjs` → 루트 `copy-wasm.mjs`
- `package.json` scripts 에 `"postinstall": "node copy-wasm.mjs"` 추가 → 설치 시 `public/rhwp_bg.wasm` 생성.
- `.gitignore` 에 `/public/rhwp_bg.wasm` 추가(상류 산출물을 레포에 재배포하지 않음).
- 즉시 필요하면 한 번 실행: `node copy-wasm.mjs`.
- (선택·권장) `assets/NOTICE.template` → 루트 `NOTICE`, README 에 "rhwp(edwardkim/rhwp, MIT) 엔진 기반" 크레딧.

### 6. 검증 (반드시 실행해 확인)
1. `npx tsc --noEmit` 통과.
2. dev 서버 기동 후 `/api/chat` 이 인증 없이 500(인증 안내) 대신, 구독 로그인 상태에서 정상 스트리밍하는지:
   - 읽기: "이 문서에 표가 몇 개야?" → list_tables 호출 + 답변.
   - 편집: "OO를 XX로 바꿔줘" → replace_text/set_cell + `document` 이벤트(편집본 base64).
   - 서식: "표 전체 맑은 고딕 20pt 가운데 정렬" → format_table.
3. 브라우저 편집 모드에서 AI 버튼 → 요청 → "문서에 반영됨" 배지 확인.

문제가 나면 **반드시 `references/troubleshooting.md` 를 먼저 참조**한다(대부분의 함정이 정리돼 있음).

## 핵심 주의 (요약 — 상세는 troubleshooting.md)
- `@rhwp/core` 는 `serverExternalPackages` 에 넣지 말 것(순수 ESM+WASM). server-core.ts 가 런타임 file:// 동적 import 로 로드한다.
- 서버에 DOM 스텁(`globalThis.window` 등) 심지 말 것(Next 감지가 깨짐).
- 구독 인증은 서브프로세스 env 에서 `ANTHROPIC_API_KEY` 제거로 강제.
- 글꼴=fontId(findOrCreateFontId), 크기=pt×100, 셀 배경=테두리와 함께 써야 반영, 검색은 셀 미도달.
- 모델 기본 `claude-sonnet-5`(`HWP_AGENT_MODEL` 로 변경). Opus 로 올리면 느려짐.
