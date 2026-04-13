import type { CronSchedule } from '../types/openclaw';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function humanizeDayList(field: string): string {
  if (field === '*') return '';
  if (/^\d+-\d+$/.test(field)) {
    const [a, b] = field.split('-').map((n) => parseInt(n, 10));
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo === 1 && hi === 5) return 'weekdays';
    if ((lo === 0 && hi === 6) || (lo === 1 && hi === 7)) return 'every day';
    return `${DAY_NAMES[lo % 7]}–${DAY_NAMES[hi % 7]}`;
  }
  const parts = field.split(',').map((n) => parseInt(n, 10));
  if (parts.every((n) => !Number.isNaN(n))) {
    return parts.map((n) => DAY_NAMES[n % 7]).join(', ');
  }
  return '';
}

/**
 * Humanize a classic 5-field cron expression (min hour dom month dow).
 * Covers the common patterns; falls back to showing the raw string.
 */
function humanizeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'every minute';
  }
  const stepMatch = min.match(/^\*\/(\d+)$/);
  if (stepMatch && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `every ${stepMatch[1]} minutes`;
  }
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    if (min === '0') return 'hourly';
    if (/^\d+$/.test(min)) return `hourly at :${pad2(parseInt(min, 10))}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const timeStr = `${pad2(parseInt(hour, 10))}:${pad2(parseInt(min, 10))}`;
    if (dom === '*' && mon === '*' && dow === '*') {
      return `daily at ${timeStr}`;
    }
    if (dom === '*' && mon === '*' && dow !== '*') {
      const dayPart = humanizeDayList(dow);
      if (dayPart) return `${dayPart} at ${timeStr}`;
    }
    if (/^\d+$/.test(dom) && mon === '*' && dow === '*') {
      const domN = parseInt(dom, 10);
      const suffix = domN === 1 ? 'st' : domN === 2 ? 'nd' : domN === 3 ? 'rd' : 'th';
      return `monthly on ${domN}${suffix} at ${timeStr}`;
    }
    if (/^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*') {
      const monN = parseInt(mon, 10);
      return `yearly on ${MONTH_NAMES[monN] || mon} ${dom} at ${timeStr}`;
    }
  }
  return `cron: ${expr}`;
}

function humanizeInterval(ms: number): string {
  if (ms < 1000) return `every ${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `every ${sec}s`;
  const min = Math.floor(sec / 60);
  const secRem = sec % 60;
  if (min < 60) return secRem ? `every ${min}m ${secRem}s` : `every ${min}m`;
  const hr = Math.floor(min / 60);
  const minRem = min % 60;
  if (hr < 24) return minRem ? `every ${hr}h ${minRem}m` : `every ${hr}h`;
  const d = Math.floor(hr / 24);
  const hrRem = hr % 24;
  return hrRem ? `every ${d}d ${hrRem}h` : `every ${d}d`;
}

function humanizeOnce(atMs: number): string {
  const date = new Date(atMs);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeStr = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay) return `once today at ${timeStr}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate();
  if (isTomorrow) return `once tomorrow at ${timeStr}`;
  return `once at ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

export function humanizeSchedule(sch: CronSchedule): string {
  if (sch.kind === 'every') return humanizeInterval(sch.everyMs);
  if (sch.kind === 'at')    return humanizeOnce(sch.atMs);
  if (sch.kind === 'cron')  return humanizeCronExpr(sch.expr) + (sch.tz ? ` (${sch.tz})` : '');
  return JSON.stringify(sch);
}
