/**
 * JSON Schema fixups applied to client tool definitions before the Vercel AI
 * SDK converts them.
 */

const GOOGLE_NPM = new Set(['@ai-sdk/google', '@ai-sdk/google-vertex']);

/**
 * Collapse a union type (`type: ['array', 'null']`) into its single non-null
 * type plus `nullable`.
 *
 * @ai-sdk/google's JSON Schema -> OpenAPI converter turns a union into
 * `anyOf: [{ type }]` and never sets `type` on the node itself, leaving a
 * sibling `items` orphaned. Gemini then rejects the whole request with
 * `properties[x].items: field predicate failed: $type == Type.ARRAY` (HTTP 400).
 * Codex declares optional list arguments this way (image_gen's
 * `referenced_image_paths`), and because tool definitions ride on every request,
 * one such argument 400s plain text prompts too. Still reproducible on
 * @ai-sdk/google 4.0.67.
 */
export function collapseSchemaUnionTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(collapseSchemaUnionTypes);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'type' && Array.isArray(child)) {
      const nonNull = child.filter(entry => entry !== 'null');
      if (nonNull.length === 1) {
        out.type = nonNull[0];
        if (nonNull.length < child.length) out.nullable = true;
        continue;
      }
    }
    out[key] = collapseSchemaUnionTypes(child);
  }
  return out;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * Rewrite the JavaScript NUL escape (`\0`) inside a `pattern` to `\x00`, the
 * form every regex engine parses. Returns null when nothing needed rewriting so
 * callers can keep the original string — and, above, the original schema object.
 *
 * `\012` is an octal escape, not a NUL followed by "12", so a `\0` followed by
 * another digit is left alone. A `\0` behind an escaped backslash is a literal
 * backslash plus "0" and must also survive untouched.
 */
function rewriteNulEscapesInPattern(pattern: string): string | null {
  let out = '';
  let escaped = false;
  let changed = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      if (ch === '0' && !isDigit(pattern[i + 1])) {
        out += 'x00';
        changed = true;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '\\') escaped = true;
    out += ch;
  }
  return changed ? out : null;
}

/**
 * Make every `pattern` in a tool schema portable across provider regex engines.
 *
 * Command Code compiles each `pattern` it receives and rejects the JS NUL escape
 * *inside a character class* while accepting it bare. Claude Code ships exactly
 * that shape: its Artifact tool declares `file_paths` as
 * `z.array(z.string().min(1).max(1024).regex(/^[^\0]*$/))`, so the request is
 * refused before any token is generated — `Invalid schema for function
 * 'Artifact': "^[^\0]*$" is not a "regex"` when the pattern sits directly on a
 * property, or the vaguer `... is not valid under any of the schemas listed in
 * the 'anyOf' keyword` when it sits inside `items` or an `anyOf` branch. The
 * Artifact tool is REPL-only, so this only fires in interactive Claude Code —
 * `claude -p` sends 12 tools and never hits it.
 *
 * `\x00` is the same character to every engine, so the constraint survives;
 * dropping `pattern` outright would silently weaken validation instead.
 */
export function rewriteNulPatternEscapes(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(entry => {
      const next = rewriteNulPatternEscapes(entry);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!value || typeof value !== 'object') return value;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = key === 'pattern' && typeof child === 'string'
      ? rewriteNulEscapesInPattern(child) ?? child
      : rewriteNulPatternEscapes(child);
    if (next !== child) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/**
 * Pick the `items` schema for a Gemini array that declares none.
 *
 * A tuple (`prefixItems`) collapses to its element type when the entries agree;
 * otherwise — and for an array with no element info at all — we fall back to
 * `{ type: 'string' }`. Gemini's OpenAPI subset requires every array to carry a
 * typed `items`, and has no "any" type, so a lossy-but-valid default beats a
 * 400 that takes down every tool (and plain chat) on the request.
 */
function synthesizeGoogleItems(prefixItems: unknown): Record<string, unknown> {
  if (Array.isArray(prefixItems) && prefixItems.length > 0) {
    const types = new Set(
      prefixItems
        .map(entry => (entry && typeof entry === 'object' ? (entry as { type?: unknown }).type : undefined))
        .filter((t): t is string => typeof t === 'string'),
    );
    if (types.size === 1) return { type: [...types][0]! };
  }
  return { type: 'string' };
}

/**
 * Make array schemas valid for Gemini function declarations.
 *
 * Gemini rejects two shapes Claude Code / MCP tools ship freely:
 *   - a `type: 'array'` with no `items` (e.g. Claude Docs' `batch`) →
 *     `properties[batch].items: missing field`
 *   - a tuple array via `prefixItems` (e.g. ArtifactData's `query.where`) →
 *     `...where.items.items: missing field`
 * Both 400 the whole request, killing every tool and plain chat with it. We add
 * a typed `items` where absent and collapse `prefixItems` into one `items`
 * schema, dropping `prefixItems` since Gemini's dialect does not accept it.
 */
export function fixGoogleArraySchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixGoogleArraySchemas);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = fixGoogleArraySchemas(child);
  }
  if (out.type === 'array') {
    if (out.items === undefined) out.items = synthesizeGoogleItems(out.prefixItems);
    delete out.prefixItems;
  }
  return out;
}

