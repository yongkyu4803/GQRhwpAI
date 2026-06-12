'use client';

import { useEffect, useImperativeHandle, useRef } from 'react';
import type { RhwpEditor } from '@rhwp/editor';

export type HwpEditorHandle = {
  exportHwp(): Promise<Uint8Array>;
  exportHwpx(): Promise<Uint8Array>;
};

type HwpEditorProps = {
  /** 열어둔 파일 버퍼. 없으면 빈 새 문서로 시작합니다. */
  fileBuffer?: Uint8Array | null;
  fileName?: string;
  /** 에디터가 상호작용 가능한 상태가 되면 호출됩니다. */
  onReady?: () => void;
  ref?: React.Ref<HwpEditorHandle>;
};

function HwpEditor({ fileBuffer, fileName, onReady, ref }: HwpEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<RhwpEditor | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { createEditor } = await import('@rhwp/editor');
      if (cancelled || !containerRef.current) return;
      const editor = await createEditor(containerRef.current);
      if (cancelled) { editor.destroy(); return; }
      editorInstanceRef.current = editor;
      initializedRef.current = true;
      // 파일이 주어진 경우에만 로드 — 없으면 빈 새 문서로 시작합니다.
      if (fileBuffer?.length) {
        await editor.loadFile(fileBuffer, fileName);
      }
      if (!cancelled) onReady?.();
    })();
    return () => {
      cancelled = true;
      editorInstanceRef.current?.destroy();
      editorInstanceRef.current = null;
      initializedRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 이미 마운트된 상태에서 새 파일이 열리면 다시 로드합니다.
  useEffect(() => {
    if (!initializedRef.current || !fileBuffer?.length) return;
    editorInstanceRef.current?.loadFile(fileBuffer, fileName);
  }, [fileBuffer, fileName]);

  useImperativeHandle(ref, () => ({
    exportHwp: () =>
      editorInstanceRef.current?.exportHwp() ?? Promise.resolve(new Uint8Array(0)),
    exportHwpx: () =>
      editorInstanceRef.current?.exportHwpx() ?? Promise.resolve(new Uint8Array(0)),
  }));

  return <div ref={containerRef} className="flex-1 w-full h-full" style={{ minHeight: 0 }} />;
}

export default HwpEditor;
