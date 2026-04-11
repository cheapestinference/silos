import { cn } from '../../lib/utils';

export interface NavItemProps {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick: () => void;
  badge?: number;
}

export function NavItem({ icon: Icon, label, active, onClick, badge }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full px-2 py-1 rounded flex items-center gap-2 transition-colors text-xs",
        active
          ? "bg-primary/15 text-primary font-semibold relative before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:rounded-full before:bg-primary"
          : "text-sidebar-fg/80 hover:text-sidebar-fg hover:bg-sidebar-hover"
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="flex-1 text-left truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-semibold rounded-full flex items-center justify-center">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}
