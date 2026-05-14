import { NextResponse } from "next/server";
import { getAllProviderQuotaWindows } from "@omniroute/open-sse/services/quotaPreflight.ts";
import { getCachedSettings } from "@/lib/localDb";
import { resolveResilienceSettings } from "@/lib/resilience/settings";

// GET /api/providers/quota-windows
// Returns the named quota windows registered by each provider's quota fetcher,
// plus the resolved per-(provider, window) default thresholds from resilience
// settings. The Provider Limits cutoff modal uses this to know which inputs to
// render per connection and which placeholders to show.
export async function GET() {
  try {
    const windows = getAllProviderQuotaWindows();
    const settings = await getCachedSettings();
    const resilience = resolveResilienceSettings(settings);
    return NextResponse.json({
      windows,
      defaults: {
        globalThresholdPercent: resilience.quotaPreflight.defaultThresholdPercent,
        providerWindowDefaults: resilience.quotaPreflight.providerWindowDefaults,
      },
    });
  } catch (error) {
    console.log("Error fetching quota windows:", error);
    return NextResponse.json({ error: "Failed to fetch quota windows" }, { status: 500 });
  }
}
