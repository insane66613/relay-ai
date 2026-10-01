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

/** Scalar/enum values a property schema allows via `const`/`enum` (references resolved). */
function allowedEnumValues(schema: unknown, defs: Record<string, unknown> | undefined): unknown[] | undefined {
  const resolved = resolveLocalDefRef(schema, defs);
  if (!resolved) return undefined;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum;
  if (resolved.const !== undefined) return [resolved.const];
  return undefined;
}

/**
 * Combine two definitions of one property.
 * 1. If both are enums/consts, union the allowed values (preserving strings, numbers, etc.).
 * 2. If both schemas are identical, return the first.
 * 3. If conflicting/incompatible, wrap in `anyOf` inside the property schema (which is
 *    valid JSON Schema accepted by Anthropic and other non-OpenAI engines).
 */
function mergePropertySchemas(
  first: unknown,
  second: unknown,
  defs: Record<string, unknown> | undefined,
): unknown {
  const firstValues = allowedEnumValues(first, defs);
  const secondValues = allowedEnumValues(second, defs);
  if (firstValues && secondValues) {
    const seen = new Set<string>();
    const union: unknown[] = [];
    for (const val of [...firstValues, ...secondValues]) {
      const key = JSON.stringify(val);
      if (!seen.has(key)) {
        seen.add(key);
        union.push(val);
      }
    }
    const base = { ...(resolveLocalDefRef(first, defs) ?? {}) };
    delete base.const;
    return { ...base, enum: union };
  }
  if (JSON.stringify(first) === JSON.stringify(second)) return first;

  const firstResolved = resolveLocalDefRef(first, defs) ?? first;
  const secondResolved = resolveLocalDefRef(second, defs) ?? second;
  const existingBranches = isPlainObject(firstResolved) && Array.isArray(firstResolved.anyOf)
    ? firstResolved.anyOf
    : [firstResolved];
  return { anyOf: [...existingBranches, secondResolved] };
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

interface UnionCollectResult {
  properties: Record<string, unknown>;
  required: string[];
  allBranchesFalseAdditionalProps: boolean;
  hasExplicitFalseAdditionalProps: boolean;
  sawObjectBranch: boolean;
}

function collectBranchInfo(
  branches: unknown[],
  mode: 'union' | 'all',
  defs: Record<string, unknown> | undefined,
): UnionCollectResult {
  const properties: Record<string, unknown> = {};
  let sawObjectBranch = false;
  let allBranchesFalseAdditionalProps = true;
  let hasExplicitFalseAdditionalProps = false;
  const branchRequiredSets: Set<string>[] = [];
  const allOfRequiredSets: Set<string>[] = [];

  for (const branch of branches) {
    const resolved = resolveLocalDefRef(branch, defs);
    if (!resolved) continue;

    const nestedUnion = Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : Array.isArray(resolved.anyOf)
        ? resolved.anyOf
        : undefined;
    const nestedAll = Array.isArray(resolved.allOf) ? resolved.allOf : undefined;

    let branchIsObject = resolved.type === 'object' || isPlainObject(resolved.properties);
    const branchRequired = new Set<string>();

    if (isPlainObject(resolved.properties)) {
      mergeBranchProperties(properties, resolved.properties, defs);
      sawObjectBranch = true;
    }

    if (resolved.additionalProperties === false) {
      hasExplicitFalseAdditionalProps = true;
    } else if (isPlainObject(resolved.properties) || (!nestedUnion && !nestedAll)) {
      if (branchIsObject) allBranchesFalseAdditionalProps = false;
    }

    if (Array.isArray(resolved.required)) {
      for (const k of resolved.required) {
        if (typeof k === 'string') branchRequired.add(k);
      }
    }

    if (nestedUnion) {
      const inner = collectBranchInfo(nestedUnion, 'union', defs);
      if (inner.sawObjectBranch) {
        mergeBranchProperties(properties, inner.properties, defs);
        sawObjectBranch = true;
        branchIsObject = true;
        if (inner.hasExplicitFalseAdditionalProps) hasExplicitFalseAdditionalProps = true;
        if (!inner.allBranchesFalseAdditionalProps) allBranchesFalseAdditionalProps = false;
        for (const r of inner.required) branchRequired.add(r);
      }
    }

    if (nestedAll) {
      const inner = collectBranchInfo(nestedAll, 'all', defs);
      if (inner.sawObjectBranch) {
        mergeBranchProperties(properties, inner.properties, defs);
        sawObjectBranch = true;
        branchIsObject = true;
        if (inner.hasExplicitFalseAdditionalProps) hasExplicitFalseAdditionalProps = true;
        if (!inner.allBranchesFalseAdditionalProps) allBranchesFalseAdditionalProps = false;
        for (const r of inner.required) branchRequired.add(r);
      }
    }

    if (branchIsObject) {
      if (mode === 'all') allOfRequiredSets.push(branchRequired);
      else branchRequiredSets.push(branchRequired);
    }
  }

  let finalRequired: string[] = [];
  if (mode === 'union') {
    if (branchRequiredSets.length > 0) {
      const [first, ...rest] = branchRequiredSets;
      finalRequired = [...first!].filter(key => rest.every(s => s.has(key)));
    }
  } else {
    const union = new Set<string>();
    for (const set of allOfRequiredSets) {
      for (const k of set) union.add(k);
    }
    finalRequired = [...union];
  }

  return {
    properties,
    required: finalRequired,
    allBranchesFalseAdditionalProps: sawObjectBranch ? allBranchesFalseAdditionalProps : false,
    hasExplicitFalseAdditionalProps,
    sawObjectBranch,
  };
}

/**
 * Rewrite a root-level `oneOf`/`anyOf`/`allOf` into a single object schema:
 * 1. Properties: union of every object branch's properties.
 * 2. Required: intersection across `oneOf`/`anyOf` branches + union across `allOf` branches + root required.
 * 3. AdditionalProperties: false if every object branch and root declared false; otherwise true.
 * 4. Resolves local root `$ref`s to unions.
 */
export function flattenRootUnionSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  const defs = isPlainObject(schema.$defs) ? schema.$defs : undefined;
  let root = schema;
  if (typeof root.$ref === 'string' && root.$ref.startsWith('#/$defs/')) {
    const resolved = resolveLocalDefRef(root, defs);
    if (resolved) root = { ...resolved, ...(defs ? { $defs: defs } : {}) };
  }

  const unionBranches = [
    ...(Array.isArray(root.oneOf) ? root.oneOf : []),
    ...(Array.isArray(root.anyOf) ? root.anyOf : []),
  ];
  const allBranches = Array.isArray(root.allOf) ? root.allOf : [];

  if (unionBranches.length === 0 && allBranches.length === 0) return schema;

  const mergedProperties: Record<string, unknown> = isPlainObject(root.properties)
    ? { ...root.properties }
    : {};
  const requiredSet = new Set<string>();
  if (Array.isArray(root.required)) {
    for (const r of root.required) if (typeof r === 'string') requiredSet.add(r);
  }

  let sawObject = isPlainObject(root.properties);
  const allowsAdditional = root.additionalProperties === true;
  let hasExplicitFalse = root.additionalProperties === false;
  let allBranchesClosed = root.additionalProperties === false || root.additionalProperties === undefined;

  if (unionBranches.length > 0) {
    const res = collectBranchInfo(unionBranches, 'union', defs);
    if (res.sawObjectBranch) {
      mergeBranchProperties(mergedProperties, res.properties, defs);
      for (const r of res.required) requiredSet.add(r);
      sawObject = true;
      if (res.hasExplicitFalseAdditionalProps) hasExplicitFalse = true;
      if (!res.allBranchesFalseAdditionalProps) allBranchesClosed = false;
    }
  }

  if (allBranches.length > 0) {
    const res = collectBranchInfo(allBranches, 'all', defs);
    if (res.sawObjectBranch) {
      mergeBranchProperties(mergedProperties, res.properties, defs);
      for (const r of res.required) requiredSet.add(r);
      sawObject = true;
      if (res.hasExplicitFalseAdditionalProps) hasExplicitFalse = true;
      if (!res.allBranchesFalseAdditionalProps) allBranchesClosed = false;
    }
  }

  if (!sawObject) return schema;

  const isClosed = hasExplicitFalse && allBranchesClosed && !allowsAdditional;

  const out: Record<string, unknown> = {
    type: 'object',
    properties: mergedProperties,
    additionalProperties: isClosed ? false : true,
  };
  if (requiredSet.size > 0) out.required = [...requiredSet];
  if (defs) out.$defs = defs;
  if (typeof root.description === 'string') out.description = root.description;
  return out;
}

export function normalizeToolSchemaForNpm<T>(schema: T, npm: string | undefined): T {
  const acyclic = npm && RECURSION_SAFE_NPM.has(npm) ? schema : breakRecursiveSchemaRefs(schema) as T;
  const portable = rewriteNulPatternEscapes(acyclic) as T;
  if (!npm || !RECURSION_SAFE_NPM.has(npm)) {
    const flattened = flattenRootUnionSchema(portable) as T;
    if (!npm || !GOOGLE_NPM.has(npm)) return flattened;
    return fixGoogleArraySchemas(collapseSchemaUnionTypes(flattened)) as T;
  }
  return portable;
}
