// Live reasoning harness — the answer to "does every advertised effort rung
// actually work upstream?" against the developer's real registry, credentials
// and OAuth sessions.
//
// Excluded from `npm test` (the debug-* pattern); run explicitly:
//   npm run test:live:reasoning                          — phase 1 + plan only
//   REASONING_LIVE_FILTER=go npm run test:live:reasoning — live calls for `go`
//   REASONING_LIVE_ALL=1 npm run test:live:reasoning     — live calls, all providers
//
// Live calls read one OS-keychain item per provider (macOS prompts unless the
// calling binary has "Always Allow" on that item), so they are opt-in per
// provider or via REASONING_LIVE_ALL — never implied by a bare run.
//
// Phase 1 (offline): every advertised level on every cached model must resolve
// through Core's request gate (resolveReasoningProviderOptions) to a non-empty
// wire payload — the same invariant the apps rely on, across the whole catalog.
// Phase 2 (network): one minimal request at the top advertised rung per
// provider, sent through createRelayModel — the exact pipeline the Codex app,
// Claude, Antigravity and embedded consumers use (credentials, OAuth refresh,
// metadata, provider options). An upstream that rejects the new rung shows up
// as a `fail` row; auth/quota/rate-limit/network responses are reported as
// skips so they cannot mask a real regression.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { streamText } from 'ai';
import { createRelayModel, listRelayModels } from '../src/core/index.js';
import { loadCoreRegistry } from '../src/core/catalog.js';
import { resolveReasoningProviderOptions } from '../src/core/reasoning.js';
import type { RelayReasoningLevel } from '../src/core/types.js';
import { EFFORT_RANK } from '../src/registry/models-dev.js';
import { getProviderModels } from '../src/registry/provider-models.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';

// This harness intentionally reads the developer's real registry and keychain,
// so undo the throwaway app home the shared test setup points every file at.
let savedHome: string | undefined;
beforeAll(() => {
  savedHome = process.env['RELAY_AI_HOME'];
  delete process.env['RELAY_AI_HOME'];
});
afterAll(() => {
  if (savedHome === undefined) delete process.env['RELAY_AI_HOME'];
  else process.env['RELAY_AI_HOME'] = savedHome;
});

const report: string[] = [];
function out(line: string): void {
  report.push(line);
  process.stdout.write(`${line}\n`);
}

function registryIndex(): Map<string, { provider: RegistryProvider; model: CachedModel }> {
  const registry = loadCoreRegistry();
  const index = new Map<string, { provider: RegistryProvider; model: CachedModel }>();
  for (const provider of registry.providers) {
    if (!provider.enabled) continue;
    for (const model of getProviderModels(provider)) {
      index.set(`${provider.id}::${model.id}`, { provider, model });
    }
  }
  return index;
}

/** The riskiest rung: the highest advertised level that is not an off-switch. */
function topRung(levels: readonly string[]): string | undefined {
  const usable = levels.filter(level => level !== 'none' && level !== 'off');
  if (usable.length === 0) return undefined;
  return [...usable].sort((a, b) => EFFORT_RANK.indexOf(b) - EFFORT_RANK.indexOf(a))[0];
}

interface Attempt {
  providerId: string;
  modelId: string;
  routeId: string;
  level: string;
  levels: string[];
}

