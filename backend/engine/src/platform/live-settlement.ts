import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildHmacSignature } from "@polymarket/client";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http,
  keccak256, parseAbi, parseAbiItem, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { loadAccountConfig } from "../live/account.js";
import { checkSettlementCredentials, inspectWalletAddress } from "../live/clob/wallet.js";
import { CTF, PUSD } from "../live/contracts.js";
import type { PlatformAdapters, SettlementRequest, SettlementResult } from "./contracts.js";
import { COLLATERAL_ADAPTER, redemptionPlan, type RedemptionTransaction } from "./settlement.js";

const ctfAbi = parseAbi([
  "function payoutDenominator(bytes32) view returns (uint256)",
  "function payoutNumerators(bytes32,uint256) view returns (uint256)",
  "function balanceOf(address,uint256) view returns (uint256)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address operator,bool approved)",
]);
const cashAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const singleBurn = parseAbiItem("event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)");
const batchBurn = parseAbiItem("event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)");
const zero = `0x${"0".repeat(40)}` as Address;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const depositWalletFactory = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07" as Address;

export interface PreparedSettlementTransaction {
  kind: "eoa" | "deposit";
  rawTransaction?: Hex;
  transactionHash?: Hex;
  body?: string;
  deadline?: number;
}
export interface LiveSettlementRecord {
  marketId: string;
  /** Added after the original market-id-only persistence format. */
  roundId?: string;
  assetId?: string;
  tokenIds: string[];
  status: "prepared" | "submitted" | "confirmed" | "failed";
  operation: "approval" | "redeem";
  prepared: PreparedSettlementTransaction;
  fromBlock: string;
  balancesBefore: string[];
  cashBefore: string;
  expectedPayout: string;
  transactionHash?: Hex;
  relayerId?: string;
  creditedPusd?: string;
  cashAfter?: string;
  lastSubmittedAt?: number;
  reason?: string;
}
export interface LiveSettlementState {
  schemaVersion: 1;
  wallet: string;
  records: Record<string, LiveSettlementRecord>;
}
interface BalanceView { balances: bigint[]; cash: bigint; block: bigint }
interface MarketResolution { tokenIds: string[]; denominator: bigint; numerators: bigint[]; negRisk: boolean }
export interface SettlementReceipt {
  transactionHash: Hex;
  status: "success" | "reverted";
  block: bigint;
  creditedPusd: bigint;
}
/** The narrow IO boundary is injectable for fault/restart tests, never a paper sender. */
export interface LiveSettlementBackend {
  wallet: Address;
  market(request: SettlementRequest): Promise<MarketResolution>;
  balances(tokenIds: string[], block?: bigint): Promise<BalanceView>;
  approved(): Promise<boolean>;
  prepare(call: RedemptionTransaction): Promise<PreparedSettlementTransaction>;
  submit(tx: PreparedSettlementTransaction): Promise<{ transactionHash?: Hex; relayerId?: string }>;
  receipt(record: LiveSettlementRecord): Promise<SettlementReceipt | undefined>;
  /** True only when the chain clock proves this signed deposit batch can no longer execute. */
  expired?(record: LiveSettlementRecord): Promise<boolean>;
}
export interface LiveSettlementOptions {
  stateFile?: string;
  restore?: LiveSettlementState;
  persist?: (state: LiveSettlementState) => void | Promise<void>;
  backend?: LiveSettlementBackend;
  /** Live strategy processes must fail before trading when settlement cannot be submitted. */
  requireCredentials?: boolean;
}

export class UnsupportedSettlement extends Error {}
export class RetryableSettlement extends Error {}

/**
 * Non-blocking, resumable on-chain redemption. Call again to poll pending work.
 * The caller refreshes its ordinary account snapshot after confirmed; this
 * adapter never adds cash to the strategy ledger or treats a relayer ACK as cash.
 */
