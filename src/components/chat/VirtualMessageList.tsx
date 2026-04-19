import { useEffect, useRef, useState, type ReactElement } from 'react';

// Threshold for kicking in virtualization. Previously 500 meant typical
// conversations (100-300 msgs) paid the full-render cost. 80 is a sweet spot:
// small chats stay simple, mid-sized ones benefit.
const VIRTUALIZE_THRESHOLD = 80;
const BUFFER = 30;

interface VirtualMessageListProps {
  children: ReactElement[];
}

export function VirtualMessageList({ children }: VirtualMessageListProps) {
  if (children.length < VIRTUALIZE_THRESHOLD) {
    return <>{children}</>;
  }
  return <VirtualList items={children} />;
}

function VirtualList({ items }: { items: ReactElement[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [visible, setVisible] = useState<Set<number>>(() => {
    // Initially mount the last N items (visible viewport ~ bottom).
    const start = Math.max(0, items.length - BUFFER * 2);
    return new Set(Array.from({ length: items.length - start }, (_, i) => start + i));
  });

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const idx = Number((entry.target as HTMLElement).dataset.idx);
            if (Number.isFinite(idx)) {
              if (entry.isIntersecting) {
                for (let j = Math.max(0, idx - BUFFER); j <= Math.min(items.length - 1, idx + BUFFER); j++) {
                  next.add(j);
                }
              }
            }
          }
          return next;
        });
      },
      { root: null, rootMargin: '200px' },
    );
    for (const el of itemRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items.length]);

  return (
    <div ref={containerRef}>
      {items.map((item, i) => (
        <div
          key={i}
          ref={(el) => { itemRefs.current[i] = el; }}
          data-idx={i}
          style={{ minHeight: visible.has(i) ? undefined : 40 }}
        >
          {visible.has(i) ? item : null}
        </div>
      ))}
    </div>
  );
}
