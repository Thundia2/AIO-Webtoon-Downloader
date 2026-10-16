// ============================================================
// OVERLAY PRIMITIVES — Dialog, Sheet, Popover
//
// Owns the three layered surfaces Device Sync needs (approved design spec §4
// and §7, sync-temp/design/approved/spec.md): a centered modal Dialog (Review,
// Remove folders), a right-side Sheet (series detail, target editor, find
// sources) and an anchored Popover (the Re-check / target settings menus).
//
// Contract shared by all three:
//   * Escape closes (onClose). Dialog and Sheet also close on a scrim click and
//     return focus to whatever held it when they opened.
//   * `contained` swaps `fixed` for `absolute`, so the DEV gallery
//     (src/dev/SyncGallery.jsx) can render one inside a framed mock window.
//     The parent must then be `relative` and clip its overflow.
//   * Colours are theme tokens only; motion follows spec §6 and is off under
//     prefers-reduced-motion (motion-reduce: variants).
//
// The older hand-rolled dialogs (ConfirmQuitDialog, SearchTab's modal,
// UpdatesCenter's panel) are deliberately NOT migrated (plan decision 12).
// Sheet's entrance copies UpdatesCenter's two-phase rAF pattern (grep
// animateIn in UpdatesCenter.jsx).
// ============================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// Escape closes the topmost open overlay only: each open overlay pushes itself
// here and the key handler acts only when it is last.
const STACK = [];

function useOverlayLifecycle(open, onClose, panelRef, { restoreFocus = true } = {}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    STACK.push(token);
    const prevFocus = restoreFocus ? document.activeElement : null;
    // Focus the panel itself (tabIndex -1) so Tab starts inside it and screen
    // readers announce the dialog, without stealing a field's autofocus.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key !== "Escape" || STACK[STACK.length - 1] !== token) return;
      e.stopPropagation();
      closeRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = STACK.indexOf(token);
      if (i !== -1) STACK.splice(i, 1);
      if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
        prevFocus.focus({ preventScroll: true });
      }
    };
  }, [open, panelRef, restoreFocus]);
}

/**
 * Centered modal. Sizes from the spec: Review 660 / 720 px, Remove folders
 * 520 px; max height is the frame minus 32 px, the body scrolls.
 * Appears without movement (opacity, 120 ms).
 */
export function Dialog({ open, onClose, title, description, children, footer, width = 520, contained, className, "aria-label": ariaLabel }) {
  const panelRef = useRef(null);
  useOverlayLifecycle(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div className={cn(contained ? "absolute" : "fixed", "inset-0 z-50 flex items-center justify-center p-4")}>
      <div className="absolute inset-0 bg-black/45 animate-in-fade motion-reduce:animate-none" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        style={{ width, maxWidth: "100%" }}
        className={cn(
          "relative flex max-h-[calc(100%-32px)] flex-col rounded-lg border bg-card text-card-foreground shadow-xl outline-none",
          "animate-in-fade motion-reduce:animate-none",
          className
        )}
      >
        {(title || description) && (
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              {title && <h2 className="text-[15px] font-bold leading-tight">{title}</h2>}
              {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
            </div>
            <CloseButton onClick={onClose} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Right-side sheet over a scrim. Widths from the spec: series detail 440/520,
 * target editor 470/560, find sources 600/680 — pass `width`.
 * Slides in over 220 ms cubic-bezier(.2,.7,.2,1); a 2 px primary accent line
 * on top (series detail) is the caller's `accent`.
 */
export function Sheet({ open, onClose, title, description, children, footer, width = 470, contained, accent, className, "aria-label": ariaLabel }) {
  const panelRef = useRef(null);
  const [shown, setShown] = useState(false);
  // Two-phase entrance: mount at translate-x-full, flip after one paint so the
  // transition runs (UpdatesCenter does the same).
  useLayoutEffect(() => {
    if (!open) {
      setShown(false);
      return undefined;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);
  useOverlayLifecycle(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div className={cn(contained ? "absolute" : "fixed", "inset-0 z-50 flex justify-end overflow-hidden")}>
      <div
        className={cn("absolute inset-0 bg-black/35 transition-opacity duration-200 motion-reduce:transition-none", shown ? "opacity-100" : "opacity-0")}
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        style={{ width, maxWidth: "100%", transitionTimingFunction: "cubic-bezier(.2,.7,.2,1)" }}
        className={cn(
          "relative flex h-full flex-col border-l bg-card text-card-foreground shadow-2xl outline-none",
          "transition-transform duration-[220ms] motion-reduce:transition-none",
          shown ? "translate-x-0" : "translate-x-full",
          className
        )}
      >
        {accent && <div className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden="true" />}
        {(title || description) && (
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              {title && <h2 className="text-[15px] font-bold leading-tight">{title}</h2>}
              {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
            </div>
            <CloseButton onClick={onClose} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Anchored, non-modal menu under its trigger. `trigger` is rendered inside a
 * relative wrapper; the panel opens below it, aligned "start" or "end".
 * Closes on Escape and on a mousedown outside the wrapper. Focus is not
 * trapped (spec §4: quick, non-modal).
 */
export function Popover({ open, onClose, trigger, children, align = "end", width = 300, className }) {
  const wrapRef = useRef(null);
  const panelRef = useRef(null);
  useOverlayLifecycle(open, onClose, panelRef, { restoreFocus: false });
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose?.();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);
  return (
    <div ref={wrapRef} className="relative inline-flex">
      {trigger}
      {open && (
        <div
          ref={panelRef}
          role="menu"
          tabIndex={-1}
          style={{ width }}
          className={cn(
            "absolute top-full z-40 mt-1 rounded-lg border bg-card p-1.5 text-card-foreground shadow-lg outline-none",
            "animate-in-fade motion-reduce:animate-none",
            align === "start" ? "left-0" : "right-0",
            className
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function CloseButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
