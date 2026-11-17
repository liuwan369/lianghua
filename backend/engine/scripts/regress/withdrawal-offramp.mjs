// 2026-11-17 live: the operator withdrew 40 (Data API: one WITHDRAWAL row, 40).
// On chain the one transaction moves pUSD 40 out of the wallet (to the pUSD
// contract, which burns it) and USDC.e 40 in then 40 out (the offramp pays
// USDC.e to the wallet and the withdrawal forwards it). The classifier wanted
// every non-zero leg in one token, so the pUSD -40 and the USDC.e +40 / -40
// legs made it give up: "activity_amount_direction_asset_or_type_ambiguous",
// cash flows incomplete, the day's PnL counting the withdrawal as a loss.
// A withdrawal or deposit row matches the pUSD net of the transaction; the
// USDC.e legs that net to zero inside it are pass-through.
//
// Run after `npm run build`:  node scripts/regress/withdrawal-offramp.mjs
import assert from "node:assert/strict";
import { classifyCashFlows } from "../../dist/platform/cash-flows.js";

const W = "0xa693a0e0e40bdec3d9d4a40bd4d087a5cecfd7cd";
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const TX = "0xfe7ba32fa87772969fae72f7a3d32802435d2a17ce4cf749f1918b37e64fddb2";
const BH = "0x" + "ab".repeat(32);
const BLOCK = 97451933;
const leg = (i, token, from, to, amount) => ({ transaction_hash: TX, log_index: `0x${i.toString(16)}`, token, from, to,
  amount, net_amount: (to === W ? amount : 0) - (from === W ? amount : 0), block: BLOCK, block_hash: BH });
const OFFRAMP_PAYER = "0xc417fd8e" + "0".repeat(32);
const DESTINATION = "0x4cd00e38" + "0".repeat(32);
const transfers = [leg(1, PUSD, W, PUSD, 40), leg(2, USDCE, OFFRAMP_PAYER, W, 40), leg(4, USDCE, W, DESTINATION, 40)];
const input = (activity, legs = transfers) => ({
  wallet: W,
  scan: { source: "polygon-confirmed-transfer-logs", complete: true, from_block: BLOCK - 10, to_block: BLOCK + 10,
    token_contracts: [PUSD, USDCE], transfers: legs },
  receipts: [{ transaction_hash: TX, block: BLOCK, block_hash: BH, transfers: legs }],
  activity,
  blockTimestamps: { [BLOCK - 10]: 1794883300, [BLOCK]: 1794883369, [BLOCK + 10]: 1794883390 },
});
const withdrawal = { type: "WITHDRAWAL", usdcSize: 40, transaction_hash: TX, timestamp: 1794883369, side: "" };

{
  const r = classifyCashFlows(input([withdrawal]));
  assert.deepEqual(r.unknown, [], `classified: ${JSON.stringify(r.unknown)}`);
  assert.equal(r.cashFlowCoverage.complete, true);
  assert.deepEqual(r.externalFlows.map(f => [f.kind, f.amountUsd]), [["withdrawal", 40]], "one pUSD withdrawal of 40");
  assert.equal(r.netExternalUsd, -40);
}
// The official row has to match the pUSD net: a 30 row against a 40 move is not a match.
{
  const r = classifyCashFlows(input([{ ...withdrawal, usdcSize: 30 }]));
  assert.ok(r.unknown.length > 0, "a mismatched amount stays unclassified");
  assert.deepEqual(r.externalFlows, []);
}
// USDC.e that does not net to zero inside the transaction is not pass-through.
{
  const legs = [leg(1, PUSD, W, PUSD, 40), leg(2, USDCE, OFFRAMP_PAYER, W, 40)];
  const r = classifyCashFlows(input([withdrawal], legs));
  assert.ok(r.unknown.length > 0, "USDC.e left in the wallet: not a plain pUSD withdrawal");
}
// A plain single-token pUSD withdrawal still classifies (unchanged).
{
  const r = classifyCashFlows(input([withdrawal], [leg(1, PUSD, W, DESTINATION, 40)]));
  assert.deepEqual(r.externalFlows.map(f => [f.kind, f.amountUsd]), [["withdrawal", 40]]);
}
console.log("withdrawal-offramp OK");
