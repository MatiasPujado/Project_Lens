import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.LENS_BENCH_MODEL ?? 'claude-opus-5';

/**
 * `api` is the real measurement: Anthropic's count_tokens endpoint for the pinned model.
 * `messages` is the equally real measurement available to OAuth (Claude plan) credentials, which
 * count_tokens rejects outright — "jwt auth is not yet supported on count_tokens". It sends the
 * text through /v1/messages with max_tokens 1 and reads usage.input_tokens, so it is the same
 * tokenizer at the price of plan quota.
 * `bytes` is a deliberately degraded fallback for machines with no credentials at all — it counts
 * UTF-8 bytes, which is a usable proxy for MCP-vs-bash *ratios* but is not a token count and is
 * never silently substituted: it must be asked for, and every report it produces says so.
 */
export type Counter = 'api' | 'messages' | 'bytes';

/** Subscription (Pro/Max/Team/Enterprise) credentials, which are scoped to inference only. */
const oauthToken = (): string | undefined =>
  process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;

function selectCounter(): Counter {
  const forced = process.env.LENS_BENCH_COUNTER;
  if (forced === 'api' || forced === 'messages' || forced === 'bytes') return forced;
  if (forced !== undefined) fail(`LENS_BENCH_COUNTER="${forced}" is not one of api, messages, bytes.`);
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (oauthToken()) return 'messages';
  return fail(
    'No credentials for token counting.\n' +
      '  ANTHROPIC_API_KEY          exact counts via count_tokens, a free endpoint.\n' +
      '  CLAUDE_CODE_OAUTH_TOKEN    exact counts via /v1/messages, billed to your Claude plan.\n' +
      '  LENS_BENCH_COUNTER=bytes   no credentials, labelled UTF-8 byte comparison.\n' +
      'There is no third-party-tokenizer fallback on purpose: tiktoken and friends undercount ' +
      'Claude on JSON and paths, which is exactly what this benchmark measures.'
  );
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export const COUNTER: Counter = selectCounter();
export const UNIT = COUNTER === 'bytes' ? 'bytes' : 'tokens';

const cachePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../benchmark/.token-cache.json'
);

type Cache = Record<string, number>;

const cache: Cache = (() => {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as Cache;
  } catch {
    return {};
  }
})();
let dirty = false;

function anthropic(): Anthropic {
  if (COUNTER === 'api') return new Anthropic();
  return new Anthropic({ authToken: oauthToken() });
}

let lazyClient: Anthropic | null = null;
const client = (): Anthropic => (lazyClient ??= anthropic());

if (COUNTER !== 'bytes') client(); // fail before the benchmark spawns a server

async function count(text: string): Promise<number> {
  const messages = [{ role: 'user' as const, content: text }];
  if (COUNTER === 'api') {
    const { input_tokens } = await client().messages.countTokens({ model: MODEL, messages });
    return input_tokens;
  }
  const { usage } = await client().messages.create({ model: MODEL, max_tokens: 1, messages });
  return usage.input_tokens;
}

async function raw(text: string): Promise<number> {
  const key = `${COUNTER}:${MODEL}:${createHash('sha256').update(text).digest('hex')}`;
  const hit = cache[key];
  if (hit !== undefined) return hit;
  const tokens = await count(text);
  cache[key] = tokens;
  dirty = true;
  return tokens;
}

/**
 * The constant every `raw()` call carries on top of the content itself. Recovered by counting a
 * probe and its own concatenation: raw(P) = F + t(P) and raw(P+P) = F + 2·t(P), so F = 2·raw(P) −
 * raw(P+P). The probe is plain words ending in a space, so the two halves tokenize independently.
 */
const PROBE = 'the registry resolves a project name to its group path and absolute path '.repeat(4);

let framing: Promise<number> | null = null;

function framingOverhead(): Promise<number> {
  framing ??= Promise.all([raw(PROBE), raw(PROBE + PROBE)]).then(
    ([single, doubled]) => 2 * single - doubled
  );
  return framing;
}

export async function countTokens(text: string): Promise<number> {
  if (text === '') return 0;
  if (COUNTER === 'bytes') return Buffer.byteLength(text, 'utf8');
  const [total, overhead] = await Promise.all([raw(text), framingOverhead()]);
  return total - overhead;
}

export function flushCache(): void {
  if (dirty) writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
}
