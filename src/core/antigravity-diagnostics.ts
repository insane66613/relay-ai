// Opt-in observations at the Cloud Code wire boundary; never log bodies or identifiers.
import { createHash } from 'node:crypto';

const SECTION_NAMES = ['systemInstruction', 'tools', 'toolConfig', 'generationConfig'] as const;
const USAGE_NAMES = ['promptTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount'] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requestFingerprint(value: unknown): Record<string, unknown> {
  const body = record(value);
  const sections = Object.fromEntries(SECTION_NAMES.map(name => {
    const text = JSON.stringify(body[name]);
    return [name, text === undefined ? { present: false } : {
      present: true, bytes: Buffer.byteLength(text), hash: createHash('sha256').update(text).digest('hex').slice(0, 32),
    }];
  }));
  const prefix = createHash('sha256');
  const contents = (Array.isArray(body.contents) ? body.contents : []).map(item => {
    const text = JSON.stringify(item);
    const bytes = Buffer.byteLength(text);
    prefix.update(`${bytes}:`).update(text);
    return { bytes, prefixHash: prefix.copy().digest('hex').slice(0, 32) };
  });
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    // Unknown property names can contain caller data. Keep their position but hide their names.
    keyOrder: Object.keys(body).map(key => [...SECTION_NAMES, 'contents', 'safetySettings', 'cachedContent', 'labels'].includes(key) ? key : '[other]'),
    sections, contents, contentsCount: contents.length,
    toolCount: tools.reduce((count, tool) => {
      const declarations = record(tool).functionDeclarations;
      return count + (Array.isArray(declarations) ? declarations.length : 0);
    }, 0),
  };
}

/** Observe only bytes the downstream consumer reads. No tee, clone, or eager drain. */
export function observeCloudCodeBody(
  body: ReadableStream<Uint8Array> | null,
  streaming: boolean,
  log: (message: string) => void,
  startedAt: number,
  signal?: AbortSignal | null,
): ReadableStream<Uint8Array> | null {
  const decoder = new TextDecoder();
  let pending = '';
  let usage: Record<string, unknown> | undefined;
  let firstBodyByteMs: number | null = null;
  let finished = false;
  const inspect = (text: string) => {
    try {
      const parsed = record(JSON.parse(text));
      const response = 'response' in parsed ? record(parsed.response) : parsed;
      if (response.usageMetadata && typeof response.usageMetadata === 'object') {
        usage = record(response.usageMetadata);
      }
    } catch { /* malformed events and [DONE] are not usage metadata */ }
  };
  const inspectEvent = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (data) inspect(data);
  };
  const scan = (chunk?: Uint8Array) => {
    pending += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    if (!streaming) { if (!chunk) inspect(pending); return; }
    while (true) {
      const separator = /\r?\n\r?\n/.exec(pending);
      if (!separator) break;
      inspectEvent(pending.slice(0, separator.index));
      pending = pending.slice(separator.index + separator[0].length);
    }
    if (!chunk && pending) inspectEvent(pending);
  };
  const finish = (outcome: 'completed' | 'failed' | 'cancelled') => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', onAbort);
    log(`end ${JSON.stringify({
      outcome, elapsedMs: performance.now() - startedAt, firstBodyByteMs,
      usageMetadataPresent: usage !== undefined,
      usage: Object.fromEntries(USAGE_NAMES.map(name => {
        if (!usage || !Object.hasOwn(usage, name)) return [name, { present: false }];
        const value = usage[name];
        // Never echo arbitrary strings/objects even if the upstream puts them in a usage field.
        return [name, typeof value === 'number' && Number.isFinite(value)
          ? { present: true, value } : { present: true, valid: false }];
      })),
    })}`);
    pending = '';
  };
  const onAbort = () => finish('cancelled');
  if (!body) { finish('completed'); return null; }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (!finished) scan();
          finish('completed');
          reader.releaseLock();
          controller.close();
        } else {
          if (!finished) {
            firstBodyByteMs ??= performance.now() - startedAt;
            scan(value);
          }
          controller.enqueue(value);
        }
      } catch (err) {
        finish(signal?.aborted ? 'cancelled' : 'failed');
        reader.releaseLock();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish('cancelled');
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
}
