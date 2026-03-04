import * as React from 'react';
import {
  FileText,
  Plus,
  Trash2,
  Edit3,
  Save,
  X,
  File,
  FileJson,
  HelpCircle,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '../ui/select';
import type { KnowledgeFile, KnowledgeFileType } from '../../types/openclaw';

interface KnowledgeTabProps {
  files: KnowledgeFile[];
  onAdd: (file: Omit<KnowledgeFile, 'id' | 'createdAt'>) => Promise<string | null>;
  onUpdate: (fileId: string, updates: Partial<KnowledgeFile>) => Promise<boolean>;
  onDelete: (fileId: string) => Promise<boolean>;
}

export function KnowledgeTab({ files, onAdd, onUpdate, onDelete }: KnowledgeTabProps) {
  const { t } = useTranslation();
  const [isAdding, setIsAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [newFile, setNewFile] = React.useState<{
    name: string;
    content: string;
    type: KnowledgeFileType;
  }>({ name: '', content: '', type: 'text' });
  const [editContent, setEditContent] = React.useState('');

  const fileTypeIcons: Record<KnowledgeFileType, React.ElementType> = {
    text: FileText,
    markdown: File,
    json: FileJson,
  };

  const handleAdd = async () => {
    if (!newFile.name.trim() || !newFile.content.trim()) return;

    const id = await onAdd(newFile);
    if (id) {
      setNewFile({ name: '', content: '', type: 'text' });
      setIsAdding(false);
    }
  };

  const handleUpdate = async (fileId: string) => {
    if (!editContent.trim()) return;

    const success = await onUpdate(fileId, { content: editContent });
    if (success) {
      setEditingId(null);
      setEditContent('');
    }
  };

  const handleDelete = async (fileId: string) => {
    await onDelete(fileId);
  };

  const startEditing = (file: KnowledgeFile) => {
    setEditingId(file.id);
    setEditContent(file.content);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-emerald-400" />
          <h3 className="text-lg font-semibold">{t('agents.config.knowledgeFiles')}</h3>
          <Tooltip>
            <TooltipTrigger>
              <HelpCircle className="w-4 h-4 text-zinc-500 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs">
              {t('agents.config.knowledgeFilesDesc')}
            </TooltipContent>
          </Tooltip>
        </div>

        <Button
          onClick={() => setIsAdding(true)}
          disabled={isAdding}
          size="sm"
          className="gap-2"
        >
          <Plus className="w-4 h-4" />
          {t('agents.config.addFile')}
        </Button>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground">
        {t('agents.config.knowledgeFilesDesc')}
      </p>

      {/* Add New File Form */}
      {isAdding && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-emerald-400">{t('agents.config.addFile')}</h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsAdding(false);
                setNewFile({ name: '', content: '', type: 'text' });
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">{t('agents.config.fileName')}</label>
              <Input
                value={newFile.name}
                onChange={(e) => setNewFile({ ...newFile, name: e.target.value })}
                placeholder="document.md"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">{t('agents.config.fileType')}</label>
              <Select
                value={newFile.type}
                onValueChange={(value) => setNewFile({ ...newFile, type: value as KnowledgeFileType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="markdown">Markdown</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">{t('agents.config.fileContent')}</label>
            <Textarea
              value={newFile.content}
              onChange={(e) => setNewFile({ ...newFile, content: e.target.value })}
              placeholder="File content..."
              className="min-h-[150px] font-mono text-sm"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setIsAdding(false);
                setNewFile({ name: '', content: '', type: 'text' });
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!newFile.name.trim() || !newFile.content.trim()}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <Save className="w-4 h-4 mr-2" />
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}

      {/* Files List */}
      <div className="space-y-2">
        {files.length === 0 && !isAdding ? (
          <div className="rounded-lg border border-dashed border-zinc-700 p-8 text-center">
            <FileText className="w-10 h-10 mx-auto mb-3 text-zinc-600" />
            <p className="text-sm text-zinc-500">{t('agents.config.noFiles')}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setIsAdding(true)}
            >
              <Plus className="w-4 h-4 mr-2" />
              {t('agents.config.addFile')}
            </Button>
          </div>
        ) : (
          files.map((file) => {
            const Icon = fileTypeIcons[file.type];
            const isEditing = editingId === file.id;

            return (
              <div
                key={file.id}
                className={cn(
                  'rounded-lg border bg-card p-4',
                  isEditing ? 'border-emerald-500/50' : 'border-border'
                )}
              >
                {isEditing ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-emerald-400" />
                        <span className="font-medium">{file.name}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingId(null);
                          setEditContent('');
                        }}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="min-h-[150px] font-mono text-sm"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(null);
                          setEditContent('');
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleUpdate(file.id)}
                        className="bg-emerald-600 hover:bg-emerald-700"
                      >
                        <Save className="w-4 h-4 mr-2" />
                        {t('common.save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                        <Icon className="w-5 h-5 text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium truncate">{file.name}</h4>
                        <p className="text-xs text-zinc-500 mt-0.5">
                          {file.type} • {file.content.length.toLocaleString()} chars
                        </p>
                        <p className="text-sm text-zinc-400 mt-2 line-clamp-2">
                          {file.content}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => startEditing(file)}
                      >
                        <Edit3 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        onClick={() => handleDelete(file.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
