import { useState, useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardStore } from '../../store/dashboard-store';
import useTranslation from '../../i18n';
import { User, Mail, Calendar, CreditCard, Zap, Shield, Clock } from 'lucide-react';

interface UsageData {
  budget: { spent: number; limit: number | null; duration: string; resets_at: string };
  plan: { slug: string | null; status: string; expires_at: string };
  credits: { balance: number };
}

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function AccountPage() {
  const { user } = useAuth();
  const { connected, token } = useDashboardStore();
  const { t } = useTranslation();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!connected || !token) { setLoading(false); return; }
    let cancelled = false;
    fetch('/api/usage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (cancelled) return;
        const data = json?.data || json;
        if (data?.budget) setUsage(data);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connected, token]);

  const plan = usage?.plan;
  const budget = usage?.budget;
  const planLabel = plan?.slug
    ? plan.slug.charAt(0).toUpperCase() + plan.slug.slice(1)
    : null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold text-foreground">Account</h1>
          <p className="text-sm text-muted-foreground">Manage your profile and subscription</p>
        </div>

        {/* Profile Card */}
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="h-20 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent" />
          <div className="px-6 pb-6 -mt-10">
            <div className="flex items-end gap-4">
              {user?.photoURL ? (
                <img
                  src={user.photoURL}
                  alt=""
                  className="w-16 h-16 rounded-full border-4 border-card object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-16 h-16 rounded-full border-4 border-card bg-primary/10 flex items-center justify-center">
                  <User className="w-7 h-7 text-primary" />
                </div>
              )}
              <div className="pb-1">
                <p className="text-lg font-semibold text-foreground leading-tight">
                  {user?.displayName || 'User'}
                </p>
                <p className="text-sm text-muted-foreground">{user?.email || '—'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Account Details */}
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            Account details
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <InfoRow icon={Mail} label="Email" value={user?.email || '—'} />
            <InfoRow icon={User} label="Display name" value={user?.displayName || '—'} />
            <InfoRow icon={Shield} label="Email verified" value={user?.emailVerified ? 'Yes' : 'No'} />
            <InfoRow icon={Calendar} label="Account created" value={formatDate(user?.metadata?.creationTime)} />
            <InfoRow icon={Clock} label="Last sign-in" value={formatDateTime(user?.metadata?.lastSignInTime)} />
          </div>
        </div>

        {/* Subscription */}
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-muted-foreground" />
            Subscription
          </h2>
          {loading ? (
            <div className="py-4 text-sm text-muted-foreground text-center">Loading...</div>
          ) : !usage ? (
            <div className="py-4 text-sm text-muted-foreground text-center">No subscription data available</div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InfoRow icon={Zap} label="Plan" value={planLabel || '—'} highlight />
                <InfoRow icon={Shield} label="Status" value={plan?.status || '—'} />
                <InfoRow icon={Calendar} label="Expires" value={formatDate(plan?.expires_at)} />
                {budget?.duration && <InfoRow icon={Clock} label="Billing cycle" value={budget.duration} />}
              </div>

              {/* Usage bar — only when there's a budget limit */}
              {budget?.limit != null && budget.limit > 0 && (
                <div className="pt-2 border-t space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Current period usage</span>
                    {budget.resets_at && (
                      <span className="text-xs text-muted-foreground">
                        Resets {formatDateTime(budget.resets_at)}
                      </span>
                    )}
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500 bg-primary"
                      style={{ width: `${Math.min((budget.spent / budget.limit) * 100, 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">
                      ${budget.spent.toFixed(2)} <span className="text-muted-foreground font-normal">/ ${budget.limit.toFixed(2)}</span>
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {Math.round((budget.spent / budget.limit) * 100)}% used
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono,
  highlight,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-2 px-3 rounded-lg bg-muted/30">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={`text-sm ${highlight ? 'text-primary font-semibold' : 'text-foreground'} ${mono ? 'font-mono text-xs' : ''} truncate`}>
          {value}
        </p>
      </div>
    </div>
  );
}
