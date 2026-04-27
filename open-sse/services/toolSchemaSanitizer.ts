/**
 * Sanitize OpenAI-format tool definitions for strict upstream JSON Schema
 * validators (e.g. Moonshot AI behind opencode-go/kimi-k2.6).
 *
 * The concrete bug this was written for: ForgeCode emits enum schemas like
 *   { type: "string", enum: ["a", "b", "c", null], nullable: true }
 * for nullable optional fields. Lenient providers (Z.AI / GLM) accept the null
 * entry; Moonshot rejects with
 *   "At path 'properties.X.enum': enum value (<nil>) does not match any type
 *    in [string]"
 * before the request reaches the model.
 *
 * The fix is to strip null/undefined from `enum` arrays. Everything else here
 * is defensive hygiene: ensures `parameters` is always a valid object schema,
 * filters `required[]` to keys that exist in `properties`, and normalizes a
 * few other shapes that strict validators tend to reject.
 */

const MAX_RECURSION_DEPTH = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > MAX_RECURSION_DEPTH) return {};
  if (!isPlainObject(value)) return {};

  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;

    if (k === "properties" && isPlainObject(v)) {
      const cleaned: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v)) {
        cleaned[pk] = isPlainObject(pv) ? sanitizeSchema(pv, depth + 1) : {};
      }
      result[k] = cleaned;
    } else if (k === "items") {
      // Recurse into items if it's a single schema. Tuple-form (array) is
      // valid JSON Schema but rejected by Moonshot; coerce to single schema.
      if (Array.isArray(v)) {
        const firstObject = v.find(isPlainObject);
        result[k] = firstObject ? sanitizeSchema(firstObject, depth + 1) : {};
      } else if (isPlainObject(v)) {
        result[k] = sanitizeSchema(v, depth + 1);
      }
    } else if (k === "enum" && Array.isArray(v)) {
      // The actual fix: strip null/undefined entries that ForgeCode adds for
      // nullable optional fields.
      result[k] = v.filter((e) => e !== null && e !== undefined);
    } else if (k === "required" && Array.isArray(v)) {
      result[k] = v.filter((r) => typeof r === "string");
    } else {
      result[k] = v;
    }
  }

  if (Array.isArray(result.required) && isPlainObject(result.properties)) {
    const validKeys = new Set(Object.keys(result.properties));
    result.required = (result.required as string[]).filter((r) => validKeys.has(r));
  }

  return result;
}

export function sanitizeOpenAITool(tool: unknown): unknown {
  if (!isPlainObject(tool)) return tool;
  const t = { ...tool };

  if (isPlainObject(t.function)) {
    const f = { ...t.function };

    if (isPlainObject(f.parameters)) {
      f.parameters = sanitizeSchema(f.parameters);
    } else if (f.parameters === null || f.parameters === undefined) {
      f.parameters = { type: "object", properties: {} };
    }

    t.function = f;
  }

  return t;
}

export function sanitizeOpenAITools(tools: unknown[]): unknown[] {
  return tools.map(sanitizeOpenAITool);
}
