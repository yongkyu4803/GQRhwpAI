# GQRhwpAI

한글(HWP/HWPX) 문서를 웹에서 보고 편집하며, **Claude AI 채팅으로 문서 작업을 돕는** Next.js 앱입니다.
HWP 뷰어·에디터 엔진은 [rhwp](https://github.com/edwardkim/rhwp)를 사용하고,
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)로 서버측 WASM 문서를 조작하는 AI 편집 도구를 제공합니다.

**기능**
- HWP/HWPX 뷰어 + 편집기(rhwp-studio 임베드, **표 크기 조정 등 최신 기능 포함 — 레포에 번들되어 별도 빌드 불필요**)
- Claude AI 채팅으로 문서 편집: 본문·표 내용 수정/검색, 표 삽입·행열 추가삭제·병합 인식, 글꼴·크기·색·정렬, 셀 배경·테두리·여백·크기 조정 등
- Claude 구독 계정(Pro/Max) 인증 (API 키 미사용)

## 시작하기 (클론 후 실행)

```bash
git clone https://github.com/yongkyu4803/GQRhwpAI.git
cd GQRhwpAI
npm install                        # 의존성 설치 (+ public/rhwp_bg.wasm 자동 준비)
npm i -g @anthropic-ai/claude-code # Claude Code CLI (없으면)
claude setup-token                 # 본인 Pro/Max 구독으로 장기 토큰 발급
cp .env.example .env.local         # .env.local 의 CLAUDE_CODE_OAUTH_TOKEN 에 토큰 붙여넣기
npm run dev                        # http://localhost:3007
```

- **에디터/뷰어는 바로 동작**합니다(studio 는 `public/studio/` 에 번들, WASM 은 postinstall 이 준비).
- **AI 채팅**만 위 토큰 설정이 필요합니다. 이미 이 머신에서 Claude Code 에 로그인돼 있으면 토큰 없이도 됩니다.
  토큰은 개인 자격증명이니 공유·커밋하지 마세요(`.env.local` 은 git 제외).

## Credits & License

- HWP 엔진: [rhwp](https://github.com/edwardkim/rhwp) © Edward Kim, MIT License (see `NOTICE`).

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
