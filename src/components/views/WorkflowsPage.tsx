import { useState, useEffect } from 'react';
import { Loader2, Layers, Inbox } from 'lucide-react';
import { fetchLobsterFiles, fetchLobsterWorkflow } from '../../lib/lobster-api';
import type { LobsterFileEntry, LobsterWorkflow } from '../../types/lobster';
import { WorkflowCard } from '../lobster/WorkflowCard';
import { WorkflowDetail } from '../lobster/WorkflowDetail';

export function WorkflowsPage() {
  const [files, setFiles] = useState<LobsterFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<LobsterWorkflow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchLobsterFiles()
      .then(setFiles)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSelectWorkflow = async (file: LobsterFileEntry) => {
    setLoadingDetail(true);
    const workflow = await fetchLobsterWorkflow(file.agentId, file.filename);
    if (workflow) setSelectedWorkflow(workflow);
    setLoadingDetail(false);
  };

  if (selectedWorkflow) {
    return <WorkflowDetail workflow={selectedWorkflow} onBack={() => setSelectedWorkflow(null)} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <Layers className="w-4 h-4 text-orange-400" />
          <h1 className="text-lg font-semibold text-foreground">Workflows</h1>
        </div>
        <span className="text-xs text-muted-foreground">{files.length} workflow{files.length !== 1 ? 's' : ''}</span>
      </div>

      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
        ) : loadingDetail ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            <span className="ml-2 text-sm text-muted-foreground">Loading workflow...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Inbox className="w-10 h-10 text-muted-foreground/30 mb-3" />
            <h3 className="text-sm font-medium text-foreground">No workflows found</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm text-center">
              Create <code className="px-1 py-0.5 bg-muted rounded text-[10px]">.lobster</code> files in your agent workspaces to define automated pipelines with approval checkpoints.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {files.map(file => (
              <WorkflowCard
                key={`${file.agentId}/${file.filename}`}
                workflow={file}
                onClick={() => handleSelectWorkflow(file)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
