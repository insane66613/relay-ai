import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCloudCodeFetch } from '../src/core/antigravity-model.js';

const url = 'https://sdk.local/v1beta/models/m:streamGenerateContent?alt=sse';
const body = (last = 'last') => JSON.stringify({
  systemInstruction: { parts: [{ text: 'private-system' }] },
  tools: [{ functionDeclarations: [{ name: 'private-tool', parameters: { type: 'object' } }] }],
  contents: [{ role: 'user', parts: [{ text: 'stable-あ' }] }, { role: 'user', parts: [{ text: last }] }],
});
const event = (usage: Record<string, unknown>) => `data: ${JSON.stringify({ response: { usageMetadata: usage } })}\r\n\r\n`;
const lines = (logs: string[], kind: string) => logs.filter(line => line.includes(` ${kind} `))
  .map(line => JSON.parse(line.slice(line.indexOf('{'))));

function transport(fetchImpl: typeof fetch, logs?: string[]) {
  return createCloudCodeFetch({
    modelId: 'gemini-test', accessToken: 'private-token', projectId: 'private-project',
    ...(logs ? { onDebug: message => logs.push(message) } : {}),
  }, fetchImpl);
}

describe('Cloud Code cache diagnostics', () => {
  it('compares section and contents-prefix hashes without exposing content', async () => {
    const logs: string[] = [];
    const run = transport(async () => new Response(event({ cachedContentTokenCount: 0 })), logs);
    await (await run(url, { body: body('first') })).text();
    await (await run(url, { body: body('second') })).text();
    const [a, b] = lines(logs, 'fingerprint');
    expect(a.sections.systemInstruction).toEqual(b.sections.systemInstruction);
    expect(a.sections.tools).toEqual(b.sections.tools);
    expect(a.toolCount).toBe(1);
    expect(a.contentsCount).toBe(2);
    expect(a.contents[0].prefixHash).toBe(b.contents[0].prefixHash);
    expect(a.contents[1].prefixHash).not.toBe(b.contents[1].prefixHash);
    expect(a.sections.toolConfig).toEqual({ present: false });
    expect(a.keyOrder).toEqual(['systemInstruction', 'tools', 'contents']);
    for (const secret of ['private-system', 'private-tool', 'private-token', 'private-project', 'stable-あ']) {
      expect(logs.join('\n')).not.toContain(secret);
    }
  });

  it.each([undefined, 0, 16000])('preserves raw cache field %s through split SSE bytes', async cached => {
    const logs: string[] = [];
    const usage = { promptTokenCount: 18000, thoughtsTokenCount: 12, ...(cached === undefined ? {} : { cachedContentTokenCount: cached }) };
    const bytes = new TextEncoder().encode(event(usage));
    const run = transport(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 31));
        controller.enqueue(bytes.slice(31));
        controller.close();
      },
    })), logs);
    const response = await run(url, { body: body() });
    expect(await response.text()).toContain(JSON.stringify(usage));
    const [end] = lines(logs, 'end');
    expect(end.outcome).toBe('completed');
    expect(end.usage.cachedContentTokenCount).toEqual(cached === undefined ? { present: false } : { present: true, value: cached });
    expect(end.usage.promptTokenCount).toEqual({ present: true, value: 18000 });
    expect(end.firstBodyByteMs).toBeGreaterThanOrEqual(0);
    expect(end.elapsedMs).toBeGreaterThanOrEqual(end.firstBodyByteMs);
  });

  it('records unary usage and leaves the response intact', async () => {
    const logs: string[] = [];
    const run = transport(async () => Response.json({ response: { usageMetadata: { cachedContentTokenCount: 8 } } }), logs);
    expect(await (await run(url.replace('streamGenerateContent', 'generateContent'), { body: body() })).json())
      .toEqual({ usageMetadata: { cachedContentTokenCount: 8 } });
    expect(lines(logs, 'end')[0].usage.cachedContentTokenCount).toEqual({ present: true, value: 8 });
  });

  it('correlates concurrent calls and numbers all failover and refresh attempts', async () => {
    const logs: string[] = [];
    const attempts = new Map<string, number>();
    const run = createCloudCodeFetch({
      modelId: 'm', accessToken: 'private-token', projectId: 'private-project',
      refreshToken: async () => 'private-new-token', onDebug: line => logs.push(line),
    }, async (_url, init) => {
      const id = JSON.parse(String(init?.body)).requestId;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (attempt === 1) return new Response('', { status: 503 });
      if (attempt === 2) return new Response('', { status: 401 });
      return new Response(event({ cachedContentTokenCount: 16000 }));
    });
    await Promise.all(['a', 'b'].map(async last => (await run(url, { body: body(last) })).text()));
    const ids = new Set(logs.map(line => /call=([^ ]+)/.exec(line)?.[1]));
    expect(ids.size).toBe(2);
    expect(ids.has(undefined)).toBe(false);
    for (const id of ids) {
      const requests = logs.filter(line => line.includes(`call=${id} `) && line.includes(' request '));
      expect(requests).toHaveLength(3);
      requests.forEach((line, i) => expect(line).toContain(`attempt=${i + 1} `));
    }
  });

  it('propagates stream errors while reporting failure without error text', async () => {
    const logs: string[] = [];
    let sent = false;
    const run = transport(async () => new Response(new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(event({ promptTokenCount: 10 }))); }
        else controller.error(new Error('private-error-body'));
      },
    })), logs);
    await expect((await run(url, { body: body() })).text()).rejects.toThrow('private-error-body');
    expect(lines(logs, 'end')[0].outcome).toBe('failed');
    expect(logs.join('\n')).not.toContain('private-error-body');
  });

  it('reports consumer cancellation and cancels the upstream body', async () => {
    const logs: string[] = [];
    const cancel = vi.fn();
    const run = transport(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')); }, cancel,
    })), logs);
    const reader = (await run(url, { body: body() })).body!.getReader();
    await reader.read();
    await reader.cancel('private-reason');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(lines(logs, 'end')).toHaveLength(1);
    expect(lines(logs, 'end')[0].outcome).toBe('cancelled');
    expect(logs.join('\n')).not.toContain('private-reason');
  });

  it('does not let a throwing debug callback break generation', async () => {
    const run = createCloudCodeFetch({
      modelId: 'm', accessToken: 't', projectId: 'p', onDebug: () => { throw new Error('logger failed'); },
    }, async () => new Response(event({ cachedContentTokenCount: 8 })));
    expect(await (await run(url, { body: body() })).text()).toContain('cachedContentTokenCount');
  });

  it('keeps arbitrary request keys and malformed usage values out of diagnostics', async () => {
    const logs: string[] = [];
    const run = transport(async () => new Response(event({ cachedContentTokenCount: 'private-account', thoughtsTokenCount: { text: 'private-response' } })), logs);
    await (await run(url, { body: JSON.stringify({ 'private-key': 'private-value', contents: [] }) })).text();
    expect(lines(logs, 'fingerprint')[0].keyOrder).toEqual(['[other]', 'contents']);
    expect(lines(logs, 'end')[0].usage.cachedContentTokenCount).toEqual({ present: true, valid: false });
    for (const secret of ['private-account', 'private-response', 'private-key', 'private-value']) {
      expect(logs.join('\n')).not.toContain(secret);
    }
  });

  it('preserves the same response and upstream envelope with diagnostics disabled', async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { requestId: _id, ...envelope } = JSON.parse(String(init?.body));
      sent.push(envelope);
      return new Response(event({ cachedContentTokenCount: 16000 }) + 'data: [DONE]\n\n');
    };
    const plain = transport(fetchImpl);
    const debug = transport(fetchImpl, []);
    expect(await (await plain(url, { body: body() })).text()).toBe(await (await debug(url, { body: body() })).text());
    expect(sent[0]).toEqual(sent[1]);
  });

  it('reports an abort after headers exactly once and removes the signal listener', async () => {
    const logs: string[] = [];
    const abort = new AbortController();
    const removed = vi.spyOn(abort.signal, 'removeEventListener');
    const run = transport(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')); },
    })), logs);
    const reader = (await run(url, { body: body(), signal: abort.signal })).body!.getReader();
    await reader.read();
    abort.abort(new Error('private-abort-reason'));
    await reader.cancel();
    expect(lines(logs, 'end')).toHaveLength(1);
    expect(lines(logs, 'end')[0].outcome).toBe('cancelled');
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(logs.join('\n')).not.toContain('private-abort-reason');
  });

  it.each(['failed', 'cancelled'])('reports %s before receiving response headers', async outcome => {
    const logs: string[] = [];
    const abort = new AbortController();
    const run = transport(async () => {
      if (outcome === 'cancelled') abort.abort();
      throw new Error('private-network-error');
    }, logs);
    await expect(run(url, { body: body(), signal: abort.signal })).rejects.toThrow();
    expect(lines(logs, 'end')).toHaveLength(1);
    expect(lines(logs, 'end')[0]).toMatchObject({ outcome, phase: 'fetch' });
    expect(logs.join('\n')).not.toContain('private-network-error');
  });

  it.each(['completed', 'cancelled'])('observes %s over real Node fetch and a loopback HTTP stream', async outcome => {
    const logs: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event({ promptTokenCount: 18000, cachedContentTokenCount: 16000 }));
        if (outcome === 'completed') res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const abort = new AbortController();
      const run = transport((_input, init) => fetch(`http://127.0.0.1:${port}/stream`, init), logs);
      const response = await run(url, { body: body(), signal: abort.signal });
      if (outcome === 'completed') {
        expect(await response.text()).toContain('"cachedContentTokenCount":16000');
      } else {
        const reader = response.body!.getReader();
        await reader.read();
        abort.abort();
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
        reader.releaseLock();
      }
      expect(lines(logs, 'end')).toHaveLength(1);
      expect(lines(logs, 'end')[0].outcome).toBe(outcome);
      expect(lines(logs, 'end')[0].usage.cachedContentTokenCount).toEqual({ present: true, value: 16000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