export async function createLiveSettlementAdapter(options: LiveSettlementOptions = {}): Promise<NonNullable<PlatformAdapters["settle"]>> {
  let backend: LiveSettlementBackend;
  try { backend = options.backend ?? await createBackend(); }
  catch (error) {
    if (!(error instanceof UnsupportedSettlement)) throw error;
    if (options.requireCredentials !== false) throw error;
    return async request => ({ marketId: request.marketId, state: "unsupported", reason: error.message });
  }
  const stateFile = resolve(options.stateFile ?? "results/platform/live-settlements.json");
  const state: LiveSettlementState = options.restore ?? (existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8")) as LiveSettlementState
    : { schemaVersion: 1, wallet: backend.wallet, records: {} });
  if (state.schemaVersion !== 1 || state.wallet.toLowerCase() !== backend.wallet.toLowerCase()
    || !state.records || typeof state.records !== "object"
    || Object.values(state.records).some(record => !record
      || (record.roundId !== undefined
        && (typeof record.roundId !== "string" || !/^\d+$/.test(record.roundId))))) {
    throw new Error("settlement state wallet/schema mismatch");
  }
  const save = async () => {
    if (options.persist) return options.persist(structuredClone(state));
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, stateFile);
  };
  const recordKey = (request: SettlementRequest): string => JSON.stringify([request.marketId, request.roundId]);
  const result = (request: SettlementRequest, status: SettlementResult["state"], reason: string, record?: LiveSettlementRecord): SettlementResult => {
    const usd = (raw: string | undefined): number | undefined => {
      if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
      const units = Number(raw);
      return Number.isSafeInteger(units) ? units / 1_000_000 : undefined;
    };
    const verified = status === "confirmed" && record?.status === "confirmed" && record.operation === "redeem"
      && hashPattern.test(record.transactionHash ?? "") && usd(record.creditedPusd) !== undefined;
    return { marketId: request.marketId, roundId: request.roundId, assetId: request.assetId, state: status, reason,
      transactionId: record?.transactionHash ?? record?.relayerId,
      payoutVerified: verified,
      ...(verified ? { creditedUsd: usd(record!.creditedPusd), expectedPayoutUsd: usd(record!.expectedPayout),
        cashBeforeUsd: usd(record!.cashBefore), cashAfterUsd: usd(record!.cashAfter) } : {}) };
  };
  async function submitRecord(record: LiveSettlementRecord, recovering: boolean): Promise<void> {
    record.lastSubmittedAt = Date.now();
    await save();
    try {
      Object.assign(record, await backend.submit(record.prepared));
      record.status = "submitted";
      record.reason = undefined;
    } catch (error) {
      // A repeated exact batch may be rejected because the first copy already
      // owns the wallet nonce. That is not proof that the original failed.
      if (!recovering && error instanceof RetryableSettlement) {
        // A definite rejection did not consume the nonce. Re-read balance and
        // nonce next time, rather than keeping an unsent request forever.
        delete state.records[JSON.stringify([record.marketId, record.roundId])];
        record.reason = "settlement_relayer_busy_retrying";
      } else if (!recovering && error instanceof UnsupportedSettlement) {
        record.status = "failed";
        record.reason = error.message;
      } else record.reason = "settlement_submit_result_unknown";
    }
    await save();
  }
  async function run(request: SettlementRequest): Promise<SettlementResult> {
    if (!request.roundId || !/^\d+$/.test(request.roundId)) {
      return result(request, "unsupported", "settlement_round_identity_missing");
    }
    redemptionPlan(request); // Validate identity before any IO.
    if (request.tokenIds.some(id => !/^\d+$/.test(id))) return result(request, "unsupported", "settlement_invalid_token_id");
    const key = recordKey(request);
    let record: LiveSettlementRecord | undefined = state.records[key];
    if (!record) {
      // The first persistence format keyed records only by conditionId and had
      // no roundId. Adopt such a record only when the caller supplies the
      // discovered market identity and the persisted token pair still matches.
      // This is an identity migration, never a time/slug-based guess.
      const legacyKey = request.marketId;
      const legacy = state.records[legacyKey];
      if (legacy && legacy.marketId === request.marketId && legacy.roundId === undefined) {
        if (!Array.isArray(legacy.tokenIds) || legacy.tokenIds.length !== request.tokenIds.length
          || request.tokenIds.some(id => !legacy!.tokenIds.includes(id))) {
          return result(request, "unsupported", "settlement_token_identity_changed", legacy);
        }
        record = legacy;
        record.roundId = request.roundId;
        delete state.records[legacyKey];
        state.records[key] = record;
        try { await save(); }
        catch (error) {
          delete state.records[key];
          delete record.roundId;
          state.records[legacyKey] = record;
          throw error;
        }
      }
    }
    if (record && (record.roundId !== request.roundId || record.tokenIds.length !== request.tokenIds.length
      || request.tokenIds.some(id => !record!.tokenIds.includes(id)))) {
      return result(request, "unsupported", "settlement_token_identity_changed", record);
    }
    if (record?.status === "confirmed") return result(request, "confirmed", "pUSD到账已由链上回执确认", record);
    if (record?.status === "failed") return result(request, "unsupported", record.reason ?? "settlement_failed", record);
    if (record) {
      let receipt: SettlementReceipt | undefined;
      try { receipt = await backend.receipt(record); }
      catch (error) {
        if (!(error instanceof UnsupportedSettlement)) throw error;
        record.status = "failed";
        record.reason = error.message;
        await save();
        return result(request, "unsupported", error.message, record);
      }
      // Query first. If an ACK was lost (or the process died before broadcast),
      // replay ONLY the persisted signed bytes, preserving chain nonce and hash.
      // This can never create a second economic redemption with a fresh nonce.
      if (!receipt) {
        if (await backend.expired?.(record)) {
          delete state.records[key];
          await save();
          return result(request, "pending", "原赎回签名已过期，下一次按实际持仓重新提交");
        }
        if (record.status === "prepared" && (!record.lastSubmittedAt || Date.now() - record.lastSubmittedAt >= 30_000)) {
          await submitRecord(record, true);
        }
        return result(request, "pending", "等待原赎回交易回执", record);
      }
      record.transactionHash = receipt.transactionHash;
      if (receipt.status !== "success") {
        record.status = "failed";
        record.reason = "settlement_transaction_reverted";
        await save();
        return result(request, "unsupported", record.reason, record);
      }
      if (record.operation === "approval") {
        if (!await backend.approved()) return result(request, "pending", "等待授权生效", record);
        delete state.records[key];
        await save();
        record = undefined;
      } else {
        const after = await backend.balances(record.tokenIds, receipt.block);
        if (after.balances.some(amount => amount !== 0n)
          || receipt.creditedPusd < BigInt(record.expectedPayout)) {
          record.status = "failed";
          record.reason = "settlement_receipt_balance_or_payout_mismatch";
          await save();
          return result(request, "unsupported", record.reason, record);
        }
        record.status = "confirmed";
        record.creditedPusd = receipt.creditedPusd.toString();
        record.cashAfter = after.cash.toString();
        await save();
        return result(request, "confirmed", "pUSD到账已由链上回执确认", record);
      }
    }
    const market = await backend.market(request);
    if (market.negRisk) return result(request, "unsupported", "neg_risk_redemption_not_supported_by_this_sender");
    if (market.denominator === 0n) return result(request, "pending", "等待官方结算结果");
    const before = await backend.balances(market.tokenIds);
    if (before.balances.every(amount => amount === 0n)) {
      // No holdings means nothing to do, not proof of a historical payout.
      return result(request, "confirmed", "链上无该场持仓，无需赎回；未记录赎回收益");
    }
    if (market.numerators.length !== 2 || market.numerators.some(value => value < 0n)
      || market.numerators[0]! + market.numerators[1]! !== market.denominator) {
      return result(request, "unsupported", "settlement_invalid_payout_vector");
    }
    const expectedPayout = before.balances.reduce((sum, amount, i) => sum + amount * market.numerators[i]! / market.denominator, 0n);
    const otherPending = Object.values(state.records).find(item => item.marketId !== request.marketId
      && (item.status === "prepared" || item.status === "submitted"));
    if (otherPending) return result(request, "pending", "等待钱包上一笔结算交易确认");
    const approved = await backend.approved();
    const call = approved ? redemptionPlan(request) : {
      to: CTF, value: 0n,
      data: encodeFunctionData({ abi: ctfAbi, functionName: "setApprovalForAll", args: [COLLATERAL_ADAPTER, true] }),
    };
    const prepared = await backend.prepare(call);
    record = {
      marketId: request.marketId, roundId: request.roundId, assetId: request.assetId, tokenIds: market.tokenIds, status: "prepared", operation: approved ? "redeem" : "approval",
      prepared, fromBlock: before.block.toString(), balancesBefore: before.balances.map(String), cashBefore: before.cash.toString(),
      expectedPayout: expectedPayout.toString(), transactionHash: prepared.transactionHash,
    };
    state.records[key] = record;
    // A failed pre-send persistence must not leave an in-memory phantom request.
    try { await save(); } catch (error) { delete state.records[key]; throw error; }
    await submitRecord(record, false);
    return result(request, record.status === "failed" ? "unsupported" : "pending",
      record.reason ?? (approved ? "赎回已提交，等待链上到账" : "授权已提交，确认后自动赎回"), record);
  }
  // Share one serial lane across ALL conditions: deposit wallet and EOA nonces
  // are account-wide, and independent per-market locks would race.
  let lane: Promise<unknown> = Promise.resolve();
  return request => {
    const work = lane.then(async () => {
      try { return await run(request); }
      catch (error) {
        if (error instanceof UnsupportedSettlement) return result(request, "unsupported", error.message);
        // RPC errors can contain credential-bearing URLs. Do not echo them.
        return result(request, "pending", "结算查询暂时失败，稍后自动重试", state.records[recordKey(request)]);
      }
    });
    lane = work.catch(() => undefined);
    return work;
  };
}

