'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HwpEditorHandle } from './HwpEditor';

type HwpDocumentType = {
  pageCount(): number;
  renderPageSvg(page: number): string;
  renderPageToCanvas(page: number, canvas: HTMLCanvasElement, scale: number): void;
  free(): void;
};

type PickerOptions = {
  multiple?: boolean;
  types?: Array<{
    accept?: Record<string, string[]>;
  }>;
};

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: PickerOptions) => Promise<any[]>;
};

// WASM init — singleton
let wasmReady = false;
let wasmInitPromise: Promise<void> | null = null;

function initWasm(): Promise<void> {
  if (wasmReady) return Promise.resolve();
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    let ctx: CanvasRenderingContext2D | null = null;
    let lastFont = '';
    (globalThis as any).measureTextWidth = (font: string, text: string): number => {
      if (!ctx) ctx = document.createElement('canvas').getContext('2d')!;
      if (font !== lastFont) { ctx.font = font; lastFont = font; }
      return ctx.measureText(text).width;
    };
    const init = (await import('@rhwp/core')).default;
    await init({ module_or_path: '/rhwp_bg.wasm' });
    wasmReady = true;
  })();

  return wasmInitPromise;
}

function parseSvgWidth(svg: string): number {
  const m = svg.match(/<svg[^>]+width="([\d.]+)"/);
  return m ? parseFloat(m[1]) : 794;
}

function isCrossOriginPickerError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'SecurityError' || error.message.includes('Cross origin sub frames'))
  );
}

function buildPickerAccept(options?: PickerOptions): string {
  const tokens = new Set<string>();
  for (const type of options?.types ?? []) {
    for (const [mime, exts] of Object.entries(type.accept ?? {})) {
      if (mime && mime !== '*/*') tokens.add(mime);
      for (const ext of exts ?? []) {
        if (!ext || ext === '.*') continue;
        tokens.add(ext.startsWith('.') ? ext : `.${ext}`);
      }
    }
  }
  return Array.from(tokens).join(',');
}

function openFilesWithInput(options?: PickerOptions): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = Boolean(options?.multiple);
    const accept = buildPickerAccept(options);
    if (accept) input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
    };
    const abort = () => {
      settled = true;
      cleanup();
      reject(new DOMException('The user aborted a request.', 'AbortError'));
    };
    const complete = (files: File[]) => {
      settled = true;
      cleanup();
      resolve(files);
    };

    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (settled) return;
        const files = input.files ? Array.from(input.files) : [];
        if (files.length > 0) complete(files);
        else abort();
      }, 0);
    };

    input.addEventListener(
      'change',
      () => {
        if (settled) return;
        const files = input.files ? Array.from(input.files) : [];
        if (files.length > 0) complete(files);
        else abort();
      },
      { once: true },
    );

    window.addEventListener('focus', onWindowFocus, { once: true });
    input.click();
  });
}

function createFallbackFileHandles(files: File[]) {
  return files.map(file => ({
    kind: 'file' as const,
    name: file.name,
    getFile: async () => file,
    isSameEntry: async (entry: { name?: string } | null) => entry?.name === file.name,
    queryPermission: async () => 'granted' as const,
    requestPermission: async () => 'granted' as const,
    createWritable: async () => {
      throw new DOMException('Writable handle is unavailable in fallback mode.', 'NotSupportedError');
    },
  }));
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const THUMBNAIL_W = 120;

const HwpEditorDynamic = dynamic(() => import('./HwpEditor'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
      <p className="text-sm">에디터를 불러오는 중...</p>
    </div>
  ),
});

