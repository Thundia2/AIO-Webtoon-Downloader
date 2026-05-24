// ============================================================
// SHADCN-STYLE UI PRIMITIVES
//
// These are custom components styled with Tailwind that look
// like polished desktop UI controls. Each one accepts className
// so you can add extra styles where needed.
// ============================================================

import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";

// ── Button ──
// Variants: default (blue), secondary (gray), destructive (red), ghost (transparent)
export const Button = forwardRef(
  ({ className, variant = "default", size = "default", children, ...props }, ref) => {
    const variants = {
      default:
        "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
      secondary:
        "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      destructive:
        "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      ghost:
        "hover:bg-accent hover:text-accent-foreground",
      outline:
        "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
    };
    const sizes = {
      default: "h-9 px-4 py-2 text-sm",
      sm: "h-8 px-3 text-xs",
      lg: "h-10 px-6 text-base",
      icon: "h-9 w-9",
    };

    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

// ── Input (text field) ──
export const Input = forwardRef(({ className, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1",
        "text-sm shadow-sm transition-colors placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";

// ── Textarea ──
export const Textarea = forwardRef(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2",
        "text-sm shadow-sm placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

// ── Label ──
export const Label = forwardRef(({ className, ...props }, ref) => {
  return (
    <label
      ref={ref}
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    />
  );
});
Label.displayName = "Label";

// ── Toggle switch (like a light switch) ──
export function Switch({ checked, onCheckedChange, disabled, className, id }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full",
        "border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}

// ── Slider (range input) ──
export function Slider({ value, onValueChange, min = 0, max = 100, step = 1, className, disabled }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange?.(Number(e.target.value))}
      className={cn(
        "w-full h-2 rounded-full appearance-none cursor-pointer",
        "bg-secondary accent-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    />
  );
}

// ── Select dropdown ──
export const Select = forwardRef(({ className, children, ...props }, ref) => {
  return (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1",
        "text-sm shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
});
Select.displayName = "Select";

// ── Checkbox ──
export function Checkbox({ checked, onCheckedChange, disabled, id, className }) {
  return (
    <button
      type="button"
      id={id}
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded border border-primary shadow-sm",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "flex items-center justify-center",
        checked ? "bg-primary text-primary-foreground" : "bg-background",
        className
      )}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M1.5 5.5L3.5 7.5L8.5 2.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

// ── Card (container) ──
export function Card({ className, children, ...props }) {
  return (
    <div
      className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)}
      {...props}
    >
      {children}
    </div>
  );
}

// ── Badge (small label) ──
export function Badge({ className, variant = "default", children }) {
  const variants = {
    default: "bg-primary/10 text-primary border-primary/20",
    secondary: "bg-secondary text-secondary-foreground border-secondary",
    success: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20",
    destructive: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

// ── Section header for form groups ──
export function SectionHeader({ children, className }) {
  return (
    <div className={cn("flex items-center gap-3 pt-4 pb-2", className)}>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

// ── Collapsible section ──
export function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div className="border rounded-md">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium hover:bg-accent/50 transition-colors rounded-md"
      >
        <span>{title}</span>
        <svg
          className={cn("w-4 h-4 transition-transform", open && "rotate-180")}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t">{children}</div>}
    </div>
  );
}
