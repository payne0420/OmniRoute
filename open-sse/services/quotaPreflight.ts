/**
 * quotaPreflight.ts — Feature 04
 * Quota Preflight & Troca Proativa de Conta
 *
 * Providers register quota fetchers via registerQuotaFetcher(). The caller
 * (`src/sse/services/auth.ts::getProviderCredentialsWithQuotaPreflight`) is
 * responsible for deciding WHEN to invoke preflight — calling it adds the
 * latency of an upstream usage fetch, so it should only run when there's
 * something to enforce (per-connection overrides, per-(provider, window)
 * defaults, or the legacy `quotaPreflightEnabled` flag).
 *
 * `isQuotaPreflightEnabled` remains exported for back-compat so the caller
 * can honor the legacy flag, but `preflightQuota` itself no longer gates on
 * it — once you invoke preflight, it runs the fetcher and evaluates.
 */

export interface PreflightQuotaResult {
  proceed: boolean;
  reason?: string;
  quotaPercent?: number;
  resetAt?: string | null;
}

export interface QuotaWindowInfo {
  percentUsed: number;
  resetAt?: string | null;
}

export interface QuotaInfo {
  used: number;
  total: number;
  /** Worst-case percentUsed across all known windows (legacy, single-signal). */
  percentUsed: number;
  resetAt?: string | null;
  /**
   * Optional per-window breakdown. When present, preflight evaluates each
   * window against its own threshold (block if ANY exceeds) instead of using
   * `percentUsed`. Keys are window names (e.g. "window5h", "window7d").
   */
  windows?: Record<string, QuotaWindowInfo>;
}

export type QuotaFetcher = (
  connectionId: string,
  connection?: Record<string, unknown>
) => Promise<QuotaInfo | null>;

/**
 * Registry of named quota windows per provider. Used by the dashboard to
 * discover which inputs to render in the cutoffs modal. Providers without
 * multiple windows can skip registration — preflight falls back to the
 * single-signal `percentUsed` path in that case.
 */
const quotaWindowsRegistry = new Map<string, readonly string[]>();

export function registerQuotaWindows(provider: string, windows: readonly string[]): void {
  quotaWindowsRegistry.set(provider, [...windows]);
}

export function getQuotaWindows(provider: string): readonly string[] {
  return (
    quotaWindowsRegistry.get(provider) || quotaWindowsRegistry.get(provider.toLowerCase()) || []
  );
}

export function getAllProviderQuotaWindows(): Record<string, readonly string[]> {
  return Object.fromEntries(quotaWindowsRegistry);
}

const EXHAUSTION_THRESHOLD = 0.98;
const WARN_THRESHOLD = 0.8;

const quotaFetcherRegistry = new Map<string, QuotaFetcher>();

export function registerQuotaFetcher(provider: string, fetcher: QuotaFetcher): void {
  quotaFetcherRegistry.set(provider, fetcher);
}

export function getQuotaFetcher(provider: string): QuotaFetcher | undefined {
  return quotaFetcherRegistry.get(provider) || quotaFetcherRegistry.get(provider.toLowerCase());
}

export function isQuotaPreflightEnabled(connection: Record<string, unknown>): boolean {
  const psd = connection?.providerSpecificData as Record<string, unknown> | undefined;
  return psd?.quotaPreflightEnabled === true;
}

export interface PreflightQuotaThresholds {
  /**
   * Resolve the exhaustion percent (0-100 integer) for a given window name.
   * Called once per known window on the quota. Should return the smallest
   * applicable cutoff: per-connection override → per-(provider,window)
   * default → global default. Window name is `null` when the underlying
   * fetcher only exposes a single-signal `percentUsed` (legacy path).
   */
  resolveExhaustionPercent?: (window: string | null) => number;
  /**
   * Resolve the warning percent (0-100 integer) for a given window name.
   * Same semantics as `resolveExhaustionPercent`.
   */
  resolveWarnPercent?: (window: string | null) => number;
}

