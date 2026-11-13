import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border px-1.5 py-0 font-mono text-[11px] uppercase tracking-[0.08em] leading-5 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-border bg-muted text-foreground",
        outline: "border-border text-muted-foreground",
        success: "border-success/40 bg-success/15 text-success",
        warn: "border-warn/40 bg-warn/15 text-warn",
        error: "border-error/40 bg-error/15 text-error",
        info: "border-info/40 bg-info/15 text-info",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  ACTIVE: "info",
  WAITING: "warn",
  BLOCKED: "error",
  COMPLETE: "success",
  CANCELLED: "outline",
  CORRUPT: "error",
  INCOMPLETE: "warn",
  READY: "success",
  BLOCKER: "error",
  MAJOR: "warn",
  MINOR: "info",
  NIT: "outline",
  OPEN: "warn",
  ACKNOWLEDGED: "warn",
  FIXED: "info",
  REVALIDATED: "success",
  CLOSED: "success",
  DEFERRED: "outline",
  REJECTED: "outline",
  PASS: "success",
  FIX_REQUIRED: "warn",
  SCOPE_CHANGE: "warn",
  ok: "success",
  degraded: "warn",
  unavailable: "error",
  fresh: "success",
  stale: "warn",
  ahead: "error",
  diverged: "error",
  missing: "outline",
  invalid: "error",
  unsafe: "error",
  too_large: "error",
  unknown: "warn",
  torn_tail: "warn",
  corrupt: "error",
  incomplete: "warn",
  pending: "info",
  completed: "success",
  "not-launched": "outline",
  lost: "error",
};

/** A status word as text plus color; never color alone. */
export function StatusBadge({ value, className }: { value: string | null | undefined; className?: string }) {
  const v = value ?? "—";
  return (
    <Badge variant={STATUS_VARIANT[v] ?? "default"} className={className}>
      {v}
    </Badge>
  );
}