function plan(): Attempt[] {
  const filter = (process.env['REASONING_LIVE_FILTER'] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const best = new Map<string, Attempt>();
  for (const descriptor of listRelayModels()) {
    const levels = descriptor.capabilities.reasoningLevels ?? [];
    if (descriptor.capabilities.reasoning !== 'adjustable' || levels.length < 2) continue;
    const level = topRung(levels);
    if (!level) continue;
    if (filter.length > 0 && !filter.includes(descriptor.providerId)) continue;
    const candidate: Attempt = {
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      routeId: descriptor.routeId,
      level,
      levels,
    };
    const current = best.get(descriptor.providerId);
    // Prefer a paid model (a free router tier can have its own quirks), then
    // the longest ladder — the model most exercised by the resolution rules.
    const isFree = (attempt: Attempt): number => (/free/i.test(attempt.modelId) ? 1 : 0);
    if (!current
      || isFree(candidate) < isFree(current)
      || (isFree(candidate) === isFree(current) && levels.length > current.levels.length)) {
      best.set(descriptor.providerId, candidate);
    }
  }
  return [...best.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

describe('live reasoning harness', () => {
  it('resolves every advertised level on every cached model (offline)', () => {
    const index = registryIndex();
    const failures: string[] = [];
    let checked = 0;
    for (const descriptor of listRelayModels()) {
      const levels = descriptor.capabilities.reasoningLevels ?? [];
      if (descriptor.capabilities.reasoning !== 'adjustable' || levels.length === 0) continue;
      const entry = index.get(`${descriptor.providerId}::${descriptor.modelId}`);
      if (!entry) {
        failures.push(`${descriptor.routeId}: advertised levels but missing from the registry index`);
        continue;
      }
      for (const level of levels) {
        checked += 1;
        try {
          const options = resolveReasoningProviderOptions(
            level as RelayReasoningLevel,
            entry.provider,
            entry.model,
            descriptor.routeId,
          );
          if (!options || Object.keys(options).length === 0) {
            failures.push(`${descriptor.routeId}/${level}: resolved to an empty payload`);
          }
        } catch (error) {
          failures.push(`${descriptor.routeId}/${level}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    out(`phase 1: ${checked} advertised level(s) across the real registry resolved to wire payloads`);
    for (const failure of failures) out(`  FAIL ${failure}`);
    expect(failures).toEqual([]);
  });

  it('accepts the top advertised rung on every live provider (network)', async () => {
    const attempts = plan();
    const filter = (process.env['REASONING_LIVE_FILTER'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const runLive = process.env['REASONING_LIVE_ALL'] === '1' || filter.length > 0;
    out('phase 2 plan:');
    for (const attempt of attempts) {
      out(`  ${attempt.providerId.padEnd(16)} ${attempt.modelId}  levels=[${attempt.levels.join(',')}]  testing=${attempt.level}`);
    }
    if (!runLive || attempts.length === 0) {
      out('live calls skipped — set REASONING_LIVE_FILTER=<provider[,provider]> or REASONING_LIVE_ALL=1 to run them');
      writeFileSync('/tmp/relay-reasoning-live.txt', `${report.join('\n')}\n`);
      return;
    }

    const failures: string[] = [];
    for (const attempt of attempts) {
      const started = Date.now();
      try {
        const model = await createRelayModel(attempt.routeId, {
          reasoning: attempt.level as RelayReasoningLevel,
        });
        const result = streamText({
          model,
          prompt: 'Reply with the single word: ok',
          maxOutputTokens: 32,
          abortSignal: AbortSignal.timeout(60_000),
        });
        let text = '';
        for await (const delta of result.textStream) text += delta;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        out(`  ok    ${attempt.providerId.padEnd(16)} ${attempt.modelId} @ ${attempt.level} (${text.trim().length} chars, ${seconds}s)`);
      } catch (error) {
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as { statusCode?: number } | null)?.statusCode;
        const skip = status === 401 || status === 403 || status === 404 || status === 429
          || (typeof status === 'number' && status >= 500)
          || /CREDENTIAL_UNAVAILABLE|No credential available|OAuth token refresh failed|re-authenticate/i.test(message)
          || /abort|timeout|timed out|fetch failed|ECONN|ENOTFOUND|socket/i.test(message);
        const line = `${attempt.providerId.padEnd(16)} ${attempt.modelId} @ ${attempt.level}${status ? ` [HTTP ${status}]` : ''}: ${message.slice(0, 200)}`;
        if (skip) out(`  skip  ${line} (${seconds}s)`);
        else {
          out(`  FAIL  ${line} (${seconds}s)`);
          failures.push(line);
        }
      }
    }
    writeFileSync('/tmp/relay-reasoning-live.txt', `${report.join('\n')}\n`);
    out('full report: /tmp/relay-reasoning-live.txt');
    expect(failures).toEqual([]);
  }, 1_800_000);
});
