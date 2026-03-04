import { useState, useEffect } from 'react';
import {
  X,
  Calendar,
  Repeat,
  CalendarClock,
  Save,
  Loader2,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import type {
  CronJob,
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
} from '../../types/openclaw';

type ScheduleKind = 'at' | 'every' | 'cron';

interface CronJobFormProps {
  job?: CronJob;
  agentId?: string;
  onSave: (job: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => Promise<void>;
  onCancel: () => void;
  saving?: boolean;
}

export function CronJobForm({
  job,
  agentId,
  onSave,
  onCancel,
  saving = false,
}: CronJobFormProps) {
  const isEditing = !!job;

  // Form state
  const [name, setName] = useState(job?.name || '');
  const [description, setDescription] = useState(job?.description || '');
  const [enabled, setEnabled] = useState(job?.enabled ?? true);

  // Schedule
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(job?.schedule.kind || 'every');
  const [atDate, setAtDate] = useState('');
  const [atTime, setAtTime] = useState('');
  const [everyValue, setEveryValue] = useState('1');
  const [everyUnit, setEveryUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [cronExpr, setCronExpr] = useState('');
  const [cronTz, setCronTz] = useState('');

  // Payload
  const [payloadKind, setPayloadKind] = useState<'systemEvent' | 'agentTurn'>(
    job?.payload.kind || 'agentTurn'
  );
  const [payloadText, setPayloadText] = useState(
    job?.payload.kind === 'systemEvent' ? job.payload.text : ''
  );
  const [payloadMessage, setPayloadMessage] = useState(
    job?.payload.kind === 'agentTurn' ? job.payload.message : ''
  );

  // Config
  const [sessionTarget, setSessionTarget] = useState<CronSessionTarget>(
    job?.sessionTarget || 'main'
  );
  const [wakeMode, setWakeMode] = useState<CronWakeMode>(job?.wakeMode || 'now');
  const [deleteAfterRun, setDeleteAfterRun] = useState(job?.deleteAfterRun || false);
  const [selectedAgentId, setSelectedAgentId] = useState(job?.agentId || agentId || '');

  // Initialize schedule state from existing job
  useEffect(() => {
    if (job) {
      const schedule = job.schedule;
      if (schedule.kind === 'at') {
        const date = new Date(schedule.atMs);
        setAtDate(date.toISOString().split('T')[0]);
        setAtTime(date.toTimeString().slice(0, 5));
      } else if (schedule.kind === 'every') {
        const ms = schedule.everyMs;
        if (ms % (24 * 60 * 60 * 1000) === 0) {
          setEveryValue(String(ms / (24 * 60 * 60 * 1000)));
          setEveryUnit('days');
        } else if (ms % (60 * 60 * 1000) === 0) {
          setEveryValue(String(ms / (60 * 60 * 1000)));
          setEveryUnit('hours');
        } else {
          setEveryValue(String(ms / (60 * 1000)));
          setEveryUnit('minutes');
        }
      } else if (schedule.kind === 'cron') {
        setCronExpr(schedule.expr);
        setCronTz(schedule.tz || '');
      }
    }
  }, [job]);

  const buildSchedule = (): CronSchedule => {
    switch (scheduleKind) {
      case 'at': {
        const dateTime = new Date(`${atDate}T${atTime}`);
        return { kind: 'at', atMs: dateTime.getTime() };
      }
      case 'every': {
        const value = parseInt(everyValue, 10) || 1;
        let ms: number;
        switch (everyUnit) {
          case 'minutes':
            ms = value * 60 * 1000;
            break;
          case 'hours':
            ms = value * 60 * 60 * 1000;
            break;
          case 'days':
            ms = value * 24 * 60 * 60 * 1000;
            break;
        }
        return { kind: 'every', everyMs: ms };
      }
      case 'cron':
        return {
          kind: 'cron',
          expr: cronExpr,
          ...(cronTz && { tz: cronTz }),
        };
    }
  };

  const buildPayload = (): CronPayload => {
    if (payloadKind === 'systemEvent') {
      return { kind: 'systemEvent', text: payloadText };
    }
    return { kind: 'agentTurn', message: payloadMessage };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const cronJob: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> = {
      name,
      description: description || undefined,
      enabled,
      schedule: buildSchedule(),
      payload: buildPayload(),
      sessionTarget,
      wakeMode,
      deleteAfterRun: deleteAfterRun || undefined,
      agentId: selectedAgentId || undefined,
    };

    await onSave(cronJob);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onCancel}
      />
      <Card className="relative z-10 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-primary" />
            {isEditing ? 'Edit Periodic Task' : 'Create Periodic Task'}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Basic Info */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name *</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Daily Report, Hourly Check..."
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description..."
                />
              </div>
            </div>

            {/* Schedule */}
            <div className="space-y-4">
              <label className="block text-sm font-medium">Schedule *</label>
              <div className="flex gap-2">
                {(['at', 'every', 'cron'] as const).map((kind) => (
                  <Button
                    key={kind}
                    type="button"
                    variant={scheduleKind === kind ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setScheduleKind(kind)}
                    className="flex items-center gap-1.5"
                  >
                    {kind === 'at' && <Calendar className="h-3.5 w-3.5" />}
                    {kind === 'every' && <Repeat className="h-3.5 w-3.5" />}
                    {kind === 'cron' && <CalendarClock className="h-3.5 w-3.5" />}
                    {kind === 'at' ? 'One-time' : kind === 'every' ? 'Interval' : 'Cron'}
                  </Button>
                ))}
              </div>

              {scheduleKind === 'at' && (
                <div className="flex gap-2">
                  <Input
                    type="date"
                    value={atDate}
                    onChange={(e) => setAtDate(e.target.value)}
                    className="flex-1"
                    required
                  />
                  <Input
                    type="time"
                    value={atTime}
                    onChange={(e) => setAtTime(e.target.value)}
                    className="w-32"
                    required
                  />
                </div>
              )}

              {scheduleKind === 'every' && (
                <div className="flex gap-2 items-center">
                  <span className="text-sm text-muted-foreground">Every</span>
                  <Input
                    type="number"
                    min="1"
                    value={everyValue}
                    onChange={(e) => setEveryValue(e.target.value)}
                    className="w-20"
                    required
                  />
                  <select
                    value={everyUnit}
                    onChange={(e) => setEveryUnit(e.target.value as typeof everyUnit)}
                    className="px-3 py-2 bg-background border rounded-md text-sm"
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              )}

              {scheduleKind === 'cron' && (
                <div className="space-y-2">
                  <Input
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder="0 9 * * *"
                    required
                  />
                  <Input
                    value={cronTz}
                    onChange={(e) => setCronTz(e.target.value)}
                    placeholder="Timezone (e.g., America/New_York)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Format: minute hour day-of-month month day-of-week
                  </p>
                </div>
              )}
            </div>

            {/* Payload */}
            <div className="space-y-4">
              <label className="block text-sm font-medium">Payload *</label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={payloadKind === 'agentTurn' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPayloadKind('agentTurn')}
                >
                  Agent Turn
                </Button>
                <Button
                  type="button"
                  variant={payloadKind === 'systemEvent' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPayloadKind('systemEvent')}
                >
                  System Event
                </Button>
              </div>

              {payloadKind === 'agentTurn' ? (
                <textarea
                  value={payloadMessage}
                  onChange={(e) => setPayloadMessage(e.target.value)}
                  placeholder="Message for the agent to process..."
                  className="w-full px-3 py-2 bg-background border rounded-md text-sm min-h-[100px] resize-y"
                  required
                />
              ) : (
                <textarea
                  value={payloadText}
                  onChange={(e) => setPayloadText(e.target.value)}
                  placeholder="System event text..."
                  className="w-full px-3 py-2 bg-background border rounded-md text-sm min-h-[100px] resize-y"
                  required
                />
              )}
            </div>

            {/* Configuration */}
            <div className="space-y-4">
              <label className="block text-sm font-medium">Configuration</label>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Session Target</label>
                  <select
                    value={sessionTarget}
                    onChange={(e) => setSessionTarget(e.target.value as CronSessionTarget)}
                    className="w-full px-3 py-2 bg-background border rounded-md text-sm"
                  >
                    <option value="main">Main Session</option>
                    <option value="isolated">Isolated Session</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Wake Mode</label>
                  <select
                    value={wakeMode}
                    onChange={(e) => setWakeMode(e.target.value as CronWakeMode)}
                    className="w-full px-3 py-2 bg-background border rounded-md text-sm"
                  >
                    <option value="now">Run Now</option>
                    <option value="next-heartbeat">Next Heartbeat</option>
                  </select>
                </div>
              </div>

              {!agentId && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Agent ID (optional)</label>
                  <Input
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    placeholder="Leave empty for global job"
                  />
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="deleteAfterRun"
                  checked={deleteAfterRun}
                  onChange={(e) => setDeleteAfterRun(e.target.checked)}
                  className="rounded border-muted-foreground"
                />
                <label htmlFor="deleteAfterRun" className="text-sm">
                  Delete after first run (one-time job)
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="enabled"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="rounded border-muted-foreground"
                />
                <label htmlFor="enabled" className="text-sm">
                  Enabled
                </label>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-2" />
                    {isEditing ? 'Save Changes' : 'Create Task'}
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
