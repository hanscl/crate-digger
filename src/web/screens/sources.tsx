import { useState } from "react";
import { trpc } from "../trpc";
import type { RouterOutputs } from "../types";
import { SourcePill } from "../components/primitives/source-pill";

type SourceListItem = RouterOutputs["sources"]["list"]["adapters"][number];
type EnrichmentItem = RouterOutputs["sources"]["list"]["enrichment"][number];
type ToggleMutation = ReturnType<typeof trpc.sources.toggle.useMutation>;

/**
 * Sources screen — list of registered adapters with their availability +
 * enabled state, and a `testFetch` for verifying credentials.
 */
export function SourcesScreen() {
  const utils = trpc.useUtils();
  const list = trpc.sources.list.useQuery();
  const toggle = trpc.sources.toggle.useMutation({
    onSuccess: () => void utils.sources.list.invalidate(),
  });

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="font-mono text-ink-3 text-sm tabular-nums">05</span>
        <h1 className="text-ink-1">Sources</h1>
      </div>
      <div className="text-ink-3 text-sm mb-6">
        Adapters behind the common <code className="mono">SourceAdapter</code> interface (Constraint
        #1). Paid sources stay disabled when their key isn't configured. Toggling here flips{" "}
        <code className="mono">app_config.sources_enabled</code>.
      </div>

      <div className="grid grid-cols-2 gap-4">
        {(list.data?.adapters ?? []).map((s) => (
          <AdapterCard key={s.id} adapter={s} toggle={toggle} />
        ))}
      </div>

      {(list.data?.enrichment ?? []).length > 0 ? (
        <>
          <div className="cap text-ink-3 mt-8 mb-3">enrichment</div>
          <div className="text-ink-3 text-sm mb-4">
            Providers that enrich resolved tracks rather than pull candidates. Toggling here flips{" "}
            <code className="mono">app_config.sources_enabled</code> too.
          </div>
          <div className="grid grid-cols-2 gap-4">
            {(list.data?.enrichment ?? []).map((e) => (
              <EnrichmentCard key={e.id} item={e} toggle={toggle} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function EnrichmentCard({ item, toggle }: { item: EnrichmentItem; toggle: ToggleMutation }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-ink-1">{item.label}</span>
        <label className="ml-auto text-xs flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ id: item.id, enabled: e.target.checked })}
          />
          <span className="text-ink-2">enabled</span>
        </label>
      </div>
      <div className="text-ink-3 text-xs">{item.description}</div>
    </div>
  );
}

function AdapterCard({ adapter, toggle }: { adapter: SourceListItem; toggle: ToggleMutation }) {
  // Test-query state is per-card so typing in one adapter doesn't mirror
  // into the others.
  const [testQuery, setTestQuery] = useState("");
  const testFetch = trpc.sources.testFetch.useMutation();

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-3 mb-3">
        <SourcePill source={adapter.id} available={adapter.isAvailable} enabled={adapter.enabled} />
        {adapter.isPaid ? <span className="chip">paid</span> : null}
        <label className="ml-auto text-xs flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={adapter.enabled}
            disabled={!adapter.isAvailable || toggle.isPending}
            onChange={(e) => toggle.mutate({ id: adapter.id, enabled: e.target.checked })}
          />
          <span className="text-ink-2">enabled</span>
        </label>
      </div>
      <div className="text-ink-3 text-xs">
        {adapter.isAvailable
          ? "Credentials present. Daily pipeline will pull from this adapter when enabled."
          : "Credentials missing — set the relevant env keys in `.env` and restart."}
      </div>
      <div className="hr" />
      <div className="flex gap-2">
        <input
          value={testQuery}
          onChange={(e) => setTestQuery(e.target.value)}
          placeholder="optional search query"
          className="flex-1 bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-xs mono text-ink-1"
        />
        <button
          type="button"
          className="btn sm"
          disabled={!adapter.isAvailable || testFetch.isPending}
          onClick={() =>
            testFetch.mutate({
              id: adapter.id,
              mode: testQuery ? "search" : "trending",
              query: testQuery || undefined,
              limit: 10,
            })
          }
        >
          test fetch
        </button>
      </div>
      {testFetch.data ? (
        <div className="mt-3 text-xs">
          {testFetch.data.ok ? (
            <div>
              <div className="text-keep mono">pulled {testFetch.data.count} candidates</div>
              <ul className="mt-1 list-disc list-inside text-ink-3">
                {(testFetch.data.sample ?? []).map((c, i) => (
                  <li key={i} className="truncate">
                    {c.title} — {c.artist}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-pass mono">{testFetch.data.error}</div>
          )}
        </div>
      ) : testFetch.error ? (
        // The router rethrows after finalizing the audit row when the adapter
        // throws (network timeout, upstream 5xx). Without this branch the card
        // would just go blank and the operator wouldn't know why.
        <div className="mt-3 text-xs text-pass mono">{testFetch.error.message}</div>
      ) : null}
    </div>
  );
}
