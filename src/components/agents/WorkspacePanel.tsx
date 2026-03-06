import { useState, useEffect, useRef } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import {
  FolderOpen,
  FolderPlus,
  FilePlus,
  ChevronRight,
  ChevronDown,
  FileText,
  Trash2,
  Pencil,
  RefreshCw,
  X,
  Check,
  AlertTriangle,
  MoreHorizontal,
  Upload,
} from 'lucide-react';

interface WorkspacePanelProps {
  agentId: string;
}

type FileEntry = { path: string; size: number; mtime: number; type: 'file' | 'directory' };

// Build tree structure from flat file list
type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  children: TreeNode[];
};

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  // Sort: directories first, then alphabetically
  const sorted = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  for (const file of sorted) {
    const parts = file.path.split('/');
    const name = parts[parts.length - 1];
    const node: TreeNode = { name, path: file.path, type: file.type, size: file.size, children: [] };

    if (parts.length === 1) {
      root.push(node);
      if (file.type === 'directory') dirMap.set(file.path, node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = dirMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        root.push(node);
      }
      if (file.type === 'directory') dirMap.set(file.path, node);
    }
  }

  return root;
}

function FileTreeItem({
  node,
  depth,
  selectedPath,
  expanded,
  onSelect,
  onToggle,
  onDelete,
  onRename,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onSelect: (path: string, type: 'file' | 'directory') => void;
  onToggle: (path: string) => void;
  onDelete: (path: string, type: 'file' | 'directory') => void;
  onRename: (path: string) => void;
}) {
  const isDir = node.type === 'directory';
  const isExpanded = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  return (
    <>
      <div
        className={cn(
          "group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-xs transition-colors relative",
          isSelected ? "bg-primary/10 text-foreground" : "hover:bg-muted text-foreground/80 hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (isDir) onToggle(node.path);
          onSelect(node.path, node.type);
        }}
      >
        {isDir ? (
          isExpanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3.5" />
        )}
        {isDir ? (
          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-500" />
        ) : (
          <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate flex-1 font-medium">{node.name}</span>
        {!isDir && node.size > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0">{(node.size / 1024).toFixed(1)}K</span>
        )}
        <div className="relative" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/10 transition-opacity"
          >
            <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-6 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[120px] animate-in fade-in duration-100">
              <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(false); onRename(node.path); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                <Pencil className="w-3 h-3" /> Rename
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setShowMenu(false); onDelete(node.path, node.type); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {isDir && isExpanded && node.children.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          expanded={expanded}
          onSelect={onSelect}
          onToggle={onToggle}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}
    </>
  );
}

export function WorkspacePanel({ agentId }: WorkspacePanelProps) {
  const {
    workspaceFiles, workspaceContent, workspaceLoading,
    listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile,
    deleteWorkspaceFile, mkdirWorkspace, renameWorkspaceFile, deleteWorkspaceDir,
  } = useDashboardStore();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'file' | 'directory'>('file');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editContent, setEditContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; type: 'file' | 'directory' } | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (agentId) listWorkspaceFiles(agentId);
  }, [agentId, listWorkspaceFiles]);

  useEffect(() => {
    if (selectedPath && selectedType === 'file') {
      setEditContent(workspaceContent);
      lastSavedRef.current = workspaceContent;
    }
  }, [workspaceContent, selectedPath, selectedType]);

  const handleSelect = (path: string, type: 'file' | 'directory') => {
    setSelectedPath(path);
    setSelectedType(type);
    if (type === 'file') readWorkspaceFile(agentId, path);
  };

  const handleToggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const handleContentChange = (value: string) => {
    setEditContent(value);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      if (!selectedPath || value === lastSavedRef.current) return;
      setSaveStatus('saving');
      const ok = await writeWorkspaceFile(agentId, selectedPath, value);
      if (ok) { lastSavedRef.current = value; setSaveStatus('saved'); setTimeout(() => setSaveStatus('idle'), 2000); }
      else setSaveStatus('error');
    }, 1000);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const parentDir = selectedPath && selectedType === 'directory' ? selectedPath + '/' : '';
    const fullPath = parentDir + newName.trim();
    let ok: boolean;
    if (creating === 'folder') {
      ok = await mkdirWorkspace(agentId, fullPath);
    } else {
      ok = await writeWorkspaceFile(agentId, fullPath, '');
    }
    if (ok) {
      await listWorkspaceFiles(agentId);
      if (creating === 'file') handleSelect(fullPath, 'file');
      if (parentDir) setExpanded(prev => new Set(prev).add(parentDir.slice(0, -1)));
    }
    setCreating(null);
    setNewName('');
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const parentDir = selectedPath && selectedType === 'directory' ? selectedPath + '/' : '';
    for (const file of Array.from(files)) {
      const fullPath = parentDir + file.name;
      const text = await file.text();
      await writeWorkspaceFile(agentId, fullPath, text);
    }
    await listWorkspaceFiles(agentId);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRename = async () => {
    if (!renaming || !renameName.trim()) return;
    const parts = renaming.split('/');
    parts[parts.length - 1] = renameName.trim();
    const newPath = parts.join('/');
    const ok = await renameWorkspaceFile(agentId, renaming, newPath);
    if (ok) {
      await listWorkspaceFiles(agentId);
      if (selectedPath === renaming) { setSelectedPath(newPath); }
    }
    setRenaming(null);
    setRenameName('');
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const ok = deleteConfirm.type === 'directory'
      ? await deleteWorkspaceDir(agentId, deleteConfirm.path)
      : await deleteWorkspaceFile(agentId, deleteConfirm.path);
    if (ok) {
      if (selectedPath === deleteConfirm.path) { setSelectedPath(null); setEditContent(''); }
      await listWorkspaceFiles(agentId);
    }
    setDeleteConfirm(null);
  };

  const tree = buildTree(workspaceFiles);

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* File Tree Sidebar */}
      <div className="w-72 border-r border-border bg-muted/30 flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-amber-500" />
            <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Workspace</h3>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => { setCreating('file'); setNewName(''); }} className="p-1 hover:bg-muted rounded transition-colors" title="New file">
              <FilePlus className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button onClick={() => { setCreating('folder'); setNewName(''); }} className="p-1 hover:bg-muted rounded transition-colors" title="New folder">
              <FolderPlus className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="p-1 hover:bg-muted rounded transition-colors" title="Upload files">
              <Upload className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
            <button onClick={() => listWorkspaceFiles(agentId)} className="p-1 hover:bg-muted rounded transition-colors" title="Refresh">
              <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", workspaceLoading && "animate-spin")} />
            </button>
          </div>
        </div>

        {/* Create input */}
        {creating && (
          <div className="p-2 border-b border-border bg-muted/50">
            <div className="flex items-center gap-1.5">
              {creating === 'folder' ? <FolderPlus className="w-3.5 h-3.5 text-amber-500 shrink-0" /> : <FilePlus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(null); }}
                placeholder={creating === 'folder' ? 'folder name' : 'filename.ext'}
                className="flex-1 text-xs bg-card border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
              />
              <button onClick={handleCreate} className="p-1 hover:bg-muted rounded"><Check className="w-3.5 h-3.5 text-emerald-500" /></button>
              <button onClick={() => setCreating(null)} className="p-1 hover:bg-muted rounded"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
            </div>
          </div>
        )}

        {/* File tree */}
        <div className="flex-1 overflow-y-auto p-1">
          {workspaceLoading && workspaceFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : tree.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              <FolderOpen className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
              Empty workspace
            </div>
          ) : (
            tree.map((node) => (
              <FileTreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                onSelect={handleSelect}
                onToggle={handleToggle}
                onDelete={(path, type) => setDeleteConfirm({ path, type })}
                onRename={(path) => { setRenaming(path); setRenameName(path.split('/').pop() || ''); }}
              />
            ))
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedPath && selectedType === 'file' ? (
          <>
            <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{selectedPath}</span>
              </div>
              <div className="flex items-center gap-2">
                {saveStatus === 'saving' && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
                {saveStatus === 'saved' && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                {saveStatus === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
              </div>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              {workspaceLoading ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
                </div>
              ) : (
                <textarea
                  value={editContent}
                  onChange={(e) => handleContentChange(e.target.value)}
                  className="w-full h-full p-3 bg-muted border border-border rounded-lg text-sm text-foreground font-mono focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 resize-none transition-all"
                  spellCheck={false}
                />
              )}
            </div>
          </>
        ) : selectedPath && selectedType === 'directory' ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FolderOpen className="w-12 h-12 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-sm font-medium">{selectedPath}/</p>
              <p className="text-xs mt-1">
                {workspaceFiles.filter(f => f.path.startsWith(selectedPath + '/') && !f.path.slice(selectedPath.length + 1).includes('/')).length} items
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FolderOpen className="w-12 h-12 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-sm">Select a file to edit</p>
            </div>
          </div>
        )}
      </div>

      {/* Rename Modal */}
      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setRenaming(null)} />
          <div className="relative bg-card border border-border rounded-xl p-5 shadow-xl w-96 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-sm font-bold text-foreground mb-3">Rename</h3>
            <input
              autoFocus
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(null); }}
              className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground font-mono focus:outline-none focus:border-primary/50"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setRenaming(null)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-muted hover:bg-muted/80 text-foreground transition-colors">Cancel</button>
              <button onClick={handleRename} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-card border border-border rounded-xl p-5 shadow-xl w-96 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              <h3 className="text-sm font-bold text-foreground">Delete {deleteConfirm.type}?</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              <span className="font-mono text-foreground">{deleteConfirm.path}</span>
              {deleteConfirm.type === 'directory' && ' and all its contents'}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-muted hover:bg-muted/80 text-foreground transition-colors">Cancel</button>
              <button onClick={handleDelete} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
