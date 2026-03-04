import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 11)}`;
}

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return 'Never';
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

export function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function getSessionDisplayName(session: { key: string; label?: string; displayName?: string; derivedTitle?: string }): string {
  // Use explicit names first
  if (session.displayName) return session.displayName;
  if (session.label) return session.label;
  if (session.derivedTitle) return session.derivedTitle;

  // Parse the key to extract a nicer name
  const key = session.key;

  // Format: agent:{agentId}:{sessionName}
  const agentSessionMatch = key.match(/^agent:[^:]+:([^:]+)$/);
  if (agentSessionMatch) {
    return agentSessionMatch[1];
  }

  // Format: agent:{agentId}:subagent:{uuid}
  const subagentMatch = key.match(/^agent:[^:]+:subagent:([^:]+)$/);
  if (subagentMatch) {
    return `subagent-${subagentMatch[1].slice(0, 8)}`;
  }

  // Format: webchat:g-agent-{agentId}-{sessionName}
  const webchatMatch = key.match(/^webchat:g-agent-[^-]+-(.+)$/);
  if (webchatMatch) {
    return webchatMatch[1];
  }

  // Format: dm-{agentId}
  const dmMatch = key.match(/^dm-(.+)$/);
  if (dmMatch) {
    return `DM: ${dmMatch[1]}`;
  }

  // Fallback: return the key
  return key;
}

export function getAgentDisplayName(agent: { id: string; name?: string; identity?: { name?: string } }): string {
  return agent.identity?.name || agent.name || agent.id;
}

export function parseCronExpression(schedule: { kind: string; expr?: string; everyMs?: number; atMs?: number }): string {
  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.expr;
  }
  if (schedule.kind === 'every' && schedule.everyMs) {
    return `Every ${formatDuration(schedule.everyMs)}`;
  }
  if (schedule.kind === 'at' && schedule.atMs) {
    return `At ${new Date(schedule.atMs).toLocaleString()}`;
  }
  return 'Unknown';
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'connected':
    case 'ok':
      return 'text-green-500';
    case 'pending':
    case 'waiting':
      return 'text-yellow-500';
    case 'error':
    case 'failed':
    case 'aborted':
      return 'text-red-500';
    case 'completed':
    case 'done':
      return 'text-blue-500';
    default:
      return 'text-muted-foreground';
  }
}

export function getStatusBgColor(status: string): string {
  switch (status) {
    case 'running':
    case 'connected':
    case 'ok':
      return 'bg-green-500/10 text-green-500';
    case 'pending':
    case 'waiting':
      return 'bg-yellow-500/10 text-yellow-500';
    case 'error':
    case 'failed':
    case 'aborted':
      return 'bg-red-500/10 text-red-500';
    case 'completed':
    case 'done':
      return 'bg-blue-500/10 text-blue-500';
    default:
      return 'bg-muted text-muted-foreground';
  }
}
