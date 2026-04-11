import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useDashboardStore } from '../../store/dashboard-store';
import { useTranslation } from '../../i18n';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '../../lib/utils';
import {
  Settings,
  ExternalLink,
  LogOut,
  User,
} from 'lucide-react';

export function ProfileMenu() {
  const { user } = useAuth();
  const { connected, disconnect, gatewayUrl, token } = useDashboardStore();
  const { signOut } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const firstName = user?.displayName?.split(' ')[0] || user?.email?.split('@')[0] || 'User';

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors",
          open ? "bg-sidebar-hover" : "hover:bg-sidebar-hover"
        )}
      >
        {user?.photoURL ? (
          <img
            src={user.photoURL}
            alt=""
            className="w-6 h-6 rounded-full object-cover shrink-0"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
            <span className="text-[10px] font-semibold text-primary">
              {firstName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <span className="text-xs font-medium text-sidebar-fg/80 truncate flex-1 text-left">{firstName}</span>
        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", connected ? "bg-green-500" : "bg-gray-400")} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 py-1 bg-popover border border-border rounded-lg shadow-lg z-50">
          <button
            onClick={() => { navigate('/account'); setOpen(false); }}
            className={cn(
              "w-full px-3 py-2 text-xs text-left flex items-center gap-2.5 hover:bg-accent transition-colors",
              location.pathname === '/account' && "bg-accent font-medium"
            )}
          >
            <User className="w-3.5 h-3.5 text-muted-foreground" />
            <span>My account</span>
          </button>
          <button
            onClick={() => { navigate('/settings'); setOpen(false); }}
            className={cn(
              "w-full px-3 py-2 text-xs text-left flex items-center gap-2.5 hover:bg-accent transition-colors",
              location.pathname.startsWith('/settings') && "bg-accent font-medium"
            )}
          >
            <Settings className="w-3.5 h-3.5 text-muted-foreground" />
            <span>{t('nav.settings')}</span>
          </button>
          {connected && (
            <button
              onClick={() => {
                const isLocal = gatewayUrl.includes('localhost') || gatewayUrl.includes('127.0.0.1');
                const isHttps = window.location.protocol === 'https:';
                const suffix = token ? `#token=${encodeURIComponent(token)}` : '';
                if (isLocal && isHttps) {
                  window.open(`${window.location.origin}/openclaw/${suffix}`, '_blank');
                } else {
                  let httpUrl = gatewayUrl.replace(/^wss?:\/\//, 'http://');
                  if (!httpUrl.startsWith('http')) httpUrl = `http://${httpUrl}`;
                  window.open(`${httpUrl}/openclaw/${suffix}`, '_blank');
                }
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-xs text-left flex items-center gap-2.5 hover:bg-accent transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              <span>OpenClaw UI</span>
            </button>
          )}
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => { disconnect(); signOut(); setOpen(false); }}
            className="w-full px-3 py-2 text-xs text-left flex items-center gap-2.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
