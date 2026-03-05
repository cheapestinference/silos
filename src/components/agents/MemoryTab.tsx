import { useState, useEffect } from 'react';
import {
  Brain,
  HelpCircle,
  Clock,
  FileText,
  Save,
  RefreshCw,
  Loader2,
  AlertCircle,
  Check,
  Plus,
  FolderOpen,
} from 'lucide-react';
import { Textarea } from '../ui/textarea';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useTranslation } from '../../i18n';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';

interface MemoryTabProps {
  agentId: string;
  value: string;
  onChange: (value: string) => void;
  lastUpdated?: number;
}

export function MemoryTab({ agentId, value, onChange, lastUpdated }: MemoryTabProps) {
  const { t } = useTranslation();
  const {
    memoryFiles,
    memoryContent,
    memoryLoading,
    listMemoryFiles,
    readMemoryFile,
    writeMemoryFile,
  } = useDashboardStore();

  // Debug logging
  console.log('[MemoryTab] RENDER', {
    agentId,
    filesCount: memoryFiles?.length ?? 0,
    loading: memoryLoading,
    files: memoryFiles?.map((f: {path: string}) => f.path)
  });

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [creatingFile, setCreatingFile] = useState(false);

  // Load memory files on mount and when agent changes
  useEffect(() => {
    console.log('[MemoryTab] Effect triggered - agentId:', agentId);
    if (agentId) {
      console.log('[MemoryTab] Calling listMemoryFiles for:', agentId);
      listMemoryFiles(agentId).then(() => {
        console.log('[MemoryTab] listMemoryFiles completed');
      }).catch((err) => {
        console.error('[MemoryTab] listMemoryFiles error:', err);
      });
    }
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update edited content when memory content loads
  useEffect(() => {
    if (selectedFile) {
      setEditedContent(memoryContent);
    }
  }, [memoryContent, selectedFile]);

  const handleSelectFile = async (filePath: string) => {
    setSelectedFile(filePath);
    setSaved(false);
    await readMemoryFile(agentId, filePath);
  };

  const handleSaveFile = async () => {
    if (!selectedFile) return;

    setSaving(true);
    setSaved(false);
    try {
      const success = await writeMemoryFile(agentId, selectedFile, editedContent);
      if (success) {
        setSaved(true);
        // Reload file list to update timestamps
        await listMemoryFiles(agentId);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (error) {
      console.error('Failed to save memory file:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;

    const filePath = newFileName.endsWith('.md') ? newFileName : `${newFileName}.md`;

    setCreatingFile(true);
    try {
      const success = await writeMemoryFile(agentId, filePath, '# New Memory File\n\nAdd your content here...');
      if (success) {
        await listMemoryFiles(agentId);
        setNewFileName('');
        setSelectedFile(filePath);
        await readMemoryFile(agentId, filePath);
      }
    } catch (error) {
      console.error('Failed to create memory file:', error);
    } finally {
      setCreatingFile(false);
    }
  };

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return t('time.never');
    return new Date(timestamp).toLocaleString();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const getFileIcon = (path: string) => {
    if (path.includes('personality') || path.includes('persona')) {
      return { icon: Brain, color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' };
    }
    if (path.includes('long') || path.includes('memory')) {
      return { icon: Brain, color: 'text-blue-500 dark:text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' };
    }
    return { icon: FileText, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' };
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 h-full">
      {/* LEFT: File Browser */}
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-semibold">Memory Files</h3>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => listMemoryFiles(agentId)}
            disabled={memoryLoading}
            className="h-8 w-8"
          >
            <RefreshCw className={cn("w-4 h-4", memoryLoading && "animate-spin")} />
          </Button>
        </div>

        {/* Context Memory (Quick Access) */}
        <div className="space-y-2">
          <button
            onClick={() => {
              setSelectedFile(null);
              setEditedContent(value);
            }}
            className={cn(
              "w-full p-3 rounded-lg border transition-all text-left",
              selectedFile === null
                ? "bg-purple-500/10 border-purple-500/30"
                : "bg-muted border-border hover:bg-muted"
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              <Brain className="w-4 h-4 text-purple-400" />
              <span className="font-medium text-sm">Context Memory</span>
            </div>
            <p className="text-xs text-muted-foreground">Agent's working memory</p>
          </button>
        </div>

        {/* Create New File */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="filename.md"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
              className="h-9 text-sm"
              disabled={creatingFile}
            />
            <Button
              size="sm"
              onClick={handleCreateFile}
              disabled={!newFileName.trim() || creatingFile}
              className="gap-1.5"
            >
              {creatingFile ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>

        {/* File List */}
        <div className="flex-1 overflow-y-auto space-y-2">
          {memoryLoading && memoryFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : memoryFiles.length === 0 ? (
            <div className="space-y-3">
              <div className="text-center py-4 text-muted-foreground text-sm">
                <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="font-medium">No memory files yet</p>
                <p className="text-xs mt-1">Create recommended files below</p>
              </div>

              {/* Recommended Files */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground px-1">Quick Start:</p>
                {[
                  { name: 'personality.md', desc: 'Agent personality & tone', icon: Brain, color: 'purple' },
                  { name: 'long-term-memory.md', desc: 'Persistent knowledge', icon: Brain, color: 'blue' },
                  { name: 'preferences.md', desc: 'User preferences', icon: FileText, color: 'green' },
                ].map((file) => (
                  <button
                    key={file.name}
                    onClick={() => {
                      setNewFileName(file.name);
                      handleCreateFile();
                    }}
                    className="w-full p-2.5 rounded-lg border border-border bg-muted/50 hover:bg-muted transition-all text-left group"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <file.icon className={cn("w-3.5 h-3.5", `text-${file.color}-400`)} />
                      <span className="font-medium text-xs">{file.name}</span>
                      <Plus className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    <p className="text-[10px] text-muted-foreground">{file.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            memoryFiles.map((file) => {
              const { icon: Icon, color, bg, border } = getFileIcon(file.path);
              return (
                <button
                  key={file.path}
                  onClick={() => handleSelectFile(file.path)}
                  className={cn(
                    "w-full p-3 rounded-lg border transition-all text-left",
                    selectedFile === file.path
                      ? `${bg} ${border}`
                      : "bg-muted border-border hover:bg-muted"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn("w-4 h-4", color)} />
                    <span className="font-medium text-sm truncate">{file.path}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatFileSize(file.size)}</span>
                    <span>•</span>
                    <span>{new Date(file.mtime).toLocaleDateString()}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Info Card */}
        <div className="rounded-lg bg-purple-500/10 border border-purple-500/20 p-3">
          <div className="flex items-start gap-2">
            <HelpCircle className="w-4 h-4 text-purple-400 mt-0.5" />
            <div className="text-xs text-muted-foreground">
              <p className="font-medium text-purple-400 mb-1">Memory Files</p>
              <p>Store personality, preferences, and long-term context for the agent.</p>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Editor */}
      <div className="flex flex-col gap-4">
        {/* Editor Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {selectedFile ? (
              <>
                <FileText className="w-5 h-5 text-muted-foreground" />
                <h3 className="text-lg font-semibold">{selectedFile}</h3>
              </>
            ) : (
              <>
                <Brain className="w-5 h-5 text-purple-400" />
                <h3 className="text-lg font-semibold">{t('agents.config.contextMemory')}</h3>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {saved && (
              <div className="flex items-center gap-1.5 text-sm text-green-400">
                <Check className="w-4 h-4" />
                Saved
              </div>
            )}
            {lastUpdated && !selectedFile && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="w-3.5 h-3.5" />
                {formatDate(lastUpdated)}
              </div>
            )}
            <Button
              size="sm"
              onClick={selectedFile ? handleSaveFile : () => onChange(editedContent)}
              disabled={saving || memoryLoading}
              className="gap-1.5"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Description */}
        {!selectedFile && (
          <p className="text-sm text-muted-foreground">
            {t('agents.config.contextMemoryDesc')}
          </p>
        )}

        {/* Editor */}
        <div className="flex-1 min-h-0">
          {memoryLoading && selectedFile ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Textarea
              value={selectedFile ? editedContent : value}
              onChange={(e) => {
                if (selectedFile) {
                  setEditedContent(e.target.value);
                } else {
                  onChange(e.target.value);
                  setEditedContent(e.target.value);
                }
              }}
              placeholder={
                selectedFile
                  ? "Edit memory file content..."
                  : t('agents.config.contextMemoryPlaceholder')
              }
              className="h-full min-h-[400px] font-mono text-sm resize-none"
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div>
            {(selectedFile ? editedContent : value).length.toLocaleString()} characters
          </div>
          {!selectedFile && (
            <div className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Changes saved automatically with config
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
