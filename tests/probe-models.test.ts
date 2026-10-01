import { describe, expect, it } from 'vitest';
import {
  filterModelsByAvailability,
  type ProbeVerdict,
} from '../src/registry/probe-models.js';
import type { CachedModel } from '../src/registry/types.js';

function model(id: string, isFree = false): CachedModel {
  return { id, name: id, upstreamModelId: id, modelFormat: 'openai', isFree };
}

const bodyId = (body: unknown): string => (body as { id: string }).id;

describe('filterModelsByAvailability', () => {
  it('removes only explicitly unavailable models and keeps everything else in order', async () => {
    const models = [model('a'), model('b'), model('c'), model('d')];
    const verdicts: Record<string, ProbeVerdict> = {
      a: 'available',
      b: 'unavailable',
      c: 'unknown',
      d: 'unavailable',
    };

    const outcome = await filterModelsByAvailability(models, {
      label: 'test',
      probe: async item => ({ status: 200, body: { id: item.id } }),
      classify: (_status, body) => verdicts[bodyId(body)]!,
    });

    expect(outcome.models.map(item => item.id)).toEqual(['a', 'c']);
    expect(outcome.removedIds).toEqual(['b', 'd']);
    expect(outcome.aborted).toBe(false);
  });

  it('probes only the models the filter selects', async () => {
    const probed: string[] = [];

    const outcome = await filterModelsByAvailability([model('paid'), model('free', true)], {
      label: 'test',
      select: item => item.isFree === true,
      probe: async item => {
        probed.push(item.id);
        return { status: 200, body: null };
      },
      classify: () => 'available',
    });

    expect(probed).toEqual(['free']);
    expect(outcome.models.map(item => item.id)).toEqual(['paid', 'free']);
  });

  it('aborts the pass and removes nothing, even after an earlier rejection', async () => {
    const probed: string[] = [];
    const verdicts: Record<string, ProbeVerdict> = { a: 'unavailable', b: 'abort', c: 'available' };

    const outcome = await filterModelsByAvailability([model('a'), model('b'), model('c')], {
      label: 'test',
      probe: async item => {
        probed.push(item.id);
        return { status: 200, body: { id: item.id } };
      },
      classify: (_status, body) => verdicts[bodyId(body)]!,
    });

    expect(outcome.aborted).toBe(true);
    expect(outcome.models.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(outcome.removedIds).toEqual([]);
    // The model after the abort signal is never probed.
    expect(probed).toEqual(['a', 'b']);
  });

  it('treats probe transport failures as unknown and keeps the model', async () => {
    const outcome = await filterModelsByAvailability([model('a')], {
      label: 'test',
      probe: async () => {
        throw new Error('network down');
      },
      classify: () => 'unavailable',
    });

    expect(outcome.models.map(item => item.id)).toEqual(['a']);
    expect(outcome.removedIds).toEqual([]);
    expect(outcome.aborted).toBe(false);
  });

  it('returns the catalog untouched when nothing is selected', async () => {
    const probed: string[] = [];
    const outcome = await filterModelsByAvailability([model('a')], {
      label: 'test',
      select: () => false,
      probe: async item => {
        probed.push(item.id);
        return { status: 200, body: null };
      },
      classify: () => 'unavailable',
    });

    expect(probed).toEqual([]);
    expect(outcome.models.map(item => item.id)).toEqual(['a']);
  });
});
