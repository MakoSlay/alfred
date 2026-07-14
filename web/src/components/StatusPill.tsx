import type { ReactNode } from "react";

export type StatusTone = "good" | "warn" | "bad" | "info" | "quiet";

export function StatusPill({ children, tone = "quiet" }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`status-pill status-pill--${tone}`}><span className="status-pill__dot" />{children}</span>;
}
