import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { PUSD } from "../live/contracts.js";
import type { PlatformAdapters, SettlementRequest, SettlementResult } from "./contracts.js";

const abi = parseAbi(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"]);
export interface RedemptionTransaction { to: Address; data: Hex; value: bigint }
/** Official @polymarket/client 0.9.0 production deployment; these SDK fields are internal. */
export const COLLATERAL_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f" as Address;
export const NEG_RISK_COLLATERAL_ADAPTER = "0xadA2005600Dec949baf300f4C6120000bDB6eAab" as Address;

/** The wallet-specific signer/relayer consumes the same transaction plan. */
export function redemptionPlan(request: SettlementRequest, options: { negRisk?: boolean } = {}): RedemptionTransaction {
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.marketId)) throw new Error("invalid condition ID");
  if (!Array.isArray(request.tokenIds) || request.tokenIds.length !== 2
    || request.tokenIds.some(token => typeof token !== "string" || !token)
    || new Set(request.tokenIds).size !== 2) {
    throw new Error("settlement adapter only supports explicit binary token sets");
  }
  // pUSD positions are redeemed through the collateral adapter, not directly
  // through CTF (which holds the protocol's underlying collateral).
  const to = options.negRisk ? NEG_RISK_COLLATERAL_ADAPTER : COLLATERAL_ADAPTER;
  return { to, value: 0n, data: encodeFunctionData({ abi, functionName: "redeemPositions",
    args: [PUSD, `0x${"0".repeat(64)}`, request.marketId as Hex, [1n, 2n]] }) };
}

export function settlementAdapter(send: (tx: RedemptionTransaction) => Promise<Omit<SettlementResult, "marketId">>): NonNullable<PlatformAdapters["settle"]> {
  return async request => ({ ...await send(redemptionPlan(request)), marketId: request.marketId });
}
