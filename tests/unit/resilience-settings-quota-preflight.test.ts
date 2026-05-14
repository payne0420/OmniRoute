import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESILIENCE_SETTINGS,
  mergeResilienceSettings,
  resolveResilienceSettings,
  type ResilienceSettings,
} from "../../src/lib/resilience/settings.ts";

function cloneDefaults(): ResilienceSettings {
  return structuredClone(DEFAULT_RESILIENCE_SETTINGS);
}

test("default quotaPreflight values match the historical hardcoded thresholds", () => {
  const settings = cloneDefaults();
  assert.equal(settings.quotaPreflight.defaultThresholdPercent, 98);
  assert.equal(settings.quotaPreflight.warnThresholdPercent, 80);
});

test("default providerWindowDefaults seeds Codex session=95, weekly=80", () => {
  const settings = cloneDefaults();
  assert.deepEqual(settings.quotaPreflight.providerWindowDefaults.codex, {
    session: 95,
    weekly: 80,
  });
});

test("resolveResilienceSettings returns defaults when nothing is stored", () => {
  const resolved = resolveResilienceSettings({});
  assert.equal(resolved.quotaPreflight.defaultThresholdPercent, 98);
  assert.equal(resolved.quotaPreflight.warnThresholdPercent, 80);
  // The seeded codex defaults survive the resolve-from-empty path.
  assert.deepEqual(resolved.quotaPreflight.providerWindowDefaults.codex, {
    session: 95,
    weekly: 80,
  });
});

test("mergeResilienceSettings: partial defaultThresholdPercent update preserves warnThresholdPercent", () => {
  const current = cloneDefaults();
  const next = mergeResilienceSettings(current, {
    quotaPreflight: { defaultThresholdPercent: 95 },
  });
  assert.equal(next.quotaPreflight.defaultThresholdPercent, 95);
  assert.equal(next.quotaPreflight.warnThresholdPercent, 80);
});

test("mergeResilienceSettings clamps defaultThresholdPercent above 100 to 100", () => {
  const next = mergeResilienceSettings(cloneDefaults(), {
    quotaPreflight: { defaultThresholdPercent: 150 },
  });
  assert.equal(next.quotaPreflight.defaultThresholdPercent, 100);
});

test("warnThresholdPercent is forced below defaultThresholdPercent when sent in conflict", () => {
  const next = mergeResilienceSettings(cloneDefaults(), {
    quotaPreflight: { defaultThresholdPercent: 90, warnThresholdPercent: 95 },
  });
  assert(
    next.quotaPreflight.warnThresholdPercent < next.quotaPreflight.defaultThresholdPercent,
    `expected warn < default, got warn=${next.quotaPreflight.warnThresholdPercent} default=${next.quotaPreflight.defaultThresholdPercent}`
  );
  assert.equal(next.quotaPreflight.defaultThresholdPercent, 90);
  assert.equal(next.quotaPreflight.warnThresholdPercent, 89);
});

test("providerWindowDefaults: arbitrary new provider/window pairs are normalized and stored", () => {
  const next = mergeResilienceSettings(cloneDefaults(), {
    quotaPreflight: {
      providerWindowDefaults: {
        // Replace codex's windows
        codex: { window5h: 90, window7d: 70 },
        // Add a hypothetical new provider with a monthly window
        someprovider: { monthly: 60 },
      },
    },
  });
  assert.deepEqual(next.quotaPreflight.providerWindowDefaults.codex, {
    window5h: 90,
    window7d: 70,
  });
  assert.deepEqual(next.quotaPreflight.providerWindowDefaults.someprovider, { monthly: 60 });
});

test("providerWindowDefaults: out-of-range values are clamped, garbage is pruned", () => {
  const next = mergeResilienceSettings(cloneDefaults(), {
    quotaPreflight: {
      providerWindowDefaults: {
        codex: {
          window5h: 150, // clamped to 100
          window7d: -20, // clamped to 0
          // @ts-expect-error: intentionally bogus to ensure pruning
          junk: "not a number",
        },
      },
    },
  });
  assert.equal(next.quotaPreflight.providerWindowDefaults.codex.window5h, 100);
  assert.equal(next.quotaPreflight.providerWindowDefaults.codex.window7d, 0);
  assert.equal(
    "junk" in next.quotaPreflight.providerWindowDefaults.codex,
    false,
    "non-numeric entries should be pruned"
  );
});

test("resolveResilienceSettings round-trips a stored providerWindowDefaults map", () => {
  const stored = {
    resilienceSettings: {
      quotaPreflight: {
        defaultThresholdPercent: 85,
        warnThresholdPercent: 70,
        providerWindowDefaults: { codex: { window5h: 88, window7d: 60 } },
      },
    },
  };
  const resolved = resolveResilienceSettings(stored);
  assert.equal(resolved.quotaPreflight.defaultThresholdPercent, 85);
  assert.equal(resolved.quotaPreflight.warnThresholdPercent, 70);
  assert.deepEqual(resolved.quotaPreflight.providerWindowDefaults.codex, {
    window5h: 88,
    window7d: 60,
  });
});
