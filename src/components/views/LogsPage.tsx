import { useState, useCallback } from 'react';
import { ScrollText, Pause, Play, Trash2, FileText } from 'lucide-react';
import { useLogTail } from '../../hooks/useLogTail';
import { LogViewer } from '../logs/LogViewer';
import { LogFilterBar } from '../logs/LogFilterBar';
import type { LogLevel } from '../../types/logs';

export function LogsPage() {
  const [activeLevels, setActiveLevels] = useState<LogLevel[]>([
    'error', 'warn', 'info', 'debug',
  ]);
  const [searchText, setSearchText] = useState('');

  const { lines, file, connected, paused, setPaused, clear, totalCount, filteredCount } = useLogTail({
    levelFilter: activeLevels,
    searchText,
  });

  const handleToggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels(prev =>
      prev.includes(level) ? prev.filter(l => l !== level) : [...prev, level]
    );
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <ScrollText className="w-4 h-4 text-cyan-400" />
          <h1 className="text-sm font-semibold text-gray-200">Gateway Logs</h1>
          <div className="flex items-center gap-1.5 ml-2">
            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-600'}`} />
            <span className="text-[10px] text-gray-500">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-600 tabular-nums">
            {filteredCount !== totalCount ? `${filteredCount}/` : ''}{totalCount} lines
          </span>

          {file && (
            <span className="text-[10px] text-gray-700 font-mono max-w-48 truncate flex items-center gap-1" title={file}>
              <FileText className="w-3 h-3" />{file.split('/').pop()}
            </span>
          )}

          <button
            onClick={() => setPaused(!paused)}
            className={`p-1.5 rounded-md text-xs transition-colors ${
              paused
                ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
            }`}
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={clear}
            className="p-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
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

      <LogViewer lines={lines} />
    </div>
  );
}