/**
 * Every route gets NUL pattern escapes rewritten. Union types and array shapes
 * stay intact except on Google, which cannot represent them, and xAI, which
 * also rejects a root-level union outright (see {@link flattenRootUnionSchema}).
 */
const RECURSION_SAFE_NPM = new Set(['@ai-sdk/openai', '@ai-sdk/azure']);

/**
 * Inline a schema's local `#/$defs/` references when any of them loops back on
 * itself, replacing the looping reference with `{}` (any value). Schemas without
 * a loop are returned unchanged.
 *
 * Meta's models via Command Code reject the whole request with "Recursive JSON
 * schemas are not currently supported" (HTTP 400). The Codex app always sends
 * one: request_environment_input's `secrets[].target` is a self-referencing
 * "any JSON value", so every Codex app request (even its startup warm-up)
 * failed. Verified live: the inlined form is accepted and the model answers.
 */
export function breakRecursiveSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const defs = (schema as Record<string, unknown>).$defs;
  if (!defs || typeof defs !== 'object' || Array.isArray(defs)) return schema;
  const definitions = defs as Record<string, unknown>;
  let looped = false;

  const walk = (node: unknown, resolving: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map(child => walk(child, resolving));
    if (!node || typeof node !== 'object') return node;
    const { $ref, ...rest } = node as Record<string, unknown>;
    if (typeof $ref === 'string' && $ref.startsWith('#/$defs/')) {
      const name = $ref.slice('#/$defs/'.length);
      if (name in definitions) {
        if (resolving.has(name)) {
          looped = true;
          return {};
        }
        const target = walk(definitions[name], new Set([...resolving, name]));
        return { ...(target as Record<string, unknown>), ...(walk(rest, resolving) as Record<string, unknown>) };
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$defs' && resolving.size === 0 && node === schema) continue;
      out[key] = walk(child, resolving);
    }
    return out;
  };

  const inlined = walk(schema, new Set());
  return looped ? inlined : schema;
}

/**
 * npm package whose API validates tool schemas strictly: xAI refuses the whole
 * request when a tool's parameter ROOT is not an object type —
 * `[invalid_client_tool_schema] <tool>: tool parameter root must be an object
 * type (root schema is an anyOf/oneOf union with a non-object branch)` (HTTP
 * 400). The Codex/ChatGPT app ships MCP tools declared as root unions
 * (mcp__codex_app__automation_update and friends), and because tool defs ride
 * on every request, one such tool 400s every turn — including plain chat.
 */
const XAI_NPM = '@ai-sdk/xai';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Follow local `#/$defs/...` links to a concrete schema. Sibling keywords next
 * to the `$ref` win over the target (JSON Schema semantics). Returns undefined
 * for unresolvable or looping chains, and callers fall back safely.
 */
function resolveLocalDefRef(
  value: unknown,
  defs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  let current: unknown = value;
  const seen = new Set<string>();
  while (isPlainObject(current) && typeof current.$ref === 'string' && current.$ref.startsWith('#/$defs/')) {
    const name = current.$ref.slice('#/$defs/'.length);
    const target = defs?.[name];
    if (!isPlainObject(target) || seen.has(name)) return undefined;
    seen.add(name);
    const sibling = { ...current };
    delete sibling.$ref;
    current = { ...target, ...sibling };
  }
  return isPlainObject(current) ? current : undefined;
}

