import { Bell, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';

interface HeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function Header({ title, description, actions }: HeaderProps) {
  const { loadAll, agentsLoading, sessionsLoading, cronLoading } = useDashboardStore();
  const isLoading = agentsLoading || sessionsLoading || cronLoading;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="flex items-center gap-4">
        {actions}

        <Button
          variant="ghost"
          size="icon"
          onClick={() => loadAll()}
          disabled={isLoading}
        >
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
        </Button>

        <Button variant="ghost" size="icon">
          <Bell className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
