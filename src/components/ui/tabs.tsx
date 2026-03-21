import * as React from 'react';
import { cn } from '../../lib/utils';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs() {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs components must be used within a Tabs');
  }
  return context;
}

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ value, defaultValue, onValueChange, className, children, ...props }, ref) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue || '');

    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : internalValue;

    const handleValueChange = React.useCallback((newValue: string) => {
      if (!isControlled) {
        setInternalValue(newValue);
      }
      onValueChange?.(newValue);
    }, [isControlled, onValueChange]);

    return (
      <TabsContext.Provider value={{ value: currentValue, onValueChange: handleValueChange }}>
        <div ref={ref} className={cn('w-full', className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    role="tablist"
    className={cn(
      'inline-flex h-10 items-center justify-start gap-1 rounded-xl bg-muted p-1',
      'border border-border',
      className
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, ...props }, ref) => {
    const { value: selectedValue, onValueChange } = useTabs();
    const isSelected = selectedValue === value;

    return (
      <button
        ref={ref}
        role="tab"
        type="button"
        aria-selected={isSelected}
        data-state={isSelected ? 'active' : 'inactive'}
        onClick={() => onValueChange(value)}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-lg px-3 py-1.5',
          'text-sm font-medium ring-offset-background transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50',
          isSelected
            ? 'bg-accent text-accent-foreground shadow-elevation-1'
            : 'text-muted-foreground hover:text-accent-foreground hover:bg-accent',
          className
        )}
        {...props}
      />
    );
  }
);
TabsTrigger.displayName = 'TabsTrigger';

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const { value: selectedValue } = useTabs();

    if (selectedValue !== value) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        data-state={selectedValue === value ? 'active' : 'inactive'}
        className={cn(
          'mt-4 ring-offset-background',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'animate-in fade-in-0 duration-200',
          className
        )}
        {...props}
      />
    );
  }
);
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