/** String values a property schema allows via `const`/`enum` (references resolved). */
function allowedStringValues(schema: unknown, defs: Record<string, unknown> | undefined): string[] | undefined {
  const resolved = resolveLocalDefRef(schema, defs);
  if (!resolved) return undefined;
  if (Array.isArray(resolved.enum)) {
    const values = resolved.enum.filter((entry): entry is string => typeof entry === 'string');
    if (values.length > 0) return values;
  }
  if (typeof resolved.const === 'string') return [resolved.const];
  return undefined;
}

/**
 * Combine two definitions of one property. Sibling branches typically differ
 * only in a `mode`-style discriminator; unioning the allowed values keeps every
 * branch's choice valid instead of silently locking in the first one.
 */
function mergePropertySchemas(
  first: unknown,
  second: unknown,
  defs: Record<string, unknown> | undefined,
): unknown {
  const firstValues = allowedStringValues(first, defs);
  const secondValues = allowedStringValues(second, defs);
  if (!firstValues || !secondValues) return first;
  const union = [...new Set([...firstValues, ...secondValues])];
  const base = { ...(resolveLocalDefRef(first, defs) ?? {}) };
  delete base.const;
  return { ...base, enum: union };
}

/** Merge `source` properties into `target`, unioning conflicting discriminators. */
function mergeBranchProperties(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  defs: Record<string, unknown> | undefined,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = key in target ? mergePropertySchemas(target[key], value, defs) : value;
  }
}

/**
 * Collect the properties every object branch of a root union declares —
 * resolving `$ref` branches and recursing through nested unions (a mode branch
 * can itself be a union of shapes). Returns null when no branch carries an
 * object shape, so the caller can fall back to a permissive object.
 */
function collectUnionBranchProperties(
  branches: unknown[],
  defs: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const properties: Record<string, unknown> = {};
  let sawObjectBranch = false;
  for (const branch of branches) {
    const resolved = resolveLocalDefRef(branch, defs);
    if (!resolved) continue;
    const nested = Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : Array.isArray(resolved.anyOf)
        ? resolved.anyOf
        : undefined;
    if (nested) {
      const inner = collectUnionBranchProperties(nested, defs);
      if (inner) {
        mergeBranchProperties(properties, inner, defs);
        sawObjectBranch = true;
      }
      continue;
    }
    if (resolved.type !== 'object' && !isPlainObject(resolved.properties)) continue;
    if (isPlainObject(resolved.properties)) mergeBranchProperties(properties, resolved.properties, defs);
    sawObjectBranch = true;
  }
  return sawObjectBranch ? properties : null;
}

/**
 * Rewrite a root-level `oneOf`/`anyOf` into a single object schema — the union
 * of every object branch's properties, `additionalProperties: true`, and no
 * `required` (it cannot be right for every branch). `$defs` is kept so the
 * remaining inner `$ref`s still resolve. A schema whose root carries no union
 * is returned untouched.
 */
export function flattenRootUnionSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  const root = schema;
  const branches = Array.isArray(root.oneOf)
    ? root.oneOf
    : Array.isArray(root.anyOf)
      ? root.anyOf
      : undefined;
  if (!branches) return root;
  const defs = isPlainObject(root.$defs) ? root.$defs : undefined;
  const merged: Record<string, unknown> = isPlainObject(root.properties) ? { ...root.properties } : {};
  mergeBranchProperties(merged, collectUnionBranchProperties(branches, defs) ?? {}, defs);
  const out: Record<string, unknown> = { type: 'object', properties: merged, additionalProperties: true };
  if (defs) out.$defs = defs;
  if (typeof root.description === 'string') out.description = root.description;
  return out;
}

export function normalizeToolSchemaForNpm<T>(schema: T, npm: string | undefined): T {
  const acyclic = npm && RECURSION_SAFE_NPM.has(npm) ? schema : breakRecursiveSchemaRefs(schema) as T;
  const portable = rewriteNulPatternEscapes(acyclic) as T;
  if (npm === XAI_NPM) return flattenRootUnionSchema(portable) as T;
  if (!npm || !GOOGLE_NPM.has(npm)) return portable;
  return fixGoogleArraySchemas(collapseSchemaUnionTypes(portable)) as T;
}
