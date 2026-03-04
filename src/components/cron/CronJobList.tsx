import { useState } from 'react';
import { Clock, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { CronJobCard } from './CronJobCard';
import type { CronJob, CronRunLogEntry } from '../../types/openclaw';

interface CronJobListProps {
  jobs: CronJob[];
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
  onEdit?: (job: CronJob) => void;
  onDelete: (id: string) => void;
  onLoadRuns?: (jobId: string) => Promise<CronRunLogEntry[]>;
  showAgentInfo?: boolean;
  getAgentName?: (agentId: string) => string | undefined;
  emptyMessage?: string;
  loading?: boolean;
}

export function CronJobList({
  jobs,
  onToggle,
  onRun,
  onEdit,
  onDelete,
  onLoadRuns,
  showAgentInfo = false,
  getAgentName,
  emptyMessage = 'No periodic tasks configured',
  loading = false,
}: CronJobListProps) {
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const filteredJobs = jobs.filter((job) => {
    if (filter === 'enabled') return job.enabled;
    if (filter === 'disabled') return !job.enabled;
    return true;
  });

  const enabledCount = jobs.filter((j) => j.enabled).length;

  const handleDelete = async (id: string) => {
    onDelete(id);
    setDeleteConfirm(null);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="py-6">
              <div className="h-20 bg-muted animate-pulse rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <Card className="py-16">
        <div className="text-center">
          <Clock className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-30" />
          <h3 className="text-lg font-medium">No Periodic Tasks</h3>
          <p className="text-muted-foreground mt-1">{emptyMessage}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Filter:</span>
        {(['all', 'enabled', 'disabled'] as const).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f === 'all' && ` (${jobs.length})`}
            {f === 'enabled' && ` (${enabledCount})`}
            {f === 'disabled' && ` (${jobs.length - enabledCount})`}
          </Button>
        ))}
      </div>

      {/* Jobs List */}
      {filteredJobs.length === 0 ? (
        <Card className="py-8">
          <div className="text-center">
            <Clock className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-30" />
            <p className="text-muted-foreground">
              {filter !== 'all' ? `No ${filter} tasks found` : 'No tasks match your filter'}
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredJobs.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={() => onToggle(job.id, !job.enabled)}
              onRun={() => onRun(job.id)}
              onEdit={onEdit ? () => onEdit(job) : undefined}
              onDelete={() => setDeleteConfirm(job.id)}
              onLoadRuns={onLoadRuns}
              showAgentInfo={showAgentInfo}
              agentName={job.agentId && getAgentName ? getAgentName(job.agentId) : undefined}
            />
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setDeleteConfirm(null)}
          />
          <Card className="relative z-10 w-full max-w-md mx-4">
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                <h3 className="font-semibold">Delete Periodic Task</h3>
              </div>
              <p className="text-muted-foreground">
                Are you sure you want to delete this task? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleDelete(deleteConfirm)}
                >
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
