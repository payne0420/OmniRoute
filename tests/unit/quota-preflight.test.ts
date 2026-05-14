import test from "node:test";
import assert from "node:assert/strict";

const quotaPreflight = await import("../../open-sse/services/quotaPreflight.ts");

const {
  registerQuotaFetcher,
  registerQuotaWindows,
  getQuotaWindows,
  isQuotaPreflightEnabled,
  preflightQuota,
} = quotaPreflight;

function createConnection(providerSpecificData = {}) {
  return { providerSpecificData };
}

async function withPatchedConsole(methodName, replacement, fn) {
  const original = console[methodName];
  console[methodName] = replacement;
  try {
    return await fn();
  } finally {
    console[methodName] = original;
  }
}

test("isQuotaPreflightEnabled reads the provider flag strictly (back-compat helper)", () => {
  // The flag itself no longer gates preflightQuota internally — the caller
  // in auth.ts decides whether to invoke it. The helper is still exported
  // so the caller can honor the legacy force-on flag.
  assert.equal(isQuotaPreflightEnabled(createConnection({ quotaPreflightEnabled: true })), true);
  assert.equal(isQuotaPreflightEnabled(createConnection({ quotaPreflightEnabled: "true" })), false);
  assert.equal(isQuotaPreflightEnabled(createConnection()), false);
});

test("preflightQuota passes through when no fetcher is registered for the provider", async () => {
  const result = await preflightQuota(
    "provider-missing-fetcher",
    "conn-2",
    createConnection({ quotaPreflightEnabled: true })
  );

  assert.deepEqual(result, { proceed: true });
});

test("preflightQuota passes through when the fetcher throws or returns null", async () => {
  registerQuotaFetcher("provider-throws", async () => {
    throw new Error("boom");
  });
  registerQuotaFetcher("provider-null", async () => null);

  const enabled = createConnection({ quotaPreflightEnabled: true });

  assert.deepEqual(await preflightQuota("provider-throws", "conn-3", enabled), {
    proceed: true,
  });
  assert.deepEqual(await preflightQuota("provider-null", "conn-4", enabled), {
    proceed: true,
  });
});

// ─── Legacy single-signal path (no windows map on QuotaInfo) ──────────────

