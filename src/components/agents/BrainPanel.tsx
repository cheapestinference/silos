import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import {
  Brain,
  Sparkles,
  Rocket,
  FileText,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Edit3,
  Database,
} from 'lucide-react';
import useTranslation from '../../i18n';

// Color class maps for category theming
const CATEGORY_COLOR_CLASSES: Record<string, { icon: string; selectedBg: string; selectedBorder: string; selectedIcon: string }> = {
  primary: { icon: 'text-primary', selectedBg: 'bg-primary/20', selectedBorder: 'border-primary/20', selectedIcon: 'text-primary' },
  emerald: { icon: 'text-emerald-400', selectedBg: 'bg-emerald-500/20', selectedBorder: 'border-emerald-500/20', selectedIcon: 'text-emerald-400' },
  sky: { icon: 'text-sky-400', selectedBg: 'bg-sky-500/20', selectedBorder: 'border-sky-500/20', selectedIcon: 'text-sky-400' },
};

// File categories based on OpenClaw workspace structure
export const FILE_CATEGORIES = [
  {
    id: 'identity',
    labelKey: 'agentDetail.identity' as const,
    icon: Sparkles,
    color: 'primary',
    descriptionKey: 'agentDetail.identityDescription' as const,
    files: [
      { name: 'IDENTITY.md', descriptionKey: 'agentDetail.identityFileDescription' as const },
      { name: 'SOUL.md', descriptionKey: 'agentDetail.soulFileDescription' as const },
      { name: 'USER.md', descriptionKey: 'agentDetail.userFileDescription' as const },
    ],
  },
  {
    id: 'memory',
    labelKey: 'agentDetail.memory' as const,
    icon: Brain,
    color: 'emerald',
    descriptionKey: 'agentDetail.memoryDescription' as const,
    files: [
      { name: 'MEMORY.md', descriptionKey: 'agentDetail.memoryFileDescription' as const },
    ],
  },
  {
    id: 'behavior',
    labelKey: 'agentDetail.behavior' as const,
    icon: Rocket,
    color: 'sky',
    descriptionKey: 'agentDetail.behaviorDescription' as const,
    files: [
      { name: 'BOOTSTRAP.md', descriptionKey: 'agentDetail.bootstrapFileDescription' as const },
      { name: 'HEARTBEAT.md', descriptionKey: 'agentDetail.heartbeatFileDescription2' as const },
      { name: 'AGENTS.md', descriptionKey: 'agentDetail.agentsFileDescription' as const },
    ],
  },
];

