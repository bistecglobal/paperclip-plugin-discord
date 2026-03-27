import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Lazy company-ID resolver — avoids startup-time API calls that can crash
 * worker activation. The resolved value is cached after the first successful call.
 */
let _cachedCompanyId: string | null = null;

export async function resolveCompanyId(ctx: PluginContext): Promise<string> {
  if (_cachedCompanyId) return _cachedCompanyId;
  try {
    const companies = await ctx.companies.list({ limit: 1 });
    if (companies.length > 0) {
      _cachedCompanyId = companies[0].id;
      return _cachedCompanyId;
    }
  } catch (err) {
    ctx.logger.warn("Failed to resolve company ID, falling back to 'default'", { error: String(err) });
  }
  return "default";
}

/** Reset cached company ID (for testing). */
export function _resetCompanyIdCache(): void {
  _cachedCompanyId = null;
}
