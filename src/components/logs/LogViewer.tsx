import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import { LogLine } from './LogLine';
import type { ParsedLogLine } from '../../types/logs';

interface LogViewerProps {
  lines: ParsedLogLine[];
  showTimestamps?: boolean;
}

export function LogViewer({ lines, showTimestamps = true }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (autoScroll && containerRef.current && lines.length > prevLengthRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevLengthRef.current = lines.length;
  }, [lines.length, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    setShowScrollBtn(!atBottom);
  }, []);

  const jumpToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setAutoScroll(true);
      setShowScrollBtn(false);
    }
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto bg-[#0d1117]"
      >
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-600 text-sm font-mono">Waiting for logs...</p>
          </div>
        ) : (
          <div className="py-2">
            {lines.map((line, i) => (
              <LogLine key={i} line={line} showTimestamp={showTimestamps} />
            ))}
          </div>
        )}
      </div>

      {showScrollBtn && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 right-4 p-2 bg-gray-800 border border-gray-600 rounded-full shadow-lg hover:bg-gray-700 transition-colors"
        >
          <ArrowDown className="w-4 h-4 text-gray-300" />
        </button>
      )}
    </div>
  );
}
