import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import {
  Plus,
  RefreshCw,
  CheckCircle2,
  Clock,
  AlertTriangle,
  CalendarClock,
  Edit3,
} from 'lucide-react';
import { CronJobList, CronJobForm } from '../cron';
import useTranslation from '../../i18n';
import type { CronJob } from '../../types/openclaw';

export function ScheduledPanel() {
  const { id: agentId } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const {
    readMemoryFile, writeMemoryFile, memoryContent, memoryLoading,
    cronJobs: allCronJobs, toggleCronJob: onToggle, runCronJob: onRun,
    deleteCronJob: onDelete, addCronJob: onAdd, updateCronJob: onUpdate,
  } = useDashboardStore();

  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [heartbeatContent, setHeartbeatContent] = useState('');
  const [heartbeatSaveStatus, setHeartbeatSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatLastSavedRef = useRef('');

  // Load HEARTBEAT.md on mount
  useEffect(() => {
    if (agentId) readMemoryFile(agentId, 'HEARTBEAT.md');
  }, [agentId, readMemoryFile]);

  // Sync loaded content
  useEffect(() => {
    setHeartbeatContent(memoryContent);
    heartbeatLastSavedRef.current = memoryContent;
  }, [memoryContent]);

  // Cleanup
  useEffect(() => {
    return () => { if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current); };
  }, []);

  if (!agentId) return null;
  const cronJobs = allCronJobs.filter(j => j.agentId === agentId);

  const handleHeartbeatChange = (value: string) => {
    setHeartbeatContent(value);
    if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
    heartbeatTimeoutRef.current = setTimeout(async () => {
      if (value === heartbeatLastSavedRef.current) return;
      setHeartbeatSaveStatus('saving');
      const ok = await writeMemoryFile(agentId, 'HEARTBEAT.md', value);
      if (ok) {
        heartbeatLastSavedRef.current = value;
        setHeartbeatSaveStatus('saved');
        setTimeout(() => setHeartbeatSaveStatus('idle'), 2000);
      } else {
        setHeartbeatSaveStatus('error');
      }
    }, 1000);
  };

  const handleFormSave = async (jobData: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => {
    setFormSaving(true);
    try {
      const jobWithAgent = { ...jobData, agentId };
      if (editingJob) {
        await onUpdate(editingJob.id, jobWithAgent);
      } else {
        await onAdd(jobWithAgent);
      }
      setShowForm(false);
      setEditingJob(null);
    } finally {
      setFormSaving(false);
    }
  };

  const handleEdit = (job: CronJob) => {
    setEditingJob(job);
    setShowForm(true);
  };

  const enabledCount = cronJobs.filter(j => j.enabled).length;

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Left: Cron Jobs (60%) */}
      <div className="flex-[3] flex flex-col border-r border-border overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/20 flex items-center justify-center">
                <CalendarClock className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                  {t('agentDetail.cronJobsSection')}
                </h3>
                <p className="text-[10px] text-muted-foreground">
                  {cronJobs.length} {cronJobs.length !== 1 ? t('agentDetail.jobsPlural') : t('agentDetail.jobSingular')} · {t('agentDetail.activeCount', { count: enabledCount })}
                </p>
              </div>
            </div>
            <button
              onClick={() => { setEditingJob(null); setShowForm(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all"
            >
              <Plus className="w-3 h-3" />
              {t('agentDetail.newTask')}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-2">
            {t('agentDetail.cronJobsHint')}
          </p>
        </div>

        {/* Cron Jobs List */}
        <div className="flex-1 overflow-y-auto p-3">
          <CronJobList
            jobs={cronJobs}
            onToggle={(id, enabled) => onToggle(id, enabled)}
            onRun={onRun}
            onEdit={handleEdit}
            onDelete={onDelete}
            showAgentInfo={false}
            emptyMessage={t('agentDetail.noScheduledTasks')}
          />
        </div>
      </div>

      {/* Right: Heartbeat (40%) */}
      <div className="flex-[2] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500/20 to-pink-500/20 border border-rose-500/30 flex items-center justify-center">
                <Clock className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                  {t('agentDetail.heartbeatSection')}
                </h3>
                <p className="text-[10px] text-muted-foreground">HEARTBEAT.md</p>
              </div>
            </div>
            {/* Save status */}
            <div className="flex items-center gap-1.5">
              {heartbeatSaveStatus === 'saving' && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
              {heartbeatSaveStatus === 'saved' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
              {heartbeatSaveStatus === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
              {heartbeatSaveStatus === 'idle' && heartbeatContent !== heartbeatLastSavedRef.current && heartbeatContent !== '' && (
                <Edit3 className="w-3.5 h-3.5 text-amber-500" />
              )}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-2">
            {t('agentDetail.heartbeatHint')}
          </p>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden p-4">
          {memoryLoading ? (
            <div className="flex items-center justify-center h-full">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            <textarea
              value={heartbeatContent}
              onChange={(e) => handleHeartbeatChange(e.target.value)}
              className="w-full h-full p-4 bg-muted border border-border rounded-xl text-sm text-foreground font-mono focus:outline-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/20 resize-none transition-all"
              placeholder="- [ ] Check server status\n- [ ] Review pending pull requests\n- [ ] Monitor error rates\n- [ ] Check disk usage on production"
              spellCheck={false}
            />
          )}
        </div>
      </div>

      {/* Form Modal */}
      {showForm && (
        <CronJobForm
          job={editingJob || undefined}
          agentId={agentId}
          onSave={handleFormSave}
          onCancel={() => { setShowForm(false); setEditingJob(null); }}
          saving={formSaving}
        />
      )}
    </div>
  );
}
