import * as React from 'react';
import { cn } from '../../lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'circular' | 'text';
}

const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const variants = {
      default: 'rounded-md',
      circular: 'rounded-full',
      text: 'rounded h-4',
    };

    return (
      <div
        ref={ref}
        className={cn(
          'animate-pulse bg-muted',
          variants[variant],
          className
        )}
        {...props}
      />
    );
  }
);
Skeleton.displayName = 'Skeleton';

// Compound variants for common use cases
const SkeletonCard = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-lg border border-border p-4 space-y-3', className)}
      {...props}
    >
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-8 rounded-full" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  )
);
SkeletonCard.displayName = 'SkeletonCard';

const SkeletonAvatar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { size?: 'sm' | 'md' | 'lg' }>(
  ({ className, size = 'md', ...props }, ref) => {
    const sizes = {
      sm: 'h-8 w-8',
      md: 'h-10 w-10',
      lg: 'h-12 w-12',
    };

    return (
      <Skeleton
        ref={ref}
        variant="circular"
        className={cn(sizes[size], className)}
        {...props}
      />
    );
  }
);
SkeletonAvatar.displayName = 'SkeletonAvatar';

const SkeletonText = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { lines?: number }>(
  ({ className, lines = 3, ...props }, ref) => (
    <div ref={ref} className={cn('space-y-2', className)} {...props}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          variant="text"
          className={cn(
            i === lines - 1 ? 'w-2/3' : 'w-full'
          )}
        />
      ))}
    </div>
  )
);
SkeletonText.displayName = 'SkeletonText';

const SkeletonButton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <Skeleton ref={ref} className={cn('h-10 w-24 rounded-lg', className)} {...props} />
  )
);
SkeletonButton.displayName = 'SkeletonButton';

export { Skeleton, SkeletonCard, SkeletonAvatar, SkeletonText, SkeletonButton };
