import { useState, useCallback } from 'react';
import { ScrollText, Pause, Play, Trash2, FileText } from 'lucide-react';
import { useLogTail } from '../../hooks/useLogTail';
import { LogViewer } from '../logs/LogViewer';
import { LogFilterBar } from '../logs/LogFilterBar';
import { LogDetailPanel } from '../logs/LogDetailPanel';
import type { LogLevel } from '../../types/logs';

export function LogsPage() {
  const [activeLevels, setActiveLevels] = useState<LogLevel[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedLineIndex, setSelectedLineIndex] = useState<number | null>(null);

  const { lines, file, connected, paused, setPaused, clear, totalCount, filteredCount } = useLogTail({
    levelFilter: activeLevels,
    searchText,
  });

  const handleToggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels(prev =>
      prev.includes(level) ? prev.filter(l => l !== level) : [...prev, level]
    );
  }, []);

  const selectedLine = selectedLineIndex !== null ? lines[selectedLineIndex] : null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <ScrollText className="w-4 h-4 text-cyan-500" />
          <h1 className="text-sm font-semibold text-foreground">Gateway Logs</h1>
          <div className="flex items-center gap-1.5 ml-2">
            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
            <span className="text-[10px] text-muted-foreground">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {filteredCount !== totalCount ? `${filteredCount}/` : ''}{totalCount} lines
          </span>

          {file && (
            <span className="text-[10px] text-muted-foreground/40 font-mono max-w-48 truncate flex items-center gap-1" title={file}>
              <FileText className="w-3 h-3" />{file.split('/').pop()}
            </span>
          )}

          <button
            onClick={() => setPaused(!paused)}
            className={`p-1.5 rounded-md text-xs transition-colors ${
              paused
                ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => { clear(); setSelectedLineIndex(null); }}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Clear"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <LogFilterBar
        activeLevels={activeLevels}
        onToggleLevel={handleToggleLevel}
        searchText={searchText}
        onSearchChange={setSearchText}
      />

      {/* Main area: log viewer + optional detail panel */}
      <div className="flex-1 flex overflow-hidden">
        <LogViewer
          lines={lines}
          selectedIndex={selectedLineIndex}
          onSelectLine={setSelectedLineIndex}
        />

        {selectedLine && (
          <LogDetailPanel
            line={selectedLine}
            onClose={() => setSelectedLineIndex(null)}
          />
        )}
      </div>
    </div>
  );
}
