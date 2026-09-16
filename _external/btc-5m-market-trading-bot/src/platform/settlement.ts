import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { CTF, PUSD } from "../live/contracts.js";
import type { PlatformAdapters, SettlementRequest, SettlementResult } from "./contracts.js";

const abi = parseAbi(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"]);
export interface RedemptionTransaction { to: Address; data: Hex; value: bigint }

/** The wallet-specific signer/relayer consumes the same transaction plan. */
export function redemptionPlan(request: SettlementRequest): RedemptionTransaction {
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.marketId)) throw new Error("invalid condition ID");
  return { to: CTF, value: 0n, data: encodeFunctionData({ abi, functionName: "redeemPositions",
    args: [PUSD, `0x${"0".repeat(64)}`, request.marketId as Hex, [1n, 2n]] }) };
}

export function settlementAdapter(send: (tx: RedemptionTransaction) => Promise<Omit<SettlementResult, "marketId">>): NonNullable<PlatformAdapters["settle"]> {
  return async request => ({ ...await send(redemptionPlan(request)), marketId: request.marketId });
}
