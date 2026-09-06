import { Side } from "../models.js";

const GAMMA = "https://gamma-api.polymarket.com";

export interface Market {
  slug: string;
  conditionId: string;
  upToken: string;
  downToken: string;
  start: number;
  end: number;
}

export function marketToken(mkt: Market, side: Side): string {
  return side === Side.Up ? mkt.upToken : mkt.downToken;
}

function httpInit(): RequestInit {
  return {
    headers: { "User-Agent": "Mozilla/5.0 (btc-5m-live)" },
    signal: AbortSignal.timeout(10_000),
  };
}

export interface Candidate {
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
    return v.filter((x): x is string => typeof x === "string");
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function marketList(v: unknown): Record<string, JsonValue>[] {
  if (Array.isArray(v)) return v as Record<string, JsonValue>[];
  if (v && typeof v === "object" && "data" in v) {
    const data = (v as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, JsonValue>[];
  }
  return [];
}

/** Parse one Gamma market JSON into a Candidate. */
export function parseMarket(m: Record<string, JsonValue>): Candidate | undefined {
  const slugRaw = m.slug;
  if (typeof slugRaw !== "string") return undefined;
  const slug = slugRaw.toLowerCase();
  if (!slug.includes("btc-updown-5m")) return undefined;
  if (m.closed === true) return undefined;

  const toks =
    jsonOrStrArray(m.clobTokenIds) ?? jsonOrStrArray(m.clob_token_ids);
  if (!toks || toks.length < 2) return undefined;

  const outs = jsonOrStrArray(m.outcomes) ?? [];
  const parts = slug.split("-");
  const slugStart = Number.parseInt(parts[parts.length - 1] ?? "", 10);
  if (!Number.isFinite(slugStart)) return undefined;

  const upI =
    outs.length === 2 && ["down", "no"].includes(outs[0]?.trim().toLowerCase() ?? "")
      ? 1
      : 0;

  const conditionId =
    (typeof m.conditionId === "string" ? m.conditionId : undefined) ??
    (typeof m.condition_id === "string" ? m.condition_id : undefined) ??
    "";

  return {
    slug,
    slugStart,
    upToken: toks[upI]!,
    downToken: toks[1 - upI]!,
    conditionId,
  };
}

export function isWindowLive(slugStart: number, now: number): boolean {
  return slugStart <= now && now < slugStart + 300;
}

export function select(cands: Candidate[], now: number): Candidate | undefined {
  const seen = new Set<number>();
  const uniq = cands.filter((c) => {
    if (seen.has(c.slugStart)) return false;
    seen.add(c.slugStart);
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

function marketFrom(c: Candidate, fc: number): Market {
  return {
    slug: c.slug,
    conditionId: c.conditionId,
    upToken: c.upToken,
    downToken: c.downToken,
    start: fc,
    end: fc + 300,
  };
}

async function fetchBySlug(slug: string): Promise<Candidate | undefined> {
  const url = `${GAMMA}/markets?slug=${slug}`;
  const resp = await fetch(url, httpInit());
  if (!resp.ok) return undefined;
  const v = (await resp.json()) as unknown;
  return marketList(v)
    .map(parseMarket)
    .find((c): c is Candidate => c != null);
}

/** Fallback for environments where Gamma is unreachable but our Tokyo read-only
 * collector is available. This endpoint never places orders; it only supplies
 * the current market identifiers collected from Gamma in Tokyo. */
async function fetchFromTokyo(): Promise<Candidate | undefined> {
  const base = process.env.TOKYO_LIVE_URL ?? "http://127.0.0.1:8765/api/live";
  try {
    // The Tokyo collector is the low-latency source on the trading host. Keep
    // this probe short so a stale/unavailable dashboard cannot delay discovery.
    // The dashboard may need one SSH-backed refresh on a cold start. Allow it
    // to complete; later requests are served from the five-second cache.
    const resp = await fetch(base, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return undefined;
    const payload = (await resp.json()) as { collector_online?: boolean; current_markets?: Array<Record<string, unknown>> };
    if (payload.collector_online !== true) return undefined;
    const now = Math.floor(Date.now() / 1000);
    for (const item of payload.current_markets ?? []) {
      const slug = typeof item.slug === "string" ? item.slug : "";
      if (!slug.toLowerCase().includes("btc-updown-5m-")) continue;
      const upToken = typeof item.up_token === "string" ? item.up_token : "";
      const downToken = typeof item.down_token === "string" ? item.down_token : "";
      const start = Number(item.start);
      const end = Number(item.end);
      const quoteAt = typeof item.quote_at === "string" ? Date.parse(item.quote_at) : NaN;
      const quoteAgeSec = Number.isFinite(quoteAt) ? (Date.now() - quoteAt) / 1000 : Number.POSITIVE_INFINITY;
      if (slug && upToken && downToken && Number.isFinite(start) && Number.isFinite(end) &&
          start <= now && now < end && quoteAgeSec >= 0 && quoteAgeSec <= 20) {
        return {
          slug,
          slugStart: start,
          upToken,
          downToken,
          conditionId: typeof item.condition_id === "string" ? item.condition_id : "",
        };
      }
    }
  } catch (e) {
    console.warn("Tokyo market discovery failed:", e);
  }
  return undefined;
}

/** Discover the live market with a feed-clock-anchored 5-min window. */
export async function findMarket(
  now: number,
  allowTokyoFallback = true,
): Promise<Market | undefined> {
  const fc = Math.floor(now / 300) * 300;
  const slug = `btc-updown-5m-${fc}`;

  // Paper mode may use the nearby Tokyo collector for instant discovery.
  // Live mode passes allowTokyoFallback=false and never takes this branch.
  if (allowTokyoFallback) {
    const tokyo = await fetchFromTokyo();
    if (tokyo && isWindowLive(tokyo.slugStart, now)) {
      return marketFrom(tokyo, tokyo.slugStart);
    }
  }

  let direct: Candidate | undefined;
  try {
    direct = await fetchBySlug(slug);
  } catch (e) {
    console.warn("Gamma direct discovery failed:", e);
  }
  if (direct && isWindowLive(direct.slugStart, now)) {
    return marketFrom(direct, fc);
  }

  const urls = [
    `${GAMMA}/markets?closed=false&limit=500&order=startDate&ascending=false`,
    `${GAMMA}/markets?active=true&limit=500`,
  ];

  const cands: Candidate[] = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url, httpInit());
      if (!resp.ok) continue;
      const v = (await resp.json()) as unknown;
      for (const m of marketList(v)) {
        const c = parseMarket(m);
        if (c) cands.push(c);
      }
    } catch (e) {
      console.warn("gamma discovery failed:", e);
    }
  }

  const picked = select(cands, now);
  if (!picked) return undefined;

  if (!isWindowLive(picked.slugStart, now)) {
    const delta = Math.round(picked.slugStart - now);
    console.warn(
      `no live btc-updown-5m market: nearest start=${picked.slugStart} (${Math.abs(delta)}s ${delta > 0 ? "ahead" : "ago"}) — idling`,
    );
    return undefined;
  }

  return marketFrom(picked, fc);
}
