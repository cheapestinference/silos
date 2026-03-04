import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  File,
  Code2,
  RefreshCw,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDashboardStore } from '../../store/dashboard-store';

// ---------- Types ----------

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
  children: TreeNode[];
}

// ---------- Helpers ----------

function extractAgentId(sessionKey: string): string | null {
  // agent:{agentId}:... -> agentId
  if (sessionKey.startsWith('agent:')) {
    const parts = sessionKey.split(':');
    if (parts.length >= 2) return parts[1];
  }
  // webchat:g-agent-{agentId}...
  const webchatMatch = sessionKey.match(/webchat:g-agent-([^-]+)/);
  if (webchatMatch) return webchatMatch[1];
  return null;
}

function buildTree(files: Array<{ path: string; size: number; mtime: number; type?: string }>): TreeNode[] {
  const root: TreeNode[] = [];

  // Helper to ensure a directory node exists at a given path
  function ensureDir(parts: string[], nodes: TreeNode[]): TreeNode[] {
    let current = nodes;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let dir = current.find(n => n.type === 'directory' && n.name === name);
      if (!dir) {
        dir = {
          name,
          path: parts.slice(0, i + 1).join('/'),
          type: 'directory',
          children: [],
        };
        current.push(dir);
      }
      current = dir.children;
    }
    return current;
  }

  for (const file of files) {
    const parts = file.path.split('/');

    if (file.type === 'directory') {
      // Explicit directory entry — just ensure it exists (including empty dirs)
      ensureDir(parts, root);
    } else {
      // File entry — ensure parent dirs exist, then add the file
      const parentParts = parts.slice(0, -1);
      const current = parentParts.length > 0 ? ensureDir(parentParts, root) : root;
      const name = parts[parts.length - 1];

      // Avoid duplicate file entries
      if (!current.find(n => n.type === 'file' && n.name === name)) {
        current.push({
          name,
          path: file.path,
          type: 'file',
          size: file.size,
          mtime: file.mtime,
          children: [],
        });
      }
    }
  }

  // Sort: directories first, then alphabetically
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children.length > 0) sortNodes(node.children);
    }
  }
  sortNodes(root);

  return root;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'txt') return FileText;
  if (ext === 'json' || ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return Code2;
  return File;
}

// ---------- TreeItem ----------

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  expandedDirs,
  toggleDir,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
}) {
  const isDir = node.type === 'directory';
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = node.path === selectedPath;

  const Icon = isDir
    ? (isExpanded ? FolderOpen : Folder)
    : getFileIcon(node.name);

  return (
    <>
      <button
        onClick={() => isDir ? toggleDir(node.path) : onSelect(node.path)}
        className={cn(
          'w-full flex items-center gap-1.5 py-1 px-1.5 rounded text-xs transition-colors text-left group',
          isSelected
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
        style={{ paddingLeft: `${6 + depth * 16}px` }}
      >
        {isDir && (
          isExpanded
            ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Icon className={cn(
          'h-3.5 w-3.5 shrink-0',
          isDir ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
        )} />
        <span className="truncate flex-1">{node.name}</span>
        {!isDir && node.size != null && (
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            {formatSize(node.size)}
          </span>
        )}
      </button>
      {isDir && isExpanded && node.children.map(child => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          expandedDirs={expandedDirs}
          toggleDir={toggleDir}
        />
      ))}
    </>
  );
}

// ---------- WorkspaceExplorer ----------

export function WorkspaceExplorer({ sessionKey }: { sessionKey: string }) {
  const {
    memoryFiles,
    memoryContent,
    memoryLoading,
    listMemoryFiles,
    readMemoryFile,
  } = useDashboardStore();

  const agentId = extractAgentId(sessionKey);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Load files on mount
  useEffect(() => {
    if (agentId) {
      listMemoryFiles(agentId);
    }
  }, [agentId, listMemoryFiles]);

  const tree = useMemo(() => buildTree(memoryFiles), [memoryFiles]);

  // Expand all directories by default after first load
  useEffect(() => {
    if (memoryFiles.length > 0) {
      const dirs = new Set<string>();
      for (const file of memoryFiles) {
        const parts = file.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'));
        }
      }
      setExpandedDirs(dirs);
    }
  }, [memoryFiles]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedFile(path);
    if (agentId) {
      readMemoryFile(agentId, path);
    }
  }, [agentId, readMemoryFile]);

  const handleRefresh = useCallback(() => {
    if (agentId) {
      listMemoryFiles(agentId);
    }
  }, [agentId, listMemoryFiles]);

  if (!agentId) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground p-4">
        Unable to determine agent for this session
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Workspace
        </span>
        <button
          onClick={handleRefresh}
          disabled={memoryLoading}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', memoryLoading && 'animate-spin')} />
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-1 py-1 custom-scrollbar">
        {memoryLoading && memoryFiles.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : memoryFiles.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            No files in workspace
          </div>
        ) : (
          tree.map(node => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedFile}
              onSelect={handleSelectFile}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
            />
          ))
        )}
      </div>

      {/* File Preview */}
      {selectedFile && (
        <div className="border-t border-border/50 flex flex-col max-h-[45%]">
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
            <span className="text-[10px] font-mono text-muted-foreground truncate">
              {selectedFile}
            </span>
            <button
              onClick={() => setSelectedFile(null)}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="flex-1 overflow-auto px-3 py-2 custom-scrollbar">
            {memoryLoading ? (
              <div className="flex items-center justify-center py-4">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <pre className="text-[11px] leading-relaxed font-mono text-foreground/80 whitespace-pre-wrap break-words">
                {memoryContent}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