// Brain Panel Component - Shows agent workspace files organized by category
export function BrainPanel({ agentId: agentIdProp }: { agentId?: string } = {}) {
  const { id: routeAgentId } = useParams<{ id: string }>();
  const agentId = agentIdProp || routeAgentId;
  const { t } = useTranslation();
  const { memoryFiles, memoryContent, memoryLoading, listMemoryFiles, readMemoryFile, writeMemoryFile } = useDashboardStore();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [editedContent, setEditedContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [hasChanges, setHasChanges] = useState(false);
  const [treePanelWidth, setTreePanelWidth] = useState(216);
  const treeResizing = useRef(false);
  const treeResizeStart = useRef({ x: 0, w: 0 });
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContentRef = useRef<string>('');

  // Get file info from categories
  const getFileInfo = (fileName: string) => {
    for (const category of FILE_CATEGORIES) {
      const file = category.files.find(f => f.name.toLowerCase() === fileName.toLowerCase());
      if (file) {
        return { ...file, category };
      }
    }
    return null;
  };

  // Check if file exists in memoryFiles
  const fileExists = (fileName: string) => {
    return memoryFiles.some(f => {
      const name = f.path.split('/').pop()?.toLowerCase();
      return name === fileName.toLowerCase();
    });
  };

  // Get file path from memoryFiles
  const getFilePath = (fileName: string) => {
    const file = memoryFiles.find(f => {
      const name = f.path.split('/').pop()?.toLowerCase();
      return name === fileName.toLowerCase();
    });
    return file?.path || fileName;
  };

  // Auto-save function
  const doSave = useCallback(async (content: string) => {
    if (!selectedFile || content === lastSavedContentRef.current) return;

    setSaveStatus('saving');
    try {
      const success = await writeMemoryFile(agentId!, selectedFile, content);
      if (success) {
        lastSavedContentRef.current = content;
        setSaveStatus('saved');
        setHasChanges(false);
        setTimeout(() => setSaveStatus('idle'), 2000);
        listMemoryFiles(agentId!);
      } else {
        setSaveStatus('error');
      }
    } catch (error) {
      console.error('[BrainPanel] Save error:', error);
      setSaveStatus('error');
    }
  }, [agentId, selectedFile, writeMemoryFile, listMemoryFiles]);

  // Load memory files when component mounts or agentId changes
  useEffect(() => {
    if (agentId) {
      listMemoryFiles(agentId);
    }
  }, [agentId, listMemoryFiles]);

  // Load content when a file is selected
  useEffect(() => {
    if (selectedFile && agentId) {
      readMemoryFile(agentId, selectedFile);
    }
  }, [selectedFile, agentId, readMemoryFile]);

  // Update edited content when memoryContent loads (new file selected)
  useEffect(() => {
    if (selectedFile) {
      setEditedContent(memoryContent);
      lastSavedContentRef.current = memoryContent;
      setHasChanges(false);
      setSaveStatus('idle');
    }
  }, [memoryContent, selectedFile]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Resize handler
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!treeResizing.current) return;
      e.preventDefault();
      const delta = e.clientX - treeResizeStart.current.x;
      setTreePanelWidth(Math.max(140, Math.min(400, treeResizeStart.current.w + delta)));
    };
    const onMouseUp = () => { treeResizing.current = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  if (!agentId) return null;

  const handleSelectFile = async (filePath: string) => {
    if (hasChanges && selectedFile) {
      await doSave(editedContent);
    }
    setSelectedFile(filePath);
  };

  const handleCreateFile = async (fileName: string) => {
    const fileInfo = getFileInfo(fileName);
    const defaultContent = `# ${fileName}\n\n${fileInfo?.descriptionKey ? t(fileInfo.descriptionKey) : 'Add your content here...'}\n`;

    setSaveStatus('saving');
    try {
      const success = await writeMemoryFile(agentId, fileName, defaultContent);
      if (success) {
        await listMemoryFiles(agentId);
        setSelectedFile(fileName);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
      }
    } catch (error) {
      console.error('[BrainPanel] Create file error:', error);
      setSaveStatus('error');
    }
  };

  const handleContentChange = (newContent: string) => {
    setEditedContent(newContent);
    setHasChanges(newContent !== lastSavedContentRef.current);

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(() => {
      doSave(newContent);
    }, 1000);
  };

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories(prev =>
      prev.includes(categoryId)
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    );
  };

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* File Tree Sidebar */}
      <div className="border-r border-border bg-muted/20 flex flex-col shrink-0" style={{ width: treePanelWidth }}>
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-violet-500" />
            <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">{t('agentDetail.memory')}</h3>
          </div>
          <button onClick={() => listMemoryFiles(agentId)} className="p-1 hover:bg-muted rounded transition-colors" title="Refresh">
            <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", memoryLoading && "animate-spin")} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
          {memoryLoading && memoryFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            FILE_CATEGORIES.map((category) => {
              const CategoryIcon = category.icon;
              const isExpanded = expandedCategories.includes(category.id);
              const catColors = CATEGORY_COLOR_CLASSES[category.color] || CATEGORY_COLOR_CLASSES.primary;

              return (
                <div key={category.id}>
                  <button
                    onClick={() => toggleCategory(category.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors hover:bg-muted text-left"
                  >
                    <CategoryIcon className={cn("w-3.5 h-3.5", catColors.icon)} />
                    <span className="text-xs font-semibold text-foreground/80 flex-1 truncate">{t(category.labelKey)}</span>
                    <span className={cn("text-[10px] text-muted-foreground transition-transform", isExpanded ? "rotate-90" : "")}>▶</span>
                  </button>

                  {isExpanded && (
                    <div className="ml-2 space-y-0.5 animate-in slide-in-from-top-1 duration-150">
                      {category.files.map((file) => {
                        const exists = fileExists(file.name);
                        const filePath = getFilePath(file.name);
                        const isSelected = selectedFile === filePath || selectedFile === file.name;

                        return (
                          <button
                            key={file.name}
                            onClick={() => exists ? handleSelectFile(filePath) : handleCreateFile(file.name)}
                            className={cn(
                              "w-full text-left px-2 py-1.5 rounded-md transition-colors text-xs group flex items-center gap-2",
                              isSelected
                                ? `${catColors.selectedBg} border ${catColors.selectedBorder}`
                                : "hover:bg-muted border border-transparent"
                            )}
                          >
                            <FileText className={cn("w-3 h-3 shrink-0", isSelected ? catColors.selectedIcon : "text-muted-foreground")} />
                            <span className={cn("truncate flex-1", isSelected ? "text-foreground font-medium" : exists ? "text-foreground/80" : "text-muted-foreground")}>
                              {file.name}
                            </span>
                            {exists ? (
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                            ) : (
                              <Plus className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="w-1 shrink-0 cursor-col-resize group relative hover:bg-primary/20 active:bg-primary/30 transition-colors"
        onMouseDown={(e) => {
          e.preventDefault();
          treeResizing.current = true;
          treeResizeStart.current = { x: e.clientX, w: treePanelWidth };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      >
        <div className="absolute inset-y-0 -left-0.5 -right-0.5 group-hover:bg-primary/10" />
      </div>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{selectedFile.split('/').pop() || selectedFile}</span>
              </div>
              <div className="flex items-center gap-2">
                {saveStatus === 'saving' && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    <span className="text-[10px]">{t('agentDetail.saving')}</span>
                  </div>
                )}
                {saveStatus === 'saved' && (
                  <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="w-3 h-3" />
                    <span className="text-[10px]">{t('agentDetail.saved')}</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
                    <AlertTriangle className="w-3 h-3" />
                    <span className="text-[10px]">{t('common.error')}</span>
                  </div>
                )}
                {saveStatus === 'idle' && hasChanges && (
                  <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                    <Edit3 className="w-3 h-3" />
                    <span className="text-[10px]">{t('agentDetail.editing')}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-hidden">
              {memoryLoading ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="w-6 h-6 text-muted-foreground animate-spin" />
                </div>
              ) : (
                <textarea
                  value={editedContent}
                  onChange={(e) => handleContentChange(e.target.value)}
                  className="w-full h-full p-4 bg-transparent text-sm text-foreground font-mono focus:outline-none resize-none"
                  placeholder={t('agentDetail.fileContentPlaceholder')}
                  spellCheck={false}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-xs">
              <Database className="w-10 h-10 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">{t('agentDetail.selectFileToEdit')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
