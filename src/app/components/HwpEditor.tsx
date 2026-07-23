'use client';

import { useEffect, useImperativeHandle, useRef } from 'react';
import type { RhwpEditor } from '@rhwp/editor';

export type HwpEditorHandle = {
  exportHwp(): Promise<Uint8Array>;
  exportHwpx(): Promise<Uint8Array>;
  /** 주어진 HWP 바이트를 에디터에 다시 로드합니다 (AI 편집 결과 반영). */
  loadBytes(bytes: Uint8Array, fileName?: string): Promise<void>;
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
      // 기본값은 레포에 함께 배포한 self-host studio(public/studio) 입니다. 이 빌드는
      // 표 선 드래그 리사이즈 등 최신 기능을 포함합니다. 외부 호스팅 studio 로 바꾸려면
      // NEXT_PUBLIC_RHWP_STUDIO_URL 로 그 URL 을 지정하면 됩니다.
      const studioUrl = process.env.NEXT_PUBLIC_RHWP_STUDIO_URL || '/studio/index.html';
      const editor = await createEditor(containerRef.current, { studioUrl });
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
    loadBytes: async (bytes, name) => {
      await editorInstanceRef.current?.loadFile(bytes, name ?? fileName);
    },
  }));

  return <div ref={containerRef} className="flex-1 w-full h-full" style={{ minHeight: 0 }} />;
}

export default HwpEditor;
