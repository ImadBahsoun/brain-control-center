import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { NavTabs } from "@/components/shell/nav-tabs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brain Control Center",
  description: "Read-only local command center over the Brain task store, governor policy and brain-gate state.",
};

// width and initialScale are written explicitly so Next's defaults for them are not lost by setting
// viewportFit alone; userScalable and maximumScale are left unset (pinch-to-zoom the page stays available).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground">
        <header id="app-header" className="relative h-11 border-b border-border bg-card/90">
          <div className="flex h-full items-center gap-4 px-4">
            <Link href="/" className="label-md whitespace-nowrap font-semibold text-foreground hover:no-underline" style={{ letterSpacing: "0.22em" }}>
              Brain Control Center
            </Link>
            {/* the hiding utility sits on this plain wrapper, not on .chip itself: .chip is unlayered CSS
                and in Tailwind 4 unlayered rules beat `@layer utilities`, so `max-sm:hidden` directly on
                a `.chip`/`.btn` element would lose to its `display: inline-flex` */}
            <span className="max-sm:hidden">
              <span className="chip chip-dim">read-only</span>
            </span>
            <NavTabs />
            <span className="ml-auto label num text-faint max-lg:hidden">127.0.0.1:3077</span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
