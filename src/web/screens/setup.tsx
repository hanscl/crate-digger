import { useRef, useState } from "react";
import { clsx } from "clsx";
import { trpc } from "../trpc";

/**
 * Setup screen — cold-start status + Spotify playlist seeding + taste
 * profile export/import (Constraint #8 round-trip).
 */
export function SetupScreen() {
  const utils = trpc.useUtils();
  const status = trpc.setup.status.useQuery();
  const seed = trpc.setup.seedFromPlaylist.useMutation({
    onSuccess: () => {
      void utils.setup.status.invalidate();
      void utils.buckets.list.invalidate();
    },
  });
  const seedTracks = trpc.setup.seedFromTrackUrls.useMutation({
    onSuccess: () => {
      void utils.setup.status.invalidate();
      void utils.buckets.list.invalidate();
    },
  });
  const tasteImport = trpc.taste.import.useMutation({
    onSuccess: () => {
      void utils.setup.status.invalidate();
      void utils.buckets.list.invalidate();
      void utils.queue.depth.invalidate();
    },
  });

  const [playlistUrl, setPlaylistUrl] = useState("");
  const [trackUrls, setTrackUrls] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function downloadExport() {
    const data = await utils.taste.export.fetch();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `taste-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function uploadImport(file: File) {
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      tasteImport.mutate({ payload: parsed });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "invalid JSON");
    }
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="font-mono text-ink-3 text-sm tabular-nums">06</span>
        <h1 className="text-ink-1">Setup</h1>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-6 panel p-5">
          <div className="cap text-ink-3 mb-3">configuration health</div>
          {!status.data ? (
            <div className="text-ink-3 text-xs">loading…</div>
          ) : (
            <div className="space-y-1">
              <ConfigRow label="Spotify" ok={status.data.spotifyConfigured} required />
              <ConfigRow label="Last.fm" ok={status.data.lastfmConfigured} required />
              <ConfigRow label="Anthropic" ok={status.data.anthropicConfigured} />
              <ConfigRow label="Viberate" ok={status.data.viberateConfigured} />
              <ConfigRow label="ChartMetric" ok={status.data.chartmetricConfigured} />
              <div className="hr" />
              <div className="grid grid-cols-3 gap-3 text-xs mono">
                <Stat label="tracks" value={status.data.counts.tracks} />
                <Stat label="buckets" value={status.data.counts.buckets} />
                <Stat label="ratings" value={status.data.counts.ratings} />
              </div>
            </div>
          )}
        </div>

        <div className="col-span-6 panel p-5">
          <div className="cap text-ink-3 mb-3">cold-start playlist</div>
          <div className="text-ink-3 text-xs mb-3">
            Paste a Spotify playlist URL. Each track passes through enrichment and bucketing
            (cold-start seeds get the badge in the Buckets screen). Skip this and the system runs
            broad-only until your first keeps form buckets organically.
          </div>
          <div className="flex gap-2">
            <input
              value={playlistUrl}
              onChange={(e) => setPlaylistUrl(e.target.value)}
              placeholder="https://open.spotify.com/playlist/…"
              className="flex-1 bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-xs mono text-ink-1"
            />
            <button
              type="button"
              className="btn primary sm"
              disabled={!playlistUrl || seed.isPending}
              onClick={() => seed.mutate({ url: playlistUrl })}
            >
              {seed.isPending ? "seeding…" : "seed buckets"}
            </button>
          </div>
          {seed.data ? (
            seed.data.ok ? (
              <div className="mt-3 text-xs mono text-keep">
                {seed.data.assignedCount} assigned • {seed.data.spawnedBucketCount} spawned •{" "}
                {seed.data.joinedBucketCount} joined
              </div>
            ) : (
              <div className="mt-3 text-xs mono text-pass">{seed.data.error}</div>
            )
          ) : null}
        </div>

        <div className="col-span-12 panel p-5">
          <div className="cap text-ink-3 mb-3">cold-start: paste track URLs</div>
          <div className="text-ink-3 text-xs mb-3">
            Workaround for the Spotify Dev Mode cliff: <code>/playlists/&#123;id&#125;/tracks</code>{" "}
            returns 403 for user-generated playlists. Paste one Spotify track URL / URI / ID per
            line. In Spotify desktop: open a playlist, ⌘A, right-click → Share → Copy Spotify URIs.
            (Proper fix tracked as LAB-21: user OAuth.)
          </div>
          <textarea
            value={trackUrls}
            onChange={(e) => setTrackUrls(e.target.value)}
            placeholder={
              "https://open.spotify.com/track/…\nspotify:track:…\n4iV5W9uYEdYUVa79Axb7Rh"
            }
            rows={6}
            className="w-full bg-bg-3 border border-line-strong rounded-2 px-2 py-1 text-xs mono text-ink-1"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              className="btn primary sm"
              disabled={!trackUrls.trim() || seedTracks.isPending}
              onClick={() => seedTracks.mutate({ urls: trackUrls })}
            >
              {seedTracks.isPending ? "seeding…" : "seed buckets"}
            </button>
            {seedTracks.data ? (
              seedTracks.data.ok ? (
                <span className="text-xs mono text-keep">
                  {seedTracks.data.assignedCount} assigned • {seedTracks.data.spawnedBucketCount}{" "}
                  spawned • {seedTracks.data.joinedBucketCount} joined
                  {(seedTracks.data.invalidCount ?? 0) > 0
                    ? ` • ${seedTracks.data.invalidCount} unparseable lines skipped`
                    : ""}
                </span>
              ) : (
                <span className="text-xs mono text-pass">{seedTracks.data.error}</span>
              )
            ) : null}
          </div>
        </div>

        <div className="col-span-12 panel p-5">
          <div className="cap text-ink-3 mb-3">taste profile (Constraint #8)</div>
          <div className="text-ink-3 text-xs mb-4">
            Buckets + ratings serialize to portable JSON. Export to back up taste; import on a wiped
            install to restore. Track centroids are recomputed on import — the export is structural,
            not a database dump.
          </div>
          <div className="flex gap-2 items-center">
            <button type="button" className="btn primary sm" onClick={downloadExport}>
              Export taste profile…
            </button>
            <button type="button" className="btn sm" onClick={() => fileInputRef.current?.click()}>
              Import taste profile…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadImport(f);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            {tasteImport.data ? (
              <span className="ml-3 text-xs mono text-keep">
                imported {tasteImport.data.bucketsCreated} buckets • +
                {tasteImport.data.trackInserted} tracks • {tasteImport.data.ratingsInserted} ratings
              </span>
            ) : null}
            {tasteImport.error || importError ? (
              <span className="ml-3 text-xs mono text-pass">
                {tasteImport.error?.message ?? importError}
              </span>
            ) : null}
          </div>
        </div>

        <div className="col-span-12">
          <div className="cap text-ink-3 mb-2">session</div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
              window.location.reload();
            }}
          >
            log out
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigRow({
  label,
  ok,
  required = false,
}: {
  label: string;
  ok: boolean;
  required?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={clsx("led", ok ? "green" : required ? "red" : "amber")} />
      <span className="text-ink-2 flex-1">{label}</span>
      <span className="mono text-xs text-ink-3">
        {ok ? "configured" : required ? "missing (required)" : "missing (optional)"}
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border border-line rounded-2 p-2">
      <div className="cap text-ink-3 mb-1">{label}</div>
      <div className="text-ink-1 tnum">{value}</div>
    </div>
  );
}
