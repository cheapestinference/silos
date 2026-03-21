import { useCallback, useRef, useEffect } from 'react';

interface DragHandleProps {
  onResize: (ratio: number) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  minLeftPx?: number;
  minRightPx?: number;
}

export function DragHandle({ onResize, containerRef, minLeftPx = 300, minRightPx = 320 }: DragHandleProps) {
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const total = rect.width;
      const clamped = Math.max(minLeftPx, Math.min(total - minRightPx, x));
      onResize(clamped / total);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onResize, containerRef, minLeftPx, minRightPx]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-border hover:bg-primary/50 transition-colors flex-shrink-0 group relative"
      title="Drag to resize"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
