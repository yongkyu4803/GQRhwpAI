'use client';

import { Fragment, type ReactNode } from 'react';

// 채팅 답변용 최소 마크다운 렌더러.
//
// 왜 직접 만드는가:
// - React 엘리먼트를 직접 만들므로 dangerouslySetInnerHTML 이 필요 없습니다(XSS 표면 없음).
// - 사이드 패널(300~800px)에 맞는 촘촘한 여백을 그대로 제어할 수 있습니다.
//
// 지원 범위 — 어시스턴트가 실제로 쓰는 문법만 다룹니다:
//   블록: 코드펜스(```), 제목(#~######), 기호/번호 목록(들여쓰기 계층), 인용(>), 구분선(---), 문단
//   인라인: `코드`, **굵게**, ~~취소선~~, *기울임*, [링크](url)
//
// `_` 는 강조 문자로 취급하지 않습니다. set_paragraph_bullet·insert_text 처럼 밑줄이 들어간
// 도구 이름을 매 답변에서 쓰기 때문에, `_강조_` 를 지원하면 이름이 기울임으로 깨집니다.

// ────────────────── 인라인 ──────────────────

// 순서가 곧 우선순위입니다: 코드 → 굵게 → 취소선 → 기울임 → 링크.
// 기울임은 `*` 양쪽이 공백이 아닐 때만(곱셈·강조 없는 별표 오인 방지).
// 링크는 http(s)/mailto 만 허용합니다(javascript: 스킴 차단).
const INLINE_SOURCE = [
  '(?<code>`+)(?<codeText>[^`]+?)\\k<code>',
  '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*',
  '~~(?<strike>[\\s\\S]+?)~~',
  '\\*(?<italic>[^*\\n\\s](?:[^*\\n]*[^*\\n\\s])?)\\*',
  '\\[(?<linkText>[^\\]]+)\\]\\((?<linkHref>(?:https?:\\/\\/|mailto:)[^\\s)]+)\\)',
].join('|');

/**
 * 인라인 문법을 파싱해 엘리먼트 배열로 만듭니다. 줄바꿈은 <br /> 로 보존합니다.
 * 정규식은 호출마다 새로 만듭니다 — 이 함수는 강조 안쪽을 다시 파싱하느라 재귀하므로,
 * 전역 정규식 하나를 공유하면 lastIndex 가 서로를 망가뜨려 무한 루프가 됩니다.
 */
function inline(text: string, keyPrefix = ''): ReactNode[] {
  const re = new RegExp(INLINE_SOURCE, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(...withBreaks(text.slice(last, m.index), `${keyPrefix}t${n++}`));
    const g = m.groups ?? {};
    const key = `${keyPrefix}m${n++}`;
    if (g.codeText !== undefined) {
      out.push(
        <code key={key} className="px-1 py-0.5 rounded bg-zinc-200/80 dark:bg-zinc-800/80 font-mono text-[0.85em] break-words">
          {g.codeText}
        </code>,
      );
    } else if (g.bold !== undefined) {
      out.push(<strong key={key} className="font-semibold">{inline(g.bold, `${key}.`)}</strong>);
    } else if (g.strike !== undefined) {
      out.push(<s key={key} className="opacity-70">{inline(g.strike, `${key}.`)}</s>);
    } else if (g.italic !== undefined) {
      out.push(<em key={key}>{inline(g.italic, `${key}.`)}</em>);
    } else if (g.linkText !== undefined && g.linkHref !== undefined) {
      out.push(
        <a key={key} href={g.linkHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-70 break-all">
          {inline(g.linkText, `${key}.`)}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...withBreaks(text.slice(last), `${keyPrefix}t${n++}`));
  return out;
}

/** 문단 안의 단일 줄바꿈을 <br /> 로 보존합니다(채팅에서는 쓴 대로 보이는 편이 자연스러움). */
function withBreaks(text: string, key: string): ReactNode[] {
  const parts = text.split('\n');
  return parts.flatMap((part, i) =>
    i === 0 ? [<Fragment key={`${key}.${i}`}>{part}</Fragment>] : [<br key={`${key}.br${i}`} />, <Fragment key={`${key}.${i}`}>{part}</Fragment>],
  );
}

// ────────────────── 블록 ──────────────────

type ListItem = { marker: string | null; depth: number; text: string };
type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; text: string };

const BULLET_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  const flushPara = (buf: string[]) => {
    if (buf.length > 0) blocks.push({ kind: 'para', text: buf.join('\n') });
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      flushPara(para);
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) body.push(lines[i++]);
      i++; // 닫는 펜스(없으면 끝까지)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushPara(para);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushPara(para);
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara(para);
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushPara(para);
      const body = [quote[1]];
      i++;
      for (let q = QUOTE_RE.exec(lines[i] ?? ''); q !== null; q = QUOTE_RE.exec(lines[i] ?? '')) {
        body.push(q[1]);
        i++;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    if (BULLET_RE.test(line)) {
      flushPara(para);
      const items: ListItem[] = [];
      for (let b = BULLET_RE.exec(lines[i] ?? ''); b !== null; b = BULLET_RE.exec(lines[i] ?? '')) {
        const [, indent, marker, text] = b;
        // 공백 2칸(또는 탭 1개)을 한 단계로 봅니다.
        const depth = Math.min(3, Math.floor(indent.replace(/\t/g, '  ').length / 2));
        items.push({ marker: /^\d/.test(marker) ? marker : null, depth, text });
        i++;
        // 목록 항목의 이어지는 줄(들여쓴 일반 텍스트)은 그 항목에 붙입니다.
        while (i < lines.length && lines[i].trim() !== '' && !BULLET_RE.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        }
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara(para);
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-semibold mt-1',
  2: 'text-sm font-semibold mt-1',
  3: 'text-sm font-semibold',
  4: 'text-sm font-semibold',
  5: 'text-[13px] font-semibold',
  6: 'text-[13px] font-semibold',
};

/** 깊이별 기호. 0단은 •, 그 아래는 ◦ / ▪ 로 구분합니다. */
const DEPTH_BULLET = ['•', '◦', '▪', '·'];

/**
 * 어시스턴트 답변의 마크다운을 렌더합니다. 지원하지 않는 문법은 그대로 글자로 보여
 * 내용이 사라지지 않게 합니다.
 */
export default function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="flex flex-col gap-1.5 break-words">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'code':
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-zinc-200/70 dark:bg-zinc-800/70 px-2 py-1.5 text-[12px] leading-relaxed">
                <code className="font-mono whitespace-pre">{block.text}</code>
              </pre>
            );
          case 'heading': {
            const Tag = `h${Math.min(6, block.level + 2)}` as 'h3';
            return <Tag key={i} className={HEADING_CLASS[block.level]}>{inline(block.text, `b${i}.`)}</Tag>;
          }
          case 'hr':
            return <hr key={i} className="border-zinc-300 dark:border-zinc-600 my-0.5" />;
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-zinc-300 dark:border-zinc-600 pl-2 opacity-80">
                {inline(block.text, `b${i}.`)}
              </blockquote>
            );
          case 'list':
            return (
              <ul key={i} className="flex flex-col gap-0.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-1.5" style={{ paddingLeft: `${item.depth * 10}px` }}>
                    <span className="flex-none opacity-60 tabular-nums">{item.marker ?? DEPTH_BULLET[item.depth]}</span>
                    <span className="min-w-0">{inline(item.text, `b${i}.${j}.`)}</span>
                  </li>
                ))}
              </ul>
            );
          default:
            return <p key={i}>{inline(block.text, `b${i}.`)}</p>;
        }
      })}
    </div>
  );
}
