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

// File categories based on OpenClaw workspace structure
export const FILE_CATEGORIES = [
  {
    id: 'identity',
    labelKey: 'agentDetail.identity' as const,
    icon: Sparkles,
    color: 'violet',
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
export function BrainPanel() {
  const { id: agentId } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { memoryFiles, memoryContent, memoryLoading, listMemoryFiles, readMemoryFile, writeMemoryFile } = useDashboardStore();
  // agentId is guaranteed by route, but guard for type safety — placed after hooks to satisfy React rules
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
  const [editedContent, setEditedContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [hasChanges, setHasChanges] = useState(false);
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
        // Refresh file list to update any new files
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
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  if (!agentId) return null;

  const handleSelectFile = async (filePath: string) => {
    // Save current file before switching if there are changes
    if (hasChanges && selectedFile) {
      await doSave(editedContent);
    }
    setSelectedFile(filePath);
  };

  const handleCreateFile = async (fileName: string) => {
    // Create file with default template
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

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout for auto-save (1 second debounce)
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

  const selectedFileInfo = selectedFile ? getFileInfo(selectedFile.split('/').pop() || selectedFile) : null;
  const selectedFileCategoryDesc = selectedFileInfo?.category?.descriptionKey;
  const selectedFileDescription = selectedFileInfo?.descriptionKey ?? selectedFileCategoryDesc ?? ('agentDetail.workspaceFile' as const);

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Files Sidebar - Organized by Category */}
      <div className="w-80 border-r border-border bg-muted/50 flex flex-col">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
                {t('agentDetail.memory')}
              </h3>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">{t('agentDetail.memoryDescription')}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {memoryLoading && memoryFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            FILE_CATEGORIES.map((category) => {
              const CategoryIcon = category.icon;
              const isExpanded = expandedCategories.includes(category.id);

              return (
                <div key={category.id} className="space-y-1">
                  {/* Category Header */}
                  <button
                    onClick={() => toggleCategory(category.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-all",
                      "hover:bg-muted text-left"
                    )}
                  >
                    <CategoryIcon className={cn("w-4 h-4", `text-${category.color}-400`)} />
                    <span className="text-xs font-semibold text-foreground/80 flex-1">
                      {t(category.labelKey)}
                    </span>
                    <span className={cn(
                      "text-[10px] text-muted-foreground transition-transform",
                      isExpanded ? "rotate-90" : ""
                    )}>
                      ▶
                    </span>
                  </button>

                  {/* Category Files */}
                  {isExpanded && (
                    <div className="ml-2 space-y-1 animate-in slide-in-from-top-1 duration-150">
                      {category.files.map((file) => {
                        const exists = fileExists(file.name);
                        const filePath = getFilePath(file.name);
                        const isSelected = selectedFile === filePath || selectedFile === file.name;

                        return (
                          <button
                            key={file.name}
                            onClick={() => exists ? handleSelectFile(filePath) : handleCreateFile(file.name)}
                            className={cn(
                              "w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 group",
                              isSelected
                                ? `bg-${category.color}-500/20 border border-${category.color}-500/30`
                                : "hover:bg-muted border border-transparent hover:border-border"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <FileText className={cn(
                                "w-3.5 h-3.5",
                                isSelected ? `text-${category.color}-400` : exists ? "text-muted-foreground" : "text-muted-foreground"
                              )} />
                              <span className={cn(
                                "text-xs font-medium",
                                isSelected ? "text-foreground" : exists ? "text-foreground/80" : "text-muted-foreground"
                              )}>
                                {file.name}
                              </span>
                              {exists ? (
                                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              ) : (
                                <Plus className="ml-auto w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                              )}
                            </div>
                            <p className={cn(
                              "text-[10px] mt-0.5 pl-5",
                              isSelected ? "text-muted-foreground" : "text-muted-foreground"
                            )}>
                              {t(file.descriptionKey)}
                            </p>
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

        {/* Info */}
        <div className="p-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {t('agentDetail.fileEditingHint')}
          </p>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-xl border flex items-center justify-center",
                  selectedFileInfo?.category
                    ? `bg-${selectedFileInfo.category.color}-500/10 border-${selectedFileInfo.category.color}-500/20`
                    : "bg-muted border-border"
                )}>
                  {selectedFileInfo?.category ? (
                    <selectedFileInfo.category.icon className={cn("w-5 h-5", `text-${selectedFileInfo.category.color}-400`)} />
                  ) : (
                    <FileText className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {selectedFile.split('/').pop() || selectedFile}
                  </h3>
                  <p className="text-[10px] text-muted-foreground">
                    {t(selectedFileDescription)}
                  </p>
                </div>
              </div>
              {/* Save status indicator */}
              <div className="flex items-center gap-2">
                {saveStatus === 'saving' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted">
                    <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
                    <span className="text-xs text-muted-foreground">{t('agentDetail.saving')}</span>
                  </div>
                )}
                {saveStatus === 'saved' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('agentDetail.saved')}</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                    <span className="text-xs text-red-600 dark:text-red-400">{t('common.error')}</span>
                  </div>
                )}
                {saveStatus === 'idle' && hasChanges && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <Edit3 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="text-xs text-amber-600 dark:text-amber-400">{t('agentDetail.editing')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Content - Always editable textarea */}
            <div className="flex-1 overflow-hidden p-6">
              {memoryLoading ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="w-6 h-6 text-muted-foreground animate-spin" />
                </div>
              ) : (
                <textarea
                  value={editedContent}
                  onChange={(e) => handleContentChange(e.target.value)}
                  className="w-full h-full p-4 bg-muted border border-border rounded-xl text-sm text-foreground font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 resize-none transition-all"
                  placeholder={t('agentDetail.fileContentPlaceholder')}
                  spellCheck={false}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm">
              <Database className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-2">{t('agentDetail.selectFileToEdit')}</p>
              <p className="text-xs text-muted-foreground">
                {t('agentDetail.workspaceExplanation')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