function resolveOrDefault(
  resolver: ((window: string | null) => number) | undefined,
  window: string | null,
  fallbackFraction: number
): number {
  if (!resolver) return fallbackFraction;
  const raw = resolver(window);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
    return raw / 100;
  }
  return fallbackFraction;
}

export async function preflightQuota(
  provider: string,
  connectionId: string,
  connection: Record<string, unknown>,
  thresholds?: PreflightQuotaThresholds
): Promise<PreflightQuotaResult> {
  // No legacy enable-flag gate here — the caller decides when to invoke us
  // (see file-level docstring). When there's no fetcher we proceed silently.
  const fetcher = getQuotaFetcher(provider);
  if (!fetcher) {
    return { proceed: true };
  }

  let quota: QuotaInfo | null = null;
  try {
    quota = await fetcher(connectionId, connection);
  } catch {
    return { proceed: true };
  }

  if (!quota) {
    return { proceed: true };
  }

  // Per-window evaluation — only when the fetcher surfaces a windows map.
  // We block as soon as ANY single window crosses its own exhaustion threshold;
  // warnings are logged independently per window.
  if (quota.windows && Object.keys(quota.windows).length > 0) {
    let worstPercent = 0;
    let worstWindow: string | null = null;
    let worstResetAt: string | null = null;
    for (const [windowName, windowInfo] of Object.entries(quota.windows)) {
      const exhaustion = resolveOrDefault(
        thresholds?.resolveExhaustionPercent,
        windowName,
        EXHAUSTION_THRESHOLD
      );
      const warn = resolveOrDefault(thresholds?.resolveWarnPercent, windowName, WARN_THRESHOLD);

      if (windowInfo.percentUsed >= exhaustion) {
        // Track the most-depleted blocking window so the response can name it.
        if (windowInfo.percentUsed > worstPercent) {
          worstPercent = windowInfo.percentUsed;
          worstWindow = windowName;
          worstResetAt = windowInfo.resetAt ?? null;
        } else if (worstWindow === null) {
          worstWindow = windowName;
          worstResetAt = windowInfo.resetAt ?? null;
        }
      } else if (windowInfo.percentUsed >= warn) {
        console.warn(
          `[QuotaPreflight] ${provider}/${connectionId} ${windowName}: ${(windowInfo.percentUsed * 100).toFixed(1)}% used — approaching limit`
        );
      }
    }

    if (worstWindow !== null) {
      console.info(
        `[QuotaPreflight] ${provider}/${connectionId} ${worstWindow}: ${(worstPercent * 100).toFixed(1)}% used — switching`
      );
      return {
        proceed: false,
        reason: "quota_exhausted",
        quotaPercent: worstPercent,
        resetAt: worstResetAt,
      };
    }

    return { proceed: true, quotaPercent: quota.percentUsed };
  }

  // Legacy single-signal path for fetchers that don't expose per-window data.
  const exhaustion = resolveOrDefault(
    thresholds?.resolveExhaustionPercent,
    null,
    EXHAUSTION_THRESHOLD
  );
  const warn = resolveOrDefault(thresholds?.resolveWarnPercent, null, WARN_THRESHOLD);

  const { percentUsed } = quota;

  if (percentUsed >= exhaustion) {
    console.info(
      `[QuotaPreflight] ${provider}/${connectionId}: ${(percentUsed * 100).toFixed(1)}% used — switching (threshold ${(exhaustion * 100).toFixed(0)}%)`
    );
    return {
      proceed: false,
      reason: "quota_exhausted",
      quotaPercent: percentUsed,
      resetAt: quota.resetAt ?? null,
    };
  }

  if (percentUsed >= warn) {
    console.warn(
      `[QuotaPreflight] ${provider}/${connectionId}: ${(percentUsed * 100).toFixed(1)}% used — approaching limit`
    );
  }

  return { proceed: true, quotaPercent: percentUsed };
}
