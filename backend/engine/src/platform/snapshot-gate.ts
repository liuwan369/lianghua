import type { MarketBookSnapshot, RuntimeMarketAssetSnapshot } from "./contracts.js";

export type SnapshotRejectReason =
  | "market_id_mismatch"
  | "round_id_mismatch"
  | "sequence_invalid"
  | "sequence_regression"
  | "expired_snapshot"
  | "round_ended"
  | "book_unhealthy"
  | "incomplete_book"
  | "invalid_yes_quote"
  | "invalid_no_quote"
  | "source_at_regression";

export interface SnapshotGateIdentity {
  marketId: string;
  roundId: string;
  endsAt: number;
  yesAssetId: string;
  noAssetId: string;
}

export interface SnapshotWatermark {
  sequence: number;
  sourceAt: number;
  yesSourceAt: number;
  noSourceAt: number;
}

export type SnapshotGateResult =
  | { ok: true; watermark: SnapshotWatermark }
  | { ok: false; reason: SnapshotRejectReason };

function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validSourceAt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validAsset(asset: RuntimeMarketAssetSnapshot | undefined, assetId: string, now: number): boolean {
  return !!asset && asset.assetId === assetId
    && validPrice(asset.bid) && validPrice(asset.ask) && asset.bid <= asset.ask
    && Number.isSafeInteger(asset.sequence) && asset.sequence! >= 0
    && validSourceAt(asset.sourceAt) && Number.isFinite(asset.expiresAt)
    && asset.expiresAt! > now;
}

/** Validate a paired snapshot without mutating runtime state. */
export function validateMarketSnapshot(
  snapshot: MarketBookSnapshot,
  identity: SnapshotGateIdentity,
  previous: SnapshotWatermark | undefined,
  now: number,
  healthy: boolean,
): SnapshotGateResult {
  if (snapshot.marketId !== identity.marketId) return { ok: false, reason: "market_id_mismatch" };
  if (snapshot.roundId !== identity.roundId) return { ok: false, reason: "round_id_mismatch" };
  if (now >= identity.endsAt) return { ok: false, reason: "round_ended" };
  if (!healthy) return { ok: false, reason: "book_unhealthy" };
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence! < 0) {
    return { ok: false, reason: "sequence_invalid" };
  }
  if (previous && snapshot.sequence! <= previous.sequence) {
    return { ok: false, reason: "sequence_regression" };
  }
  if (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt! <= now
    || !Number.isFinite(snapshot.sourceAt) || snapshot.sourceAt! < 0) {
    return { ok: false, reason: "expired_snapshot" };
  }
  const yes = snapshot.YES;
  const no = snapshot.NO;
  if (!validAsset(yes, identity.yesAssetId, now)) return { ok: false, reason: "invalid_yes_quote" };
  if (!validAsset(no, identity.noAssetId, now)) return { ok: false, reason: "invalid_no_quote" };
  if (yes!.sequence !== snapshot.sequence || no!.sequence !== snapshot.sequence) {
    return { ok: false, reason: "sequence_invalid" };
  }
  if (previous && (snapshot.sourceAt! < previous.sourceAt
    || yes!.sourceAt! < previous.yesSourceAt || no!.sourceAt! < previous.noSourceAt)) {
    return { ok: false, reason: "source_at_regression" };
  }
  return { ok: true, watermark: {
    sequence: snapshot.sequence!, sourceAt: snapshot.sourceAt!,
    yesSourceAt: yes!.sourceAt!, noSourceAt: no!.sourceAt!,
  } };
}
