import type { ReactNode } from "react";

export function ScreenShell({
  num,
  title,
  subtitle,
  children,
}: {
  num: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-2">
        <span className="font-mono text-ink-3 text-sm tabular-nums">{num}</span>
        <h1 className="text-ink-1">{title}</h1>
      </div>
      {subtitle ? <div className="text-ink-3 text-sm mb-6">{subtitle}</div> : null}
      <div className="panel p-6 text-ink-3 text-sm">
        {children ?? <span>Coming online in a later phase.</span>}
      </div>
    </div>
  );
}
