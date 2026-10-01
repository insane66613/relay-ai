// src/registry/probe-models.ts — shared per-model availability probing

import type { CachedModel } from './types.js';

/**
 * Some providers gate models by subscription plan or by client identity
 * ("product surfaces") and do not report entitlements through any endpoint.
 * The only reliable signal is a minimal generation per candidate model,
 * classified by the caller. This module owns the shared runner so every
 * provider probe (Command Code plan gating, ClinePass free models, future
 * cases) behaves the same way.
 *
 * Verdicts:
 *   available   — the credential can use the model; keep it listed.
 *   unavailable — an explicit gate rejection; remove it from the catalog.
 *   unknown     — transport failures and ambiguous responses; keep it listed.
 *   abort       — account-level condition (no subscription, rejected
 *                 credential). Stop probing and treat the pass as untrusted:
 *                 nothing is removed, so the catalog stays as fetched until
 *                 the next run.
 */
export type ProbeVerdict = 'available' | 'unavailable' | 'unknown' | 'abort';

export type ProbeClassification = ProbeVerdict | { verdict: ProbeVerdict; detail?: string };

export interface ProbeResponse {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  body: unknown;
}

export interface ModelAvailabilityProbe {
  /** Short label used in trace lines, e.g. 'cline-free'. */
  label: string;
  /** Only probe models that pass this filter. Defaults to every model. */
  select?: (model: CachedModel) => boolean;
  /** Max in-flight probes. Defaults to 1 (gentle; some providers dislike concurrency). */
  concurrency?: number;
  /** Delay between probe starts in ms. Defaults to 0. */
  gapMs?: number;
  /** Perform one minimal request for a model. May throw; the runner treats it as unknown. */
  probe: (model: CachedModel) => Promise<ProbeResponse>;
  classify: (status: number, body: unknown) => ProbeClassification;
  trace?: (message: string) => void;
}

export interface ModelAvailabilityOutcome {
  /** The catalog with unavailable models removed (unchanged when aborted). */
  models: CachedModel[];
  removedIds: string[];
  aborted: boolean;
  abortDetail?: string;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function filterModelsByAvailability(
  models: CachedModel[],
  spec: ModelAvailabilityProbe,
): Promise<ModelAvailabilityOutcome> {
  const targets: Array<{ model: CachedModel; index: number }> = [];
  models.forEach((model, index) => {
    if (!spec.select || spec.select(model)) targets.push({ model, index });
  });
  if (targets.length === 0) return { models, removedIds: [], aborted: false };

  const concurrency = Math.max(1, Math.min(spec.concurrency ?? 1, targets.length));
  const gapMs = Math.max(0, spec.gapMs ?? 0);
  const removedIndexes = new Set<number>();
  let next = 0;
  let started = 0;
  let aborted = false;
  let abortDetail: string | undefined;

  const run = async (): Promise<void> => {
    while (!aborted) {
      const slot = targets[next++];
      if (!slot) return;
      if (gapMs > 0 && started++ > 0) await sleep(gapMs);

      let classification: ProbeClassification;
      let status = 0;
      try {
        const response = await spec.probe(slot.model);
        status = response.status;
        classification = spec.classify(response.status, response.body);
      } catch {
        classification = 'unknown';
      }
      const verdict = typeof classification === 'string' ? classification : classification.verdict;
      const detail = typeof classification === 'string' ? undefined : classification.detail;
      spec.trace?.(`[probe:${spec.label}] ${slot.model.id} -> ${verdict} (HTTP ${status})${detail ? ` ${detail}` : ''}`);

      if (verdict === 'abort') {
        aborted = true;
        abortDetail = detail ?? `account-level rejection on ${slot.model.id}`;
        return;
      }
      if (verdict === 'unavailable') removedIndexes.add(slot.index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, run));

  if (aborted) {
    spec.trace?.(`[probe:${spec.label}] aborted (${abortDetail}) — catalog kept unchanged`);
    return { models, removedIds: [], aborted: true, abortDetail };
  }

  const removedIds = [...removedIndexes].sort((a, b) => a - b).map(index => models[index]!.id);
  if (removedIds.length > 0) {
    spec.trace?.(`[probe:${spec.label}] removed ${removedIds.length} of ${targets.length}: ${removedIds.join(', ')}`);
  }
  return {
    models: models.filter((_, index) => !removedIndexes.has(index)),
    removedIds,
    aborted: false,
  };
}
