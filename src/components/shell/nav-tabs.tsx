"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "Command map" },
  { href: "/office", label: "Office" },
  { href: "/missions", label: "Missions" },
  { href: "/findings", label: "Findings" },
  { href: "/events", label: "Events" },
  { href: "/approvals", label: "Approvals" },
  { href: "/tokens", label: "Tokens" },
] as const;

export function NavTabs() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const isCurrent = (href: (typeof TABS)[number]["href"]) => (href === "/" ? pathname === "/" || pathname.startsWith("/tasks") : pathname.startsWith(href));

  // the menu closes whenever the route changes (a link inside it was followed)
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <nav aria-label="Views" className="flex items-center gap-0.5 max-lg:hidden">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={isCurrent(t.href) ? "page" : undefined}
            className={cn("label-md border-b-2 px-3 py-3 hover:no-underline", isCurrent(t.href) ? "border-signal text-foreground" : "border-transparent text-dim hover:text-foreground")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <button
        type="button"
        ref={menuButtonRef}
        className="btn ml-auto min-h-11 min-w-11 lg:hidden"
        aria-expanded={open}
        aria-controls="nav-menu"
        onClick={() => setOpen((v) => !v)}
      >
        Menu
      </button>
      <nav id="nav-menu" aria-label="Views" hidden={!open} className="absolute inset-x-0 top-full z-50 border-b border-border bg-card lg:hidden">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={isCurrent(t.href) ? "page" : undefined}
            className={cn("label-md flex min-h-11 items-center px-4", isCurrent(t.href) ? "text-foreground" : "text-dim")}
            onClick={() => setOpen(false)}
          >
            {t.label}
          </Link>
        ))}
        <div className="flex min-h-11 items-center gap-3 px-4">
          <span className="chip chip-dim">read-only</span>
          <span className="label num text-faint">127.0.0.1:3077</span>
        </div>
      </nav>
    </>
  );
}
