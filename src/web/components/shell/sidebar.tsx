import { Link, useRoute } from "wouter";
import { clsx } from "clsx";

type NavItem = { num: string; label: string; path: string };

const NAV: NavItem[] = [
  { num: "01", label: "Rating Queue", path: "/queue" },
  { num: "02", label: "Buckets", path: "/buckets" },
  { num: "03", label: "Analyzer", path: "/analyzer" },
  { num: "04", label: "Console", path: "/console" },
  { num: "05", label: "Sources", path: "/sources" },
  { num: "06", label: "Setup", path: "/setup" },
];

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-line bg-bg-1 flex flex-col">
      <div className="p-4 border-b border-line">
        <div className="cap text-ink-3">Crate Digger</div>
        <div className="text-ink-1 font-medium tracking-tight mt-1">Music Scout</div>
      </div>
      <nav className="flex-1 p-2 flex flex-col gap-1">
        {NAV.map((item) => (
          <NavLink key={item.path} item={item} />
        ))}
      </nav>
      <HealthStrip />
    </aside>
  );
}

function NavLink({ item }: { item: NavItem }) {
  const [active] = useRoute(item.path);
  const [activeRoot] = useRoute("/");
  const isActive = active || (item.path === "/queue" && activeRoot);
  return (
    <Link
      href={item.path}
      className={clsx(
        "flex items-center gap-3 px-3 py-2 rounded-2 text-sm transition-colors",
        isActive
          ? "bg-bg-3 text-ink-1 border border-line-strong"
          : "text-ink-2 hover:bg-bg-2 hover:text-ink-1 border border-transparent",
      )}
    >
      <span className="font-mono text-[11px] text-ink-3 tabular-nums w-6">{item.num}</span>
      <span>{item.label}</span>
    </Link>
  );
}

function HealthStrip() {
  return (
    <div className="border-t border-line p-3 text-[11px] text-ink-3 font-mono">
      <div className="flex items-center gap-2">
        <span className="led on" />
        <span>agent idle</span>
      </div>
      <div className="mt-1 text-ink-4">last ingest: —</div>
    </div>
  );
}
