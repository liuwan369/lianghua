export enum Side {
  Up = "Up",
  Down = "Down",
}

export namespace Side {
  export function other(s: Side): Side {
    return s === Side.Up ? Side.Down : Side.Up;
  }

  export function asStr(s: Side): string {
    return s === Side.Up ? "UP" : "DOWN";
  }

  export function fromTokenType(s: string): Side | undefined {
    const t = s.toLowerCase();
    if (t === "up") return Side.Up;
    if (t === "down") return Side.Down;
    return undefined;
  }
}

/** Quantize a BUY without inventing a venue tick or raising the risk-approved price. */
export function quantizeBuyPrice(price: number, tickSize: number | undefined): number | undefined {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 ||
    tickSize == null || !Number.isFinite(tickSize) || tickSize <= 0 || tickSize >= 1) return undefined;
  const rounded = Math.round(Math.floor(price / tickSize + 1e-9) * tickSize * 1e9) / 1e9;
  return rounded >= tickSize - 1e-12 && rounded <= 1 - tickSize + 1e-12 &&
    rounded <= price + 1e-12 ? rounded : undefined;
}

export interface Fill {
  side: Side;
  shares: number;
  price: number;
  tsUnix: number;
  isMaker: boolean;
}

/** Polymarket fee for one fill: fee = shares × rate × (p·(1−p))^exponent */
export function polymarketFillFee(
  shares: number,
  price: number,
  isMaker: boolean,
  takerFeeRate: number,
  makerFeeRate: number,
  feeExponent: number,
): number {
  const rate = isMaker ? makerFeeRate : takerFeeRate;
  if (rate <= 0 || price <= 0 || price >= 1 || shares <= 0) return 0;
  const variance = price * (1 - price);
  const curve =
    Math.abs(feeExponent - 1) < 1e-9 ? variance : Math.pow(variance, feeExponent);
  return shares * rate * curve;
}
