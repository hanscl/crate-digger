import { useState, type FormEvent } from "react";

/**
 * Single-user login. Posts the passphrase to `/api/auth/login`; the server
 * sets a signed httpOnly cookie that downstream tRPC requests carry. We do
 * not surface a "wrong passphrase" message vs. "account locked" — single-user
 * system, the only failure is "wrong passphrase".
 */
export function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        setError("Passphrase rejected.");
        return;
      }
      onAuthed();
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-bg-0 text-ink-1">
      <form onSubmit={submit} className="panel p-8 w-full max-w-sm">
        <div className="cap text-ink-3 mb-2">Crate Digger</div>
        <h1 className="mb-1">Music Scout</h1>
        <div className="text-ink-3 text-sm mb-6">
          Enter the admin passphrase from <code className="mono text-ink-2">.env</code>.
        </div>
        <label htmlFor="passphrase" className="cap text-ink-3 block mb-2">
          Passphrase
        </label>
        <input
          id="passphrase"
          type="password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          aria-describedby={error ? "passphrase-error" : undefined}
          className="w-full bg-bg-3 border border-line-strong rounded-2 px-3 py-2 mono text-sm focus:outline-none focus:border-accent"
          placeholder="••••••••"
        />
        {error ? (
          <div id="passphrase-error" className="text-pass text-xs mt-3">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting || passphrase.length === 0}
          className="btn primary mt-6 w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Authenticating…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
