import * as React from 'react';
import { cn } from '../../lib/utils';

interface TooltipContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

interface TooltipProviderProps {
  children: React.ReactNode;
  delayDuration?: number;
}

function TooltipProvider({ children }: TooltipProviderProps) {
  return <>{children}</>;
}

interface TooltipProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
}

function Tooltip({ children, open: controlledOpen, onOpenChange, delayDuration = 200 }: TooltipProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = React.useCallback((newOpen: boolean) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (newOpen) {
      timeoutRef.current = setTimeout(() => {
        if (isControlled) {
          onOpenChange?.(true);
        } else {
          setInternalOpen(true);
        }
      }, delayDuration);
    } else {
      if (isControlled) {
        onOpenChange?.(false);
      } else {
        setInternalOpen(false);
      }
    }
  }, [isControlled, onOpenChange, delayDuration]);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <TooltipContext.Provider value={{ open, setOpen }}>
      <div className="relative inline-flex">
        {children}
      </div>
    </TooltipContext.Provider>
  );
}

function useTooltip() {
  const context = React.useContext(TooltipContext);
  if (!context) {
    throw new Error('Tooltip components must be used within a Tooltip');
  }
  return context;
}

interface TooltipTriggerProps extends React.HTMLAttributes<HTMLDivElement> {
  asChild?: boolean;
}

const TooltipTrigger = React.forwardRef<HTMLDivElement, TooltipTriggerProps>(
  ({ children, asChild, ...props }, ref) => {
    const { setOpen } = useTooltip();

    return (
      <div
        ref={ref}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
TooltipTrigger.displayName = 'TooltipTrigger';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: TooltipSide;
  sideOffset?: number;
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, side = 'top', sideOffset = 4, children, ...props }, ref) => {
    const { open } = useTooltip();

    if (!open) return null;

    const sideStyles: Record<TooltipSide, string> = {
      top: `bottom-full left-1/2 -translate-x-1/2 mb-${sideOffset}`,
      right: `left-full top-1/2 -translate-y-1/2 ml-${sideOffset}`,
      bottom: `top-full left-1/2 -translate-x-1/2 mt-${sideOffset}`,
      left: `right-full top-1/2 -translate-y-1/2 mr-${sideOffset}`,
    };

    return (
      <div
        ref={ref}
        role="tooltip"
        className={cn(
          'absolute z-50 overflow-hidden rounded-md px-3 py-1.5',
          'bg-popover text-xs text-foreground shadow-elevation-2',
          'border border-border',
          'animate-in fade-in-0 zoom-in-95 duration-100',
          sideStyles[side],
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
