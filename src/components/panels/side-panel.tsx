"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/ui/glyphs";

/**
 * The right-side drawer (a bottom sheet below 900px). Focus moves to the heading when it opens; Esc or
 * the close button closes it and the opener gives focus back to the element that opened the panel.
 */
export function SidePanel({ title, kicker, tone, onClose, children, className }: { title: string; kicker?: string; tone?: string; onClose: () => void; children: ReactNode; className?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="side-panel-title"
      className={cn(
        "drawer fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] min-[900px]:inset-y-0 min-[900px]:left-auto min-[900px]:right-0 min-[900px]:max-h-none min-[900px]:w-[400px]",
        className,
      )}
      onKeyDown={onKey}
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          {kicker && <p className={cn("label", tone ?? "text-dim")}>{kicker}</p>}
          <h2 id="side-panel-title" ref={heading} tabIndex={-1} className="font-mono text-[15px] font-semibold tracking-wide text-foreground outline-none focus-visible:underline">
            {title}
          </h2>
        </div>
        <button type="button" className="btn flex items-center gap-1" onClick={onClose} aria-label="Close panel">
          <Glyph name="cross" size={10} /> Esc
        </button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px]">{children}</div>
    </aside>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center justify-between border-b border-border pb-1">
        <h3 className="hud-title">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, value, mono, children }: { label: string; value?: string | number | null; mono?: boolean; children?: ReactNode }) {
  const shown = children ?? (value === null || value === undefined || value === "" ? <span className="text-faint">—</span> : String(value));
  return (
    <>
      <dt>{label}</dt>
      <dd className={cn(mono && "font-mono text-[11px]")}>{shown}</dd>
    </>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  return <dl className="field-grid">{children}</dl>;
}

export function SourceLine({ source }: { source: string }) {
  return (
    <p className="mt-1 label text-faint" title="Which API field this comes from">
      source · <span className="normal-case tracking-normal">{source}</span>
    </p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-faint">{children}</p>;
}
