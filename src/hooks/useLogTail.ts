import { useState, useRef, useCallback, useEffect } from 'react';
import { getGatewayClient } from '../lib/gateway-client';
import type { ParsedLogLine, LogLevel } from '../types/logs';
import { parseLogLine } from '../types/logs';

const POLL_INTERVAL = 1500;
const MAX_LINES = 2000;

interface UseLogTailOptions {
  levelFilter?: LogLevel[];
  searchText?: string;
}

export function useLogTail(options: UseLogTailOptions = {}) {
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [file, setFile] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const cursorRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;

    const client = getGatewayClient();
    if (!client?.connected) {
      setConnected(false);
      return;
    }

    try {
      const result = await client.tailLogs({
        cursor: cursorRef.current,
        limit: 500,
      });

      setConnected(true);
      if (result.file) setFile(result.file);

      if (result.reset) {
        cursorRef.current = 0;
        setLines([]);
      }

      if (result.lines.length > 0) {
        cursorRef.current = result.cursor;
        const parsed = result.lines.map(parseLogLine);
        setLines(prev => {
          const combined = [...prev, ...parsed];
          return combined.length > MAX_LINES
            ? combined.slice(combined.length - MAX_LINES)
            : combined;
        });
      }
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (paused) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }

    poll();

    timerRef.current = setInterval(poll, POLL_INTERVAL);

    const onVisChange = () => {
      if (document.visibilityState === 'visible' && !paused) {
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [poll, paused]);

  const filteredLines = lines.filter(line => {
    if (options.levelFilter && options.levelFilter.length > 0 && !options.levelFilter.includes(line.level)) {
      return false;
    }
    if (options.searchText) {
      const search = options.searchText.toLowerCase();
      return line.message.toLowerCase().includes(search) ||
             line.subsystem.toLowerCase().includes(search) ||
             line.raw.toLowerCase().includes(search);
    }
    return true;
  });

  const clear = useCallback(() => {
    setLines([]);
    cursorRef.current = 0;
  }, []);

  return {
    lines: filteredLines,
    allLines: lines,
    file,
    connected,
    paused,
    setPaused,
    clear,
    totalCount: lines.length,
    filteredCount: filteredLines.length,
  };
}