async function createBackend(): Promise<LiveSettlementBackend> {
  const config = loadAccountConfig();
  if (!config.ownerPrivateKey || config.errors.length) throw new UnsupportedSettlement("settlement_owner_credentials_missing_or_invalid");
  const account = privateKeyToAccount(config.ownerPrivateKey);
  const wallet = config.depositWallet ?? account.address;
  const rpc = process.env.POLYGON_RPC?.trim() || "https://polygon-bor-rpc.publicnode.com";
  const inspection = await inspectWalletAddress(wallet, rpc);
  const deposit = inspection.walletKind === "DEPOSIT_WALLET";
  if (inspection.walletKind === "CONTRACT_UNKNOWN") throw new UnsupportedSettlement("settlement_wallet_type_requires_safe_or_proxy_sender");
  const builderKey = process.env.POLY_BUILDER_API_KEY?.trim();
  const builderSecret = process.env.POLY_BUILDER_SECRET?.trim();
  const builderPassphrase = process.env.POLY_BUILDER_PASSPHRASE?.trim();
  const relayKey = process.env.RELAYER_API_KEY?.trim();
  const relayAddress = process.env.RELAYER_API_KEY_ADDRESS?.trim();
  const credentials = checkSettlementCredentials({
    walletKind: inspection.walletKind,
    ownerSignerPresent: true,
    ownerMatchesSigner: deposit
      ? inspection.owner?.toLowerCase() === account.address.toLowerCase()
      : wallet.toLowerCase() === account.address.toLowerCase(),
    builderCredentialsPresent: config.builderCredentialsPresent,
    relayerCredentialsPresent: config.relayerCredentialsPresent,
  });
  if (!credentials.ready) {
    throw new UnsupportedSettlement(`settlement_credentials_${credentials.reason}`);
  }
  const useBuilder = credentials.route === "builder";
  const client = createPublicClient({ chain: polygon, transport: http(rpc, { timeout: 12_000 }) });
  const signer = createWalletClient({ account, chain: polygon, transport: http(rpc, { timeout: 12_000 }) });
  const relayer = "https://relayer-v2.polymarket.com";
  async function relay(path: string, body?: string): Promise<Record<string, unknown>> {
    const method = body === undefined ? "GET" : "POST";
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "pm-platform-settlement" };
    if (useBuilder && builderKey && builderSecret && builderPassphrase) {
      const ts = Math.floor(Date.now() / 1000);
      Object.assign(headers, { POLY_BUILDER_API_KEY: builderKey, POLY_BUILDER_PASSPHRASE: builderPassphrase,
        POLY_BUILDER_TIMESTAMP: String(ts), POLY_BUILDER_SIGNATURE: await buildHmacSignature(builderSecret, ts, method, path, body) });
    } else if (relayKey && relayAddress) Object.assign(headers, { RELAYER_API_KEY: relayKey, RELAYER_API_KEY_ADDRESS: relayAddress });
    const response = await fetch(`${relayer}${path}`, { method, headers, body, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      if (method === "POST" && response.status === 429) throw new RetryableSettlement("settlement_relayer_rate_limited");
      if (method === "POST" && response.status === 400) {
        const reason = await response.text();
        if (/wallet busy|wallet has in-flight action|batch nonce\s+\d+\s+does not match on-chain nonce/i.test(reason)) {
          throw new RetryableSettlement("settlement_relayer_wallet_busy_or_nonce_changed");
        }
      }
      if (method === "POST" && response.status >= 400 && response.status < 500 && response.status !== 408) {
        throw new UnsupportedSettlement(`settlement_relayer_submit_http_${response.status}`);
      }
      throw new Error("settlement_relayer_unavailable");
    }
    return await response.json() as Record<string, unknown>;
  }
  async function receiptFor(hash: Hex): Promise<SettlementReceipt | undefined> {
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return undefined; throw error; }
    let credited = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== PUSD.toLowerCase()) continue;
      try {
        const parsed = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
        if (parsed.args.to.toLowerCase() === wallet.toLowerCase()) credited += parsed.args.value;
        if (parsed.args.from.toLowerCase() === wallet.toLowerCase()) credited -= parsed.args.value;
      } catch { /* Other pUSD events do not prove a transfer. */ }
    }
    return { transactionHash: hash, status: receipt.status, block: receipt.blockNumber, creditedPusd: credited };
  }
  return {
    wallet,
    async market(request) {
      const url = `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(request.marketId)}&limit=1`;
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error("settlement_market_unavailable");
      const rows = await response.json() as Record<string, unknown>[];
      const row = rows.find(item => String(item.conditionId).toLowerCase() === request.marketId.toLowerCase());
      if (!row) throw new UnsupportedSettlement("settlement_market_not_found");
      const ids: unknown = typeof row.clobTokenIds === "string" ? JSON.parse(row.clobTokenIds) : row.clobTokenIds;
      if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== "string" || !request.tokenIds.includes(id))) {
        throw new UnsupportedSettlement("settlement_market_token_mismatch_or_unsupported_protocol");
      }
      if (typeof row.negRisk !== "boolean") throw new UnsupportedSettlement("settlement_market_neg_risk_unknown");
      const condition = request.marketId as Hex;
      const [denominator, first, second] = await Promise.all([
        client.readContract({ address: CTF, abi: ctfAbi, functionName: "payoutDenominator", args: [condition] }),
        client.readContract({ address: CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [condition, 0n] }),
        client.readContract({ address: CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [condition, 1n] }),
      ]);
      return { tokenIds: ids as string[], negRisk: row.negRisk, denominator, numerators: [first, second] };
    },
    async balances(tokenIds, atBlock) {
      const block = atBlock ?? await client.getBlockNumber();
      const [cash, ...balances] = await Promise.all([
        client.readContract({ address: PUSD, abi: cashAbi, functionName: "balanceOf", args: [wallet], blockNumber: block }),
        ...tokenIds.map(id => client.readContract({ address: CTF, abi: ctfAbi, functionName: "balanceOf", args: [wallet, BigInt(id)], blockNumber: block })),
      ]);
      return { balances, cash: cash!, block };
    },
    approved: () => client.readContract({ address: CTF, abi: ctfAbi, functionName: "isApprovedForAll", args: [wallet, COLLATERAL_ADAPTER] }),
    async prepare(call) {
      if (!deposit) {
        const request = await signer.prepareTransactionRequest({ to: call.to, data: call.data, value: call.value });
        const rawTransaction = await signer.signTransaction(request);
        return { kind: "eoa", rawTransaction, transactionHash: keccak256(rawTransaction) };
      }
      const params = await relay(`/v1/account/transactions/params?address=${account.address}&type=WALLET`);
      if (!/^\d+$/.test(String(params.nonce))) throw new Error("settlement_nonce_missing");
      const nonce = BigInt(String(params.nonce));
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const calls = [{ target: call.to, value: call.value, data: call.data }];
      const signature = await account.signTypedData({
        domain: { name: "DepositWallet", version: "1", chainId: 137, verifyingContract: wallet }, primaryType: "Batch",
        types: { Call: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
          Batch: [{ name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "calls", type: "Call[]" }] },
        message: { wallet, nonce, deadline: BigInt(deadline), calls },
      });
      return { kind: "deposit", deadline, body: JSON.stringify({ type: "WALLET", from: account.address,
        to: depositWalletFactory, nonce: nonce.toString(), signature, metadata: "Platform position redemption",
        depositWalletParams: { depositWallet: wallet, deadline: String(deadline), calls: calls.map(item => ({ ...item, value: item.value.toString() })) } }) };
    },
    async submit(tx) {
      if (tx.kind === "eoa") return { transactionHash: await client.sendRawTransaction({ serializedTransaction: tx.rawTransaction! }) };
      const ack = await relay("/submit", tx.body!);
      const transactionHash = typeof ack.transactionHash === "string" && hashPattern.test(ack.transactionHash) ? ack.transactionHash as Hex : undefined;
      const relayerId = typeof ack.transactionID === "string" ? ack.transactionID : typeof ack.transactionId === "string" ? ack.transactionId : undefined;
      if (!transactionHash && !relayerId) throw new Error("settlement_submit_identity_missing");
      return { transactionHash, relayerId };
    },
    async receipt(record) {
      if (record.transactionHash) return receiptFor(record.transactionHash);
      if (record.relayerId) {
        const tx = await relay(`/v1/account/transactions/${encodeURIComponent(record.relayerId)}`);
        if (tx.state === "STATE_FAILED" || tx.state === "STATE_INVALID") throw new UnsupportedSettlement(`settlement_relayer_${String(tx.state).toLowerCase()}`);
        if (typeof tx.transactionHash === "string" && hashPattern.test(tx.transactionHash)) return receiptFor(tx.transactionHash as Hex);
        return undefined;
      }
      // Lost relayer ACK: adapters first transfer CTF from wallet to themselves
      // and then burn it. Recover that transaction (or a direct burn), then
      // apply the SAME receipt/cash checks as normal.
      if (record.operation === "approval") {
        const event = parseAbiItem("event ApprovalForAll(address indexed account,address indexed operator,bool approved)");
        const logs = await client.getLogs({ address: CTF, event, args: { account: wallet, operator: COLLATERAL_ADAPTER }, fromBlock: BigInt(record.fromBlock), toBlock: "latest" });
        const hit = logs.find(log => log.args.approved && log.transactionHash);
        return hit?.transactionHash ? receiptFor(hit.transactionHash) : undefined;
      }
      const fromBlock = BigInt(record.fromBlock);
      const [single, batch] = await Promise.all([
        client.getLogs({ address: CTF, event: singleBurn, args: { from: wallet }, fromBlock, toBlock: "latest" }),
        client.getLogs({ address: CTF, event: batchBurn, args: { from: wallet }, fromBlock, toBlock: "latest" }),
      ]);
      const isRedemptionTarget = (to?: Address) => to?.toLowerCase() === zero || to?.toLowerCase() === COLLATERAL_ADAPTER.toLowerCase();
      const hit = single.find(log => isRedemptionTarget(log.args.to) && record.tokenIds.includes(String(log.args.id)))
        ?? batch.find(log => isRedemptionTarget(log.args.to) && log.args.ids?.some(id => record.tokenIds.includes(String(id))));
      return hit?.transactionHash ? receiptFor(hit.transactionHash) : undefined;
    },
    async expired(record) {
      if (record.prepared.kind !== "deposit" || !record.prepared.deadline) return false;
      // The original deadline is enforced on chain, not by the local wall clock.
      const block = await client.getBlock();
      return block.timestamp > BigInt(record.prepared.deadline + 30);
    },
  };
}
