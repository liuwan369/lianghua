// Five real live BTC rung-1 orders (5 shares, limit 0.70). decidedAt = the
// order's first SUBMITTING time; `real` is what the venue did.
export const CALIBRATION_ORDERS = [
  { roundId: "1790889000", dir: "DOWN", decidedAt: 1790889114.479, real: { price: 0.70, maker: 5 } },
  { roundId: "1790889300", dir: "DOWN", decidedAt: 1790889451.105, real: { price: 0.67, maker: 0 } },
  { roundId: "1790931300", dir: "UP", decidedAt: 1790931311.154, real: { price: 0.70, maker: 5 } },
  { roundId: "1790931600", dir: "UP", decidedAt: 1790931650.083, real: { price: 0.67, maker: 0 } },
  { roundId: "1790931900", dir: "UP", decidedAt: 1790932134.039, real: { price: 0.70, maker: 5 } },
];
