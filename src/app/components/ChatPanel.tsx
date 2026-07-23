'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ChatEvent =
  | { type: 'system'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'document'; hwpBase64: string }
  | { type: 'result'; text: string; isError: boolean }
  | { type: 'error'; message: string };

type ToolActivity = { name: string; summary: string };

type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: ToolActivity[]; error?: string; edited?: boolean };

type ChatPanelProps = {
  /** 현재 문서 바이트를 반환합니다. 문서가 없으면 null. */
  getDocBytes: () => Promise<Uint8Array | null>;
  /** AI 편집 결과(HWP 바이트)를 에디터에 반영합니다. 반영되면 true. */
  onApplyEdit: (bytes: Uint8Array) => Promise<boolean>;
  /** 문서 식별자(파일명 등). 바뀌면 대화 세션을 초기화합니다. */
  docId?: string;
  onClose: () => void;
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const TOOL_LABELS: Record<string, string> = {
  mcp__hwp__get_document_info: '문서 구조 확인',
  mcp__hwp__read_paragraphs: '문단 읽기',
  mcp__hwp__search_text: '본문 검색',
  mcp__hwp__find_text: '문서·표 검색',
  mcp__hwp__insert_text: '텍스트 삽입',
  mcp__hwp__delete_range: '범위 삭제',
  mcp__hwp__replace_text: '텍스트 교체',
  mcp__hwp__insert_table: '표 삽입',
  mcp__hwp__list_tables: '표 목록 확인',
  mcp__hwp__read_table: '표 읽기',
  mcp__hwp__set_cell: '표 칸 편집',
  mcp__hwp__add_table_row: '표 행 추가',
  mcp__hwp__add_table_column: '표 열 추가',
  mcp__hwp__delete_table_row: '표 행 삭제',
  mcp__hwp__delete_table_column: '표 열 삭제',
  mcp__hwp__delete_table: '표 삭제',
  mcp__hwp__format_text: '글자 서식 변경',
  mcp__hwp__format_cell: '표 칸 서식 변경',
  mcp__hwp__format_table: '표 서식 변경',
  mcp__hwp__set_cell_background: '셀 배경색 설정',
  mcp__hwp__set_cell_border: '셀 테두리 설정',
  mcp__hwp__set_cell_layout: '셀 세로정렬',
  mcp__hwp__set_table_options: '표 옵션',
  mcp__hwp__set_cell_padding: '셀 여백 설정',
  mcp__hwp__set_column_width: '열 너비 설정',
  mcp__hwp__set_table_cell_spacing: '셀 간격 설정',
  mcp__hwp__resize_table: '표 크기 조정',
  mcp__hwp__set_row_height: '행 높이 설정',
};

function toolSummary(name: string, input: unknown): string {
  const label = TOOL_LABELS[name] ?? name;
  if (input && typeof input === 'object' && 'query' in input) {
    return `${label}: "${String((input as { query: unknown }).query)}"`;
  }
  return label;
}

export default function ChatPanel({ getDocBytes, onApplyEdit, docId, onClose }: ChatPanelProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // AI 프로바이더 선택. claude=구독(Agent SDK) 라우트, gpt=API 키(Vercel AI SDK) 라우트.
  const [provider, setProvider] = useState<'claude' | 'gpt'>('claude');
  // GPT(API) 경로에서 쓸 모델. 화면에서 고르거나 직접 입력. gemini* 는 자동으로 google provider.
  const [model, setModel] = useState('gpt-5.4-nano');
  const scrollRef = useRef<HTMLDivElement>(null);
  // 대화 세션 ID. 첫 응답에서 받아 이후 턴에 재전송해 맥락을 이어갑니다(SDK resume).
  const sessionIdRef = useRef<string | null>(null);

  // 패널 너비(드래그로 조절). SSR 하이드레이션 불일치를 피하려고 기본값으로 시작한 뒤
  // 마운트 후 localStorage 저장값을 반영합니다.
  const MIN_W = 300;
  const MAX_W = 800;
  const DEFAULT_W = 320;
  const [width, setWidth] = useState(DEFAULT_W);
  const widthRef = useRef(DEFAULT_W);
  widthRef.current = width;
  const draggingRef = useRef(false);
  // 드래그 중에는 전체 화면 오버레이를 띄워 에디터 iframe 이 마우스 이벤트를 가로채지
  // 못하게 합니다(iframe 위에선 부모 window 의 mousemove 가 발생하지 않음).
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const saved = Number(localStorage.getItem('hwpChatWidth'));
    if (saved >= MIN_W && saved <= MAX_W) setWidth(saved);
    const savedModel = localStorage.getItem('hwpAiModel');
    if (savedModel) setModel(savedModel);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      // 패널은 오른쪽에 붙어 있으므로 (뷰포트 너비 - 커서 X) = 패널 너비.
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
      setWidth(w);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('hwpChatWidth', String(widthRef.current)); } catch { /* 무시 */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  // 새 대화 시작: 화면 기록과 세션을 모두 초기화합니다.
  const startNewChat = useCallback(() => {
    sessionIdRef.current = null;
    setTurns([]);
  }, []);

  // 다른 문서로 바뀌면 이전 대화 맥락("그 표" 등)이 무의미하므로 세션을 초기화합니다.
  useEffect(() => {
    startNewChat();
  }, [docId, startNewChat]);

  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;

    const bytes = await getDocBytes();
    if (!bytes || bytes.length === 0) {
      setTurns(t => [...t, { role: 'user', text: prompt }, { role: 'assistant', text: '', tools: [], error: '열린 문서가 없습니다.' }]);
      setInput('');
      return;
    }

    setInput('');
    setBusy(true);
    setTurns(t => [...t, { role: 'user', text: prompt }, { role: 'assistant', text: '', tools: [] }]);

    // 마지막 assistant 턴을 갱신하는 헬퍼.
    const patchAssistant = (fn: (a: Extract<Turn, { role: 'assistant' }>) => Extract<Turn, { role: 'assistant' }>) =>
      setTurns(t => {
        const next = [...t];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === 'assistant') {
            next[i] = fn(next[i] as Extract<Turn, { role: 'assistant' }>);
            break;
          }
        }
        return next;
      });

    try {
      const form = new FormData();
      form.set('prompt', prompt);
      if (sessionIdRef.current) form.set('sessionId', sessionIdRef.current);
      if (provider === 'gpt') {
        const m = model.trim();
        if (m) {
          form.set('model', m);
          // gemini* 모델이면 google provider, 그 외는 openai.
          form.set('provider', m.toLowerCase().startsWith('gemini') ? 'google' : 'openai');
        }
      }
      // Uint8Array → Blob. 뷰가 있는 버퍼여도 안전하게 슬라이스해 복사합니다.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      form.set('file', new Blob([ab], { type: 'application/octet-stream' }), 'document.hwp');

      const url = provider === 'gpt' ? '/api/chat-ai' : '/api/chat';
      const res = await fetch(url, { method: 'POST', body: form });
      if (!res.ok || !res.body) {
        const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        patchAssistant(a => ({ ...a, error: msg.error ?? `HTTP ${res.status}` }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ChatEvent;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === 'system') {
            sessionIdRef.current = event.sessionId; // 다음 턴 resume 용
          } else if (event.type === 'text') {
            patchAssistant(a => ({ ...a, text: a.text + event.text }));
          } else if (event.type === 'tool') {
            patchAssistant(a => ({ ...a, tools: [...a.tools, { name: event.name, summary: toolSummary(event.name, event.input) }] }));
          } else if (event.type === 'document') {
            const applied = await onApplyEdit(base64ToBytes(event.hwpBase64));
            patchAssistant(a => ({
              ...a,
              edited: applied,
              error: applied ? a.error : (a.error ?? '편집 결과를 반영하려면 편집 모드여야 합니다.'),
            }));
          } else if (event.type === 'result') {
            if (event.isError) patchAssistant(a => ({ ...a, error: a.error ?? event.text }));
          } else if (event.type === 'error') {
            patchAssistant(a => ({ ...a, error: event.message }));
          }
        }
      }
    } catch (err) {
      patchAssistant(a => ({ ...a, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }, [input, busy, getDocBytes, onApplyEdit, provider, model]);

  // 프로바이더를 바꾸면 세션/맥락을 초기화합니다(라우트·인증 방식이 달라짐).
  const changeProvider = useCallback((p: 'claude' | 'gpt') => {
    setProvider(prev => {
      if (prev !== p) {
        sessionIdRef.current = null;
        setTurns([]);
      }
      return p;
    });
  }, []);

  return (
    <>
      {/* 드래그 중 전체 화면 오버레이: iframe 이 mousemove 를 가로채지 못하게 덮음 */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      <aside style={{ width }} className="flex-none relative flex flex-col bg-white dark:bg-zinc-800 border-l border-zinc-200 dark:border-zinc-700">
      {/* 왼쪽 가장자리 리사이즈 핸들 (드래그로 좌우 너비 조절) */}
      <div
        onMouseDown={startResize}
        title="드래그하여 너비 조절"
        className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize z-10 hover:bg-blue-400/40 active:bg-blue-500/60 transition-colors"
      />

      {/* Header */}
      <div className="flex-none flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">AI 편집</span>
        {/* 프로바이더 토글: Claude(구독) / GPT(API 키) */}
        <div className="flex items-center rounded-md bg-zinc-100 dark:bg-zinc-700 p-0.5 text-[11px]">
          {(['claude', 'gpt'] as const).map(p => (
            <button
              key={p}
              onClick={() => changeProvider(p)}
              disabled={busy}
              title={p === 'claude' ? 'Claude (구독 인증)' : 'GPT (OpenAI API 키)'}
              className={`px-2 py-0.5 rounded transition-colors disabled:opacity-40 ${
                provider === p
                  ? 'bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {p === 'claude' ? 'Claude' : 'GPT'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={startNewChat}
          disabled={busy || turns.length === 0}
          title="새 대화 (맥락 초기화)"
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-30 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 4v16m8-8H4" />
          </svg>
          새 대화
        </button>
        <button
          onClick={onClose}
          title="닫기"
          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 모델 선택 바 (GPT/API 경로에서만). 목록에서 고르거나 직접 입력. */}
      {provider === 'gpt' && (
        <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-700 text-[11px]">
          <span className="flex-none text-zinc-500 dark:text-zinc-400">모델</span>
          <input
            list="hwp-ai-models"
            value={model}
            onChange={e => {
              setModel(e.target.value);
              try { localStorage.setItem('hwpAiModel', e.target.value); } catch { /* 무시 */ }
            }}
            disabled={busy}
            spellCheck={false}
            placeholder="예: gpt-5.4-nano"
            className="flex-1 min-w-0 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-zinc-700 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
          <datalist id="hwp-ai-models">
            <option value="gpt-5.4-nano" />
            <option value="gpt-5-mini" />
            <option value="gpt-4o-mini" />
            <option value="gemini-2.5-flash" />
          </datalist>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {turns.length === 0 && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-8 leading-relaxed">
            문서에 대해 질문하거나<br />편집을 요청해 보세요.<br />
            <span className="text-[11px]">예: “둘째 문단 요약해줘”,<br />“‘AI’를 ‘인공지능’으로 바꿔줘”</span>
          </p>
        )}
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="self-end max-w-[85%] px-3 py-2 rounded-2xl rounded-br-sm bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm whitespace-pre-wrap break-words">
              {turn.text}
            </div>
          ) : (
            <div key={i} className="self-start max-w-[92%] flex flex-col gap-1.5">
              {turn.tools.map((t, j) => (
                <div key={j} className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  {t.summary}
                </div>
              ))}
              {turn.text && (
                <div className="px-3 py-2 rounded-2xl rounded-bl-sm bg-zinc-100 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 text-sm whitespace-pre-wrap break-words">
                  {turn.text}
                </div>
              )}
              {turn.edited && (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  문서에 반영됨
                </div>
              )}
              {turn.error && (
                <div className="px-3 py-2 rounded-2xl bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-xs">
                  {turn.error}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="self-start flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            생각하는 중...
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex-none p-3 border-t border-zinc-200 dark:border-zinc-700">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              // 한글 등 IME 조합 중 Enter(조합 확정)는 전송으로 처리하지 않습니다.
              // 이 가드가 없으면 조합-확정 Enter와 실제 Enter가 겹쳐 중복 전송됩니다.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
            rows={2}
            disabled={busy}
            className="flex-1 resize-none rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="flex-none w-9 h-9 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 flex items-center justify-center disabled:opacity-30 hover:opacity-80 transition-opacity"
            title="전송"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
      </aside>
    </>
  );
}
