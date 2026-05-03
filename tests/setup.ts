// Disable testcontainers' Ryuk reaper. Ryuk binds an extra port and times out
// on some Docker Desktop / Colima setups; without it the host process is the
// owner of cleanup. Vitest's afterAll hooks call container.stop() which is
// sufficient for our short-lived test containers.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
