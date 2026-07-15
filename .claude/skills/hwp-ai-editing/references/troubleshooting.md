# 함정 노트 (이걸 모르면 몇 시간 헤맵니다)

## WASM in Node (server-core.ts 의 핵심)
- `@rhwp/core` 는 순수 ESM + WASM. Turbopack/webpack이 번들·externalize 하지 못함
  ("Package can't be external: require() resolves to ESM", 그리고 `rhwp_bg.wasm_.loader.mjs`가 `rhwp_bg.js`를 못 찾는 컴파일 에러).
- 해결: `serverExternalPackages`에 넣지 말고, **런타임 동적 import**로 로드.
  - `createRequire` 는 **반드시 실제 cwd 경로에 앵커**: `createRequire(pathToFileURL(path.join(process.cwd(),'index.js')).href)`.
    (번들 안 `import.meta.url` 은 가상 경로 `[project]` 라 해석이 틀림.)
  - 스펙시파이어를 **변수**로 둬 정적 분석 회피: `require.resolve(spec)` (spec은 변수), 그 경로를 `pathToFileURL`→`import(url)`.
  - wasm 은 `readFile(path.join(dirname(coreJs),'rhwp_bg.wasm'))` 로 읽어 `core.default({ module_or_path: bytes })` 에 주입.

## DOM 스텁 절대 금지
- `globalThis.window = globalThis` 같은 스텁을 서버에 심으면 **Next의 서버/클라이언트 감지가 깨져** `window.location` 류 에러로 전 페이지가 죽음.
- `@rhwp/core` 는 wasm-bindgen이 `typeof window === 'undefined'` 로 안전 가드하므로 **스텁이 전혀 필요 없음**. 텍스트 읽기/편집/직렬화(exportHwp·exportHwpVerify)는 canvas 콜백을 안 부름.

## 구독제(Claude Pro/Max) 인증
- 라우트에서 서브프로세스 env 를 지정하되 **`ANTHROPIC_API_KEY` 를 제거**해야 구독 인증이 이김.
  `const env = {...process.env}; delete env.ANTHROPIC_API_KEY;` → `query` options 의 `env` 로 전달.
- 구독 자격증명: `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token` 발급) 또는 머신에 이미 로그인된 `~/.claude` 자격.

## 편집 도구 API 규칙 (tools.ts)
- **글꼴**: 이름 키(`fontFamily` 등)는 무시됨. `findOrCreateFontId(name)` → 얻은 ID를 `{fontId}` 로 전달. 한글·라틴 슬롯에 적용.
- **글자 크기**: `fontSize` 는 **pt×100** (20pt → 2000).
- **셀 배경색**: `setCellProperties` 의 `fillType:"solid"`+`fillColor` 는 **테두리와 같은 호출에 있을 때만** 반영됨. 배경만 바꿀 땐 현재 셀 속성(테두리)을 읽어 함께 재전송. 반대로 테두리만 바꿀 땐 현재 fill을 읽어 보존.
- **문단 정렬**: `applyParaFormat`/`applyParaFormatInCell` 의 `{alignment}` = 소문자 `"left"|"center"|"right"|"justify"` (대문자 무시). 셀은 셀 안 모든 문단에 적용.
- **검색은 표 셀에 안 닿음**: `searchText`/`replace_text` 는 본문만. 표는 `list_tables`→`read_table`→`set_cell`/`format_cell`/`set_cell_*` 경로.
- **표 열거**: 표 목록 API가 없어, 문단별 `getControlTextPositions` 길이만큼 control_idx 를 훑으며 `getTableDimensions` 성공하는 것만 표로 간주. 셀은 다문단 가능(문단별로 읽어 합침). cell_idx = row*cols+col (행 우선).
- **좌표계**: 구역(section)→문단(paragraph, 0-기반)→글자 오프셋. 표는 문단 안 컨트롤.

## 문서 동기화 / 편집 반영 루프
- 매 턴 클라이언트가 `exportHwp()` 바이트를 전송 → 서버가 `HwpDocument` 로 로드 → 편집 도구는 `beginBatch()` 후 조작 → 편집 있으면(`dirty`) `endBatch()`+`exportHwp()` → base64 로 클라이언트에 반환 → 에디터 `loadFile`.
- **대화 맥락**: 첫 응답의 `session_id` 를 클라이언트가 보관 → 다음 턴 전송 → 라우트가 `options.resume` 으로 이어감. 문서가 바뀔 수 있으니 시스템 프롬프트에 "편집 전 다시 읽어라" 지시.

## 성능
- 지연의 주범은 **다단계 순차 추론**(도구 여러 번 호출). 모델을 `claude-sonnet-5` 로 두면 턴당 빠름. `HWP_AGENT_MODEL` 환경변수로 조정. effort 낮추면 더 빨라짐(대신 판단력 손해).
