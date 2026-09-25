import { Side } from "../models.js";

const GAMMA = "https://gamma-api.polymarket.com";
export const DEFAULT_MARKET_ASSET = "btc";
const FIVE_MINUTES_SEC = 300;

/** Normalize the platform symbol used in five-minute market slugs. */
export function normalizeMarketAsset(asset = DEFAULT_MARKET_ASSET): string {
  const normalized = asset.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized)) {
    throw new Error("market asset must contain only letters and digits");
  }
  return normalized;
}

export function fiveMinuteMarketSlug(asset: string, roundStart: number): string {
  const normalized = normalizeMarketAsset(asset);
  if (!Number.isSafeInteger(roundStart) || roundStart < 0 || roundStart % FIVE_MINUTES_SEC !== 0) {
    throw new Error("roundStart must be a non-negative five-minute Unix boundary");
  }
  return `${normalized}-updown-5m-${roundStart}`;
}

export interface Market {
  /** Lowercase platform symbol encoded in the market slug, e.g. btc or eth. */
  asset: string;
  slug: string;
  conditionId: string;
  /** Five-minute round identity, equal to the Unix start boundary. */
  roundId: string;
  upToken: string;
  downToken: string;
  start: number;
  end: number;
}

export function marketToken(mkt: Market, side: Side): string {
  return side === Side.Up ? mkt.upToken : mkt.downToken;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function httpInit(signal?: AbortSignal): RequestInit {
  return {
    headers: { "User-Agent": "Mozilla/5.0 (polymarket-5m-live)" },
    signal: requestSignal(signal, 10_000),
  };
}

export interface Candidate {
  asset: string;
  slug: string;
  slugStart: number;
  upToken: string;
  downToken: string;
  conditionId: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function jsonOrStrArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    return v.every((x): x is string => typeof x === "string") ? v : undefined;
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.every((x): x is string => typeof x === "string") ? parsed : undefined;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function marketList(v: unknown): Record<string, JsonValue>[] {
  const records = (items: unknown[]): Record<string, JsonValue>[] => items.filter((item): item is Record<string, JsonValue> =>
    item != null && typeof item === "object" && !Array.isArray(item));
  if (Array.isArray(v)) return records(v);
  if (v && typeof v === "object" && "data" in v) {
    const data = (v as { data?: unknown }).data;
    if (Array.isArray(data)) return records(data);
  }
  return [];
}

/** Parse one Gamma market JSON into a Candidate. */
export function parseMarket(m: Record<string, JsonValue> | null | undefined, asset = DEFAULT_MARKET_ASSET): Candidate | undefined {
  if (m == null || typeof m !== "object" || Array.isArray(m)) return undefined;
  const normalizedAsset = normalizeMarketAsset(asset);
  const slugRaw = m.slug;
  if (typeof slugRaw !== "string") return undefined;
  const slug = slugRaw.toLowerCase();
  const prefix = `${normalizedAsset}-updown-5m-`;
  if (!slug.startsWith(prefix)) return undefined;
  const roundRaw = slug.slice(prefix.length);
  if (!/^\d+$/.test(roundRaw)) return undefined;
  if (m.closed === true) return undefined;

  const toks =
    jsonOrStrArray(m.clobTokenIds) ?? jsonOrStrArray(m.clob_token_ids);
  const tokenValues = toks?.map(value => value.trim());
  if (!tokenValues || tokenValues.length !== 2 || !tokenValues[0] || !tokenValues[1] || tokenValues[0] === tokenValues[1]) return undefined;

  const outs = jsonOrStrArray(m.outcomes) ?? [];
  const labels = outs.map(value => value.trim().toLowerCase());
  const upI = labels.findIndex(value => value === "up" || value === "yes");
  const downI = labels.findIndex(value => value === "down" || value === "no");
  if (labels.length !== 2 || upI < 0 || downI < 0 || upI === downI) return undefined;
  const slugStart = Number.parseInt(roundRaw, 10);
  if (!Number.isSafeInteger(slugStart) || slugStart < 0 || slugStart % FIVE_MINUTES_SEC !== 0) return undefined;

  const conditionId = [m.conditionId, m.condition_id]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
  if (!conditionId) return undefined;

  return {
    asset: normalizedAsset,
    slug,
    slugStart,
    upToken: tokenValues[upI]!,
    downToken: tokenValues[1 - upI]!,
    conditionId,
  };
}

export function isWindowLive(slugStart: number, now: number): boolean {
  return slugStart <= now && now < slugStart + 300;
}

export function select(cands: Candidate[], now: number): Candidate | undefined {
  const seen = new Set<string>();
  const uniq = cands.filter((c) => {
    const key = `${c.asset}:${c.slugStart}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniq.length === 0) return undefined;

  const live = uniq.filter((c) => isWindowLive(c.slugStart, now));
  if (live.length > 0) {
    return live.reduce((a, b) => (a.slugStart >= b.slugStart ? a : b));
  }

  return uniq.reduce((best, c) => {
    const da = Math.abs(c.slugStart - now);
    const db = Math.abs(best.slugStart - now);
    return da <= db ? c : best;
  });
}

function marketFrom(c: Candidate): Market {
  return {
    asset: c.asset,
    slug: c.slug,
    conditionId: c.conditionId,
    roundId: String(c.slugStart),
    upToken: c.upToken,
    downToken: c.downToken,
    start: c.slugStart,
    end: c.slugStart + 300,
  };
}

async function fetchBySlug(slug: string, asset: string, signal?: AbortSignal): Promise<Candidate | undefined> {
  const url = `${GAMMA}/markets?slug=${slug}`;
  const resp = await fetch(url, httpInit(signal));
  if (!resp.ok) return undefined;
  const v = (await resp.json()) as unknown;
  return marketList(v)
    .map(m => parseMarket(m, asset))
    .find((c): c is Candidate => c != null);
}

/** Fallback for environments where Gamma is unreachable but our local read-only
 * collector is available. This endpoint never places orders; it only supplies
 * the current market identifiers collected from Gamma. */
async function fetchFromCollector(asset: string, signal?: AbortSignal): Promise<Candidate | undefined> {
  const base = process.env.PM_LIVE_URL ?? "http://127.0.0.1:8765/api/live";
  try {
    // The local collector is the low-latency source on the trading host. Keep
    // this probe short so a stale/unavailable dashboard cannot delay discovery.
    // The dashboard may need one SSH-backed refresh on a cold start. Allow it
    // to complete; later requests are served from the five-second cache.
    const resp = await fetch(base, { signal: requestSignal(signal, 30_000) });
    if (!resp.ok) return undefined;
    const payload = (await resp.json()) as { collector_online?: boolean; current_markets?: Array<Record<string, unknown>> };
    if (payload.collector_online !== true) return undefined;
    const now = Math.floor(Date.now() / 1000);
    const prefix = `${asset}-updown-5m-`;
    for (const item of payload.current_markets ?? []) {
      const slug = typeof item.slug === "string" ? item.slug : "";
      const normalizedSlug = slug.toLowerCase();
      if (!normalizedSlug.startsWith(prefix)) continue;
      const upToken = typeof item.up_token === "string" ? item.up_token : "";
      const downToken = typeof item.down_token === "string" ? item.down_token : "";
      const start = Number(item.start);
      const end = Number(item.end);
      const roundRaw = normalizedSlug.slice(prefix.length);
      const quoteAt = typeof item.quote_at === "string" ? Date.parse(item.quote_at) : NaN;
      const quoteAgeSec = Number.isFinite(quoteAt) ? (Date.now() - quoteAt) / 1000 : Number.POSITIVE_INFINITY;
      const conditionId = typeof item.condition_id === "string" ? item.condition_id : "";
      if (/^\d+$/.test(roundRaw) && slug && upToken && downToken && upToken !== downToken && conditionId && Number.isSafeInteger(start) &&
          Number.isFinite(end) && end - start === FIVE_MINUTES_SEC && start === Number(roundRaw) &&
          start % FIVE_MINUTES_SEC === 0 &&
          start <= now && now < end && quoteAgeSec >= 0 && quoteAgeSec <= 20) {
        return {
          asset,
          slug,
          slugStart: start,
          upToken,
          downToken,
          conditionId,
        };
      }
    }
  } catch (e) {
    signal?.throwIfAborted();
    console.warn("Collector market discovery failed:", e);
  }
  return undefined;
}

export interface FindMarketOptions {
  now?: number;
  allowCollectorFallback?: boolean;
  directOnly?: boolean;
  signal?: AbortSignal;
}

/** Discover one asset's live five-minute market with a feed-clock-anchored window. */
export async function findFiveMinuteMarket(
  asset: string,
  options: FindMarketOptions = {},
): Promise<Market | undefined> {
  const normalizedAsset = normalizeMarketAsset(asset);
  const now = options.now ?? Date.now() / 1000;
  const allowCollectorFallback = options.allowCollectorFallback ?? true;
  const directOnly = options.directOnly ?? false;
  const signal = options.signal;
  signal?.throwIfAborted();
  const fc = Math.floor(now / FIVE_MINUTES_SEC) * FIVE_MINUTES_SEC;
  const slug = fiveMinuteMarketSlug(normalizedAsset, fc);

  // Collector fallback is an operator-selected discovery source.
  if (allowCollectorFallback) {
    const collector = await fetchFromCollector(normalizedAsset, signal);
    if (collector && isWindowLive(collector.slugStart, now)) {
      return marketFrom(collector);
    }
  }

  let direct: Candidate | undefined;
  try {
    direct = await fetchBySlug(slug, normalizedAsset, signal);
  } catch (e) {
    signal?.throwIfAborted();
    console.warn("Gamma direct discovery failed:", e);
  }
  if (direct && isWindowLive(direct.slugStart, now)) {
    return marketFrom(direct);
  }

  // Boundary prewarm probes only the deterministic next slug. Do not fan out
  // to the two large Gamma listings until the normal discovery path runs.
  if (directOnly) return undefined;

  const urls = [
    `${GAMMA}/markets?closed=false&limit=500&order=startDate&ascending=false`,
    `${GAMMA}/markets?active=true&limit=500`,
  ];

  const cands: Candidate[] = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url, httpInit(signal));
      if (!resp.ok) continue;
      const v = (await resp.json()) as unknown;
      for (const m of marketList(v)) {
        const c = parseMarket(m, normalizedAsset);
        if (c) cands.push(c);
      }
    } catch (e) {
      signal?.throwIfAborted();
      console.warn("gamma discovery failed:", e);
    }
  }

  const picked = select(cands, now);
  if (!picked) return undefined;

  if (!isWindowLive(picked.slugStart, now)) {
    const delta = Math.round(picked.slugStart - now);
    console.warn(
      `no live ${normalizedAsset}-updown-5m market: nearest start=${picked.slugStart} (${Math.abs(delta)}s ${delta > 0 ? "ahead" : "ago"}) — idling`,
    );
    return undefined;
  }

  return marketFrom(picked);
}

/** Backward-compatible BTC discovery entry point used by existing callers. */
export async function findMarket(
  now: number,
  allowCollectorFallback = true,
  directOnly = false,
  signal?: AbortSignal,
  asset = DEFAULT_MARKET_ASSET,
): Promise<Market | undefined> {
  return findFiveMinuteMarket(asset, { now, allowCollectorFallback, directOnly, signal });
}