export default function HwpViewer() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [svgPages, setSvgPages] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // 랜딩 시 빈 새 문서 편집 화면으로 시작합니다.
  const [mode, setMode] = useState<'viewer' | 'editor'>('editor');
  const [editorReady, setEditorReady] = useState(false);
  const [docKey, setDocKey] = useState(0);
  // 랜딩 편집기에 빈 문서를 먼저 준비한 뒤 마운트하기 위한 플래그
  const [booted, setBooted] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HwpDocumentType | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const fileBufferRef = useRef<Uint8Array | null>(null);
  const editorRef = useRef<HwpEditorHandle | null>(null);

  // 랜딩 시 빈 문서를 미리 만들어 두고 편집기를 마운트합니다.
  // (문서 없이 편집기를 띄우면 메뉴/툴바가 비활성 상태로 남습니다.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mode === 'editor' && !fileBufferRef.current) {
        const bytes = await makeBlankBuffer();
        if (!cancelled && bytes) fileBufferRef.current = bytes;
      } else {
        await initWasm().catch(() => {});
      }
      if (!cancelled) setBooted(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-origin iframe fallback for libraries calling showOpenFilePicker()
  useEffect(() => {
    const pickerWindow = window as PickerWindow;
    const originalPicker = pickerWindow.showOpenFilePicker?.bind(window);
    const patchedPicker = async (options?: PickerOptions) => {
      if (originalPicker) {
        try {
          return await originalPicker(options);
        } catch (error) {
          if (!isCrossOriginPickerError(error)) throw error;
        }
      }
      const files = await openFilesWithInput(options);
      return createFallbackFileHandles(files);
    };

    try {
      pickerWindow.showOpenFilePicker = patchedPicker;
    } catch {
      return;
    }

    return () => {
      try {
        if (originalPicker) pickerWindow.showOpenFilePicker = originalPicker;
        else delete pickerWindow.showOpenFilePicker;
      } catch {
        // noop
      }
    };
  }, []);

  // Scroll active thumbnail into view
  useEffect(() => {
    thumbRefs.current[page]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [page]);

  // Keyboard shortcuts — disabled while in editor mode (iframe handles keys)
  useEffect(() => {
    if (mode !== 'viewer') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (status === 'ready') {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          setPage(p => Math.max(0, p - 1));
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          setPage(p => Math.min(totalPages - 1, p + 1));
        }
      }
      if (e.key === '+' || e.key === '=') {
        setZoom(z => Math.min(ZOOM_MAX, parseFloat((z + ZOOM_STEP).toFixed(2))));
      } else if (e.key === '-') {
        setZoom(z => Math.max(ZOOM_MIN, parseFloat((z - ZOOM_STEP).toFixed(2))));
      } else if (e.key === '0') {
        setZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, totalPages, mode]);

  const loadFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(hwpx?)$/i)) {
      setErrorMsg('.hwp 또는 .hwpx 파일만 지원합니다.');
      setStatus('error');
      return;
    }

    docRef.current?.free();
    docRef.current = null;
    setEditorReady(false);
    setMode('viewer');
    setStatus('loading');
    setErrorMsg('');
    setSvgPages([]);
    setPage(0);

    try {
      await initWasm();
      const { HwpDocument } = await import('@rhwp/core');
      const buffer = new Uint8Array(await file.arrayBuffer());
      fileBufferRef.current = buffer;

      const doc = new (HwpDocument as any)(buffer) as HwpDocumentType;
      docRef.current = doc;

      const count = doc.pageCount();
      const pages: string[] = [];
      for (let i = 0; i < count; i++) pages.push(doc.renderPageSvg(i));

      setSvgPages(pages);
      setTotalPages(count);
      setFileName(file.name);
      setStatus('ready');
    } catch (e: any) {
      setErrorMsg(e?.message ?? '파일을 열 수 없습니다.');
      setStatus('error');
    }
  }, []);

  async function reloadFromBuffer() {
    if (!fileBufferRef.current) return;
    setStatus('loading');
    setSvgPages([]);
    setPage(0);
    try {
      await initWasm();
      const { HwpDocument } = await import('@rhwp/core');
      docRef.current?.free();
      const doc = new (HwpDocument as any)(fileBufferRef.current) as HwpDocumentType;
      docRef.current = doc;
      const count = doc.pageCount();
      const pages: string[] = [];
      for (let i = 0; i < count; i++) pages.push(doc.renderPageSvg(i));
      setSvgPages(pages);
      setTotalPages(count);
      setStatus('ready');
    } catch (e: any) {
      setErrorMsg(e?.message ?? '파일을 열 수 없습니다.');
      setStatus('error');
    }
  }

  // 빈 HWP 문서 버퍼를 생성합니다.
  // 문서가 없으면 studio 에디터는 "파일 선택" 대기 상태로 남아 메뉴/툴바 클릭이 먹지 않으므로,
  // 빈 문서라도 항상 로드해줘야 편집이 가능합니다.
  async function makeBlankBuffer(): Promise<Uint8Array | null> {
    try {
      await initWasm();
      const { HwpDocument } = await import('@rhwp/core');
      // createEmpty()는 용지 설정이 없는 0×0 빈 깡통이라 화면에 페이지가 그려지지 않습니다.
      // createBlankDocument()로 A4 용지·여백을 갖춘 정상 빈 문서로 채운 뒤 내보냅니다.
      const blank = (HwpDocument as any).createEmpty() as {
        createBlankDocument(): string;
        exportHwp(): Uint8Array;
        free?(): void;
      };
      blank.createBlankDocument();
      const bytes = blank.exportHwp();
      blank.free?.();
      return bytes;
    } catch {
      return null; // 생성 실패 시에도 에디터로는 진입
    }
  }

  async function newDocument() {
    docRef.current?.free();
    docRef.current = null;
    setFileName('');
    setErrorMsg('');
    setEditorReady(false);
    fileBufferRef.current = await makeBlankBuffer();
    setMode('editor');
    setDocKey(k => k + 1); // 에디터를 강제로 다시 마운트해 빈 문서로 초기화
  }

  async function handleModeToggle() {
    if (mode === 'viewer') {
      docRef.current?.free();
      docRef.current = null;
      setEditorReady(false);
      setMode('editor');
    } else {
      setStatus('loading');
      try {
        const editedBytes = await editorRef.current?.exportHwp();
        if (editedBytes?.length) fileBufferRef.current = editedBytes;
      } catch { /* use original buffer on failure */ }
      setMode('viewer');
      await reloadFromBuffer();
    }
  }

  async function handleSave(format: 'hwp' | 'hwpx') {
    const buffer = await (format === 'hwp'
      ? editorRef.current?.exportHwp()
      : editorRef.current?.exportHwpx());
    if (!buffer?.length) return;
    const blob = new Blob([buffer.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: fileName.replace(/\.(hwpx?)$/i, `.${format}`),
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // 편집 모드에서 파일을 열면 뷰어 대신 에디터로 바로 로드합니다.
  // (studio iframe 내부의 "열기"는 cross-origin 제약으로 showOpenFilePicker가 막히므로,
  //  파일 열기는 항상 부모 input → editor.loadFile(postMessage) 경로로 처리합니다.)
  async function openFileIntoEditor(file: File) {
    if (!file.name.match(/\.(hwpx?)$/i)) {
      setErrorMsg('.hwp 또는 .hwpx 파일만 지원합니다.');
      setStatus('error');
      setMode('viewer');
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    fileBufferRef.current = buffer;
    setFileName(file.name);
    setEditorReady(false);
    setDocKey(k => k + 1); // 새 버퍼로 에디터를 재마운트해 해당 파일을 로드
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      if (mode === 'editor') openFileIntoEditor(file);
      else loadFile(file);
    }
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }

  async function exportPdf() {
    if (!docRef.current || exporting) return;
    setExporting(true);
    setExportProgress(0);
    try {
      const { jsPDF } = await import('jspdf');
      const scale = 2;
      const dpi = 96 * scale;
      let pdf: InstanceType<typeof jsPDF> | null = null;

      for (let i = 0; i < totalPages; i++) {
        const canvas = document.createElement('canvas');
        docRef.current.renderPageToCanvas(i, canvas, scale);
        const mmW = (canvas.width / dpi) * 25.4;
        const mmH = (canvas.height / dpi) * 25.4;
        const imgData = canvas.toDataURL('image/jpeg', 0.95);

        if (!pdf) {
          pdf = new jsPDF({
            orientation: mmW > mmH ? 'landscape' : 'portrait',
            unit: 'mm',
            format: [mmW, mmH],
          });
        } else {
          pdf.addPage([mmW, mmH], mmW > mmH ? 'landscape' : 'portrait');
        }
        pdf.addImage(imgData, 'JPEG', 0, 0, mmW, mmH);
        setExportProgress(Math.round(((i + 1) / totalPages) * 100));
      }
      pdf!.save(`${fileName.replace(/\.(hwpx?)$/i, '')}.pdf`);
    } catch (e: any) {
      alert('PDF 내보내기 실패: ' + (e?.message ?? '알 수 없는 오류'));
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  }

  const currentSvg = svgPages[page] ?? '';
  const svgNativeWidth = parseSvgWidth(currentSvg);
  const isReady = status === 'ready';

  return (
    <div className="flex flex-col h-screen bg-zinc-100 dark:bg-zinc-900 overflow-hidden">

      {/* ── Header ── */}
      <header className="flex-none flex items-center gap-2 px-4 py-2 bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 shadow-sm">

        {/* Sidebar toggle — viewer only */}
        {mode === 'viewer' && (
          <button
            onClick={() => setSidebarOpen(o => !o)}
            title="사이드바 토글"
            disabled={!isReady}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-30 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M4 6h16M4 12h10M4 18h16" />
            </svg>
          </button>
        )}

        {/* Logo + filename */}
        <span className="font-bold text-zinc-800 dark:text-zinc-100 text-sm tracking-tight select-none">rhwp</span>
        {fileName ? (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 truncate max-w-[200px]">{fileName}</span>
        ) : mode === 'editor' ? (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 truncate max-w-[200px]">새 문서</span>
        ) : null}

        <div className="flex-1" />

        {/* Viewer-only controls */}
        {mode === 'viewer' && isReady && (
          <>
            {/* Zoom */}
            <div className="flex items-center gap-1">
              <button onClick={() => setZoom(z => Math.max(ZOOM_MIN, parseFloat((z - ZOOM_STEP).toFixed(2))))}
                className="w-7 h-7 rounded flex items-center justify-center text-lg font-medium hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                title="축소 (-)">−</button>
              <button onClick={() => setZoom(1)}
                className="min-w-[52px] text-center text-xs font-mono px-1.5 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                title="원래 크기 (0)">
                {Math.round(zoom * 100)}%
              </button>
              <button onClick={() => setZoom(z => Math.min(ZOOM_MAX, parseFloat((z + ZOOM_STEP).toFixed(2))))}
                className="w-7 h-7 rounded flex items-center justify-center text-lg font-medium hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                title="확대 (+)">+</button>
            </div>

            {/* Page indicator */}
            <span className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums px-1">
              {page + 1} / {totalPages}
            </span>

            {/* PDF export */}
            <button
              onClick={exportPdf}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              title="PDF로 내보내기"
            >
              {exporting ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  {exportProgress}%
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  PDF
                </>
              )}
            </button>
          </>
        )}

        {/* Editor-only controls: save buttons */}
        {mode === 'editor' && editorReady && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSave('hwp')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              HWP 저장
            </button>
            <button
              onClick={() => handleSave('hwpx')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              HWPX 저장
            </button>
          </div>
        )}

        {/* View / Edit toggle */}
        {((mode === 'editor' && editorReady) || (mode === 'viewer' && isReady)) && (
          <button
            onClick={handleModeToggle}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition-colors
              ${mode === 'viewer'
                ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:opacity-80'
                : 'border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700'}
            `}
            title={mode === 'viewer' ? '편집 모드로 전환' : '보기 모드로 전환 (수정 사항 반영)'}
          >
            {mode === 'viewer' ? (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                편집
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                보기
              </>
            )}
          </button>
        )}

        {/* New document */}
        <button
          onClick={newDocument}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
          title="빈 새 문서 만들기"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 4v16m8-8H4" />
          </svg>
          새 문서
        </button>

        {/* Open file */}
        <button
          onClick={() => inputRef.current?.click()}
          className="px-3 py-1.5 text-xs font-medium rounded-full border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
        >
          파일 열기
        </button>
        <input ref={inputRef} type="file" accept=".hwp,.hwpx" className="hidden" onChange={handleFileChange} />
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar — viewer mode only */}
        {mode === 'viewer' && isReady && sidebarOpen && (
          <aside className="flex-none w-36 bg-white dark:bg-zinc-800 border-r border-zinc-200 dark:border-zinc-700 overflow-y-auto py-3 flex flex-col gap-2 items-center">
            {svgPages.map((svg, i) => {
              const nativeW = parseSvgWidth(svg);
              const thumbScale = THUMBNAIL_W / nativeW;
              return (
                <button
                  key={i}
                  ref={el => { thumbRefs.current[i] = el; }}
                  onClick={() => setPage(i)}
                  className={`
                    flex flex-col items-center gap-1 p-1 rounded-md w-full transition-colors
                    ${i === page
                      ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/30'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-700'}
                  `}
                >
                  <div
                    style={{ width: THUMBNAIL_W, overflow: 'hidden' }}
                    className="rounded shadow-sm border border-zinc-200 dark:border-zinc-600 bg-white"
                  >
                    <div
                      style={{ transformOrigin: 'top left', transform: `scale(${thumbScale})`, width: `${100 / thumbScale}%` }}
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">{i + 1}</span>
                </button>
              );
            })}
          </aside>
        )}

        {/* ── Main area ── */}
        <main className="flex-1 overflow-auto relative flex flex-col">

          {/* Editor mode — 빈 문서를 준비(booted)한 뒤 마운트 */}
          {mode === 'editor' && (
            booted ? (
              <HwpEditorDynamic
                key={docKey}
                ref={editorRef}
                fileBuffer={fileBufferRef.current}
                fileName={fileName}
                onReady={() => setEditorReady(true)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
                <p className="text-sm">새 문서를 준비하는 중...</p>
              </div>
            )
          )}

          {/* Viewer mode */}
          {mode === 'viewer' && (
            <>
              {status === 'idle' || status === 'error' ? (
                <div
                  onDrop={handleDrop}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onClick={() => inputRef.current?.click()}
                  className={`
                    absolute inset-0 flex flex-col items-center justify-center gap-4 cursor-pointer m-8 rounded-2xl
                    border-2 border-dashed transition-colors
                    ${isDragging
                      ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-500'}
                  `}
                >
                  <svg className="w-12 h-12 text-zinc-300 dark:text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <div className="text-center">
                    <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                      HWP / HWPX 파일을 드래그하거나 클릭하여 열기
                    </p>
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">.hwp, .hwpx 지원</p>
                  </div>
                  {status === 'error' && (
                    <p className="text-sm text-red-500 font-medium">{errorMsg}</p>
                  )}
                </div>

              ) : status === 'loading' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
                  <svg className="w-8 h-8 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <p className="text-sm">문서를 불러오는 중...</p>
                </div>

              ) : (
                <div className="min-h-full flex flex-col items-center py-6 px-4">
                  {/* Zoomed SVG page */}
                  <div
                    style={{ width: svgNativeWidth * zoom }}
                    className="shadow-xl rounded-sm overflow-hidden bg-white"
                    dangerouslySetInnerHTML={{ __html: currentSvg }}
                  />

                  {/* Page navigation */}
                  {totalPages > 1 && (
                    <div className="flex items-center gap-4 mt-6 mb-2">
                      <button
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full border border-zinc-300 dark:border-zinc-600 disabled:opacity-30 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                        이전
                      </button>
                      <span className="text-sm text-zinc-500 dark:text-zinc-400 tabular-nums min-w-[70px] text-center">
                        {page + 1} / {totalPages}
                      </span>
                      <button
                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={page === totalPages - 1}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-full border border-zinc-300 dark:border-zinc-600 disabled:opacity-30 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                      >
                        다음
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
