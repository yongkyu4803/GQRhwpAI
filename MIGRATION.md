# rhwp 마이그레이션 가이드

> HWP/HWPX 파일을 Node.js/웹 앱에 통합하기 위한 설치 및 연동 가이드

## 개요

**rhwp**는 Rust + WebAssembly(WASM)로 구현된 오픈소스 HWP/HWPX 뷰어·에디터 라이브러리다.
한글과컴퓨터의 독점 포맷(.hwp)을 별도 소프트웨어 없이 브라우저 및 Node.js 환경에서 파싱·렌더링할 수 있다.

- **공식 저장소:** https://github.com/edwardkim/rhwp
- **온라인 데모:** https://edwardkim.github.io/rhwp/
- **현재 버전:** v0.7.x

---

## 핵심 패키지

| 패키지 | 역할 | 선택 기준 |
|---|---|---|
| `@rhwp/core` | WASM 기반 파서 + 렌더러 API | 커스텀 뷰어, 서버 사이드 처리 |
| `@rhwp/editor` | 완성된 에디터 UI 컴포넌트 | 빠른 에디터 임베딩 |

---

## 설치

```bash
# 파서/렌더러 API만 필요한 경우 (경량)
npm install @rhwp/core

# 완성된 에디터 UI가 필요한 경우
npm install @rhwp/editor
```

### WASM 번들러 설정 (Vite)

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
});
```

---

## 사용법

### 1. 문서 렌더링 (브라우저 - `@rhwp/core`)

```javascript
import { createRenderer } from '@rhwp/core';

async function renderHwp(fileBuffer, canvasElement) {
  const renderer = await createRenderer();
  const doc = await renderer.load(fileBuffer);  // ArrayBuffer
  await renderer.render(doc, canvasElement);     // <canvas> DOM element
}
```

### 2. 에디터 UI 임베딩 (브라우저 - `@rhwp/editor`)

```javascript
import { createEditor } from '@rhwp/editor';

const editor = await createEditor('#editor');  // CSS selector
await editor.open(fileBuffer);                 // HWP 파일 로드
```

### 3. SVG 내보내기 (브라우저 - `@rhwp/core`)

```javascript
import { createRenderer } from '@rhwp/core';

const renderer = await createRenderer();
const doc = await renderer.load(fileBuffer);
const svg = await renderer.exportSvg(doc, 0);  // 0 = 첫 번째 페이지
document.getElementById('preview').innerHTML = svg;
```

### 4. 서버 사이드 처리 (Node.js + Express 예시)

```javascript
import express from 'express';
import multer from 'multer';
import { createRenderer } from '@rhwp/core';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.post('/hwp/preview', upload.single('file'), async (req, res) => {
  const renderer = await createRenderer();
  const doc = await renderer.load(req.file.buffer);
  const svg = await renderer.exportSvg(doc, 0);
  res.type('image/svg+xml').send(svg);
});

app.listen(3000);
```

### 5. CLI 도구 (배치 변환)

```bash
# 전체 페이지 SVG 추출
rhwp export-svg document.hwp

# 특정 페이지만 추출 (0-indexed)
rhwp export-svg document.hwp -p 0

# 문서 구조 덤프 (디버깅)
rhwp dump document.hwp
```

---

## 브라우저 확장 프로그램 설치 (비개발자용)

| 브라우저 | 링크 |
|---|---|
| Chrome | Chrome Web Store에서 "RHWP" 검색 |
| Edge | Microsoft Edge Add-ons에서 "RHWP" 검색 |
| Firefox | Firefox Add-ons에서 "RHWP" 검색 |
| VS Code | VS Code Marketplace에서 "rhwp-vscode" 검색 |

---

## 환경 요구사항

- **Node.js:** 18 이상
- **브라우저:** WebAssembly 지원 (Chrome, Edge, Firefox 최신 버전)
- **소스 직접 빌드 시:** Rust 1.75+, Docker, Node.js 18+

---

## 현재 제한사항 (v0.7.x)

| 항목 | 상태 |
|---|---|
| HWP 5.0 (바이너리) 열람 | 지원 |
| HWPX (XML) 열람 | 지원 |
| 텍스트·표·이미지·수식 렌더링 | 지원 |
| 텍스트 편집, 서식 변경 | 지원 |
| HWPX 저장(save) | 베타 (미완성) |
| 일부 복잡한 레이아웃 | 부분 지원 |

---

## 법적 지위

한글과컴퓨터는 HWP 규격을 2010년에 공개했으며, rhwp는 해당 공개 규격을 기반으로 개발되어 법적 문제가 없는 것으로 확인되었다. (2026년 4월 기준)

---

## 참고 문서

- [공식 README (영문)](https://github.com/edwardkim/rhwp/blob/main/README_EN.md)
- [온보딩 가이드](https://github.com/edwardkim/rhwp/blob/main/mydocs/manual/onboarding_guide.md)
- [Chrome 확장 개발자 가이드](https://github.com/edwardkim/rhwp/blob/main/rhwp-chrome/DEVELOPER_GUIDE.md)