test("preflightQuota (legacy single-signal): warns above 80% by default", async () => {
  const warnings = [];
  registerQuotaFetcher("provider-warn", async () => ({
    used: 80,
    total: 100,
    percentUsed: 0.8,
  }));

  const result = await withPatchedConsole(
    "warn",
    (message) => warnings.push(message),
    async () =>
      preflightQuota("provider-warn", "conn-5", createConnection({ quotaPreflightEnabled: true }))
  );

  assert.deepEqual(result, { proceed: true, quotaPercent: 0.8 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /approaching limit/i);
});

test("preflightQuota (legacy single-signal): blocks at 98% by default", async () => {
  registerQuotaFetcher("provider-exhausted", async () => ({
    used: 99,
    total: 100,
    percentUsed: 0.99,
  }));

  const result = await preflightQuota(
    "provider-exhausted",
    "conn-6",
    createConnection({ quotaPreflightEnabled: true })
  );

  assert.deepEqual(result, {
    proceed: false,
    reason: "quota_exhausted",
    quotaPercent: 0.99,
    resetAt: null,
  });
});

test("preflightQuota (legacy single-signal): resolver override drives the decision", async () => {
  registerQuotaFetcher("provider-override-block", async () => ({
    used: 91,
    total: 100,
    percentUsed: 0.91,
  }));

  // window=null in the resolver signature is the legacy/single-signal call.
  const result = await preflightQuota(
    "provider-override-block",
    "conn-override-1",
    createConnection({ quotaPreflightEnabled: true }),
    {
      resolveExhaustionPercent: () => 90,
      resolveWarnPercent: () => 80,
    }
  );
  assert.equal(result.proceed, false);
  assert.equal(result.reason, "quota_exhausted");
});

// ─── New per-window path (windows map on QuotaInfo) ───────────────────────

test("preflightQuota (per-window): blocks if ANY window exceeds its own threshold", async () => {
  // 5h at 50% (under cutoff 95), 7d at 82% (over cutoff 80) → block,
  // and the response should name the worst window (window7d).
  const infos = [];
  registerQuotaFetcher("provider-windows-block", async () => ({
    used: 82,
    total: 100,
    percentUsed: 0.82,
    windows: {
      window5h: { percentUsed: 0.5, resetAt: "2026-05-14T20:00:00Z" },
      window7d: { percentUsed: 0.82, resetAt: "2026-05-21T00:00:00Z" },
    },
  }));

  const result = await withPatchedConsole(
    "info",
    (message) => infos.push(message),
    async () =>
      preflightQuota(
        "provider-windows-block",
        "conn-windows-1",
        createConnection({ quotaPreflightEnabled: true }),
        {
          resolveExhaustionPercent: (window) =>
            window === "window5h" ? 95 : window === "window7d" ? 80 : 98,
        }
      )
  );

  assert.equal(result.proceed, false);
  assert.equal(result.reason, "quota_exhausted");
  assert.equal(result.quotaPercent, 0.82);
  assert.equal(result.resetAt, "2026-05-21T00:00:00Z");
  assert.equal(infos.length, 1);
  assert.match(infos[0], /window7d/);
});

test("preflightQuota (per-window): both under their thresholds → proceed", async () => {
  registerQuotaFetcher("provider-windows-pass", async () => ({
    used: 70,
    total: 100,
    percentUsed: 0.7,
    windows: {
      window5h: { percentUsed: 0.7, resetAt: null },
      window7d: { percentUsed: 0.4, resetAt: null },
    },
  }));

  const result = await preflightQuota(
    "provider-windows-pass",
    "conn-windows-2",
    createConnection({ quotaPreflightEnabled: true }),
    {
      resolveExhaustionPercent: (window) => (window === "window5h" ? 95 : 80),
    }
  );

  assert.equal(result.proceed, true);
});

test("preflightQuota (per-window): resolver receives the window name, not null", async () => {
  const seenWindows: (string | null)[] = [];
  registerQuotaFetcher("provider-windows-resolver-witness", async () => ({
    used: 10,
    total: 100,
    percentUsed: 0.1,
    windows: {
      window5h: { percentUsed: 0.1, resetAt: null },
      window7d: { percentUsed: 0.05, resetAt: null },
    },
  }));

  await preflightQuota(
    "provider-windows-resolver-witness",
    "conn-windows-3",
    createConnection({ quotaPreflightEnabled: true }),
    {
      resolveExhaustionPercent: (window) => {
        seenWindows.push(window);
        return 98;
      },
    }
  );

  assert.deepEqual(seenWindows.sort(), ["window5h", "window7d"]);
});

test("preflightQuota (per-window): omitted resolver falls back to the 98% default", async () => {
  // Codex 7d at 99% with NO resolver passed should still block at 98%.
  registerQuotaFetcher("provider-windows-default", async () => ({
    used: 99,
    total: 100,
    percentUsed: 0.99,
    windows: {
      window5h: { percentUsed: 0.1, resetAt: null },
      window7d: { percentUsed: 0.99, resetAt: null },
    },
  }));

  const result = await preflightQuota(
    "provider-windows-default",
    "conn-windows-4",
    createConnection({ quotaPreflightEnabled: true })
  );

  assert.equal(result.proceed, false);
  assert.equal(result.quotaPercent, 0.99);
});

// ─── Window registry ─────────────────────────────────────────────────────

test("registerQuotaWindows / getQuotaWindows round-trips", () => {
  registerQuotaWindows("test-provider", ["a", "b"]);
  assert.deepEqual([...getQuotaWindows("test-provider")], ["a", "b"]);
  // Unknown provider returns an empty list rather than undefined.
  assert.deepEqual([...getQuotaWindows("provider-with-no-registration-anywhere")], []);
});
