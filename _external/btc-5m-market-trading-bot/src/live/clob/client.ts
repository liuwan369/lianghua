import {
  AssetType,
  ClobClient,
  createL2Headers,
  isV2Order,
  OrderType,
  orderToJsonV1,
  orderToJsonV2,
  Side as ClobSide,
  type ApiKeyCreds,
  type OrderResponse,
  type SignedOrder,
  type TickSize,
} from "@polymarket/clob-client-v2";
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  envWalletOverrides,
  resolveWallet,
  signatureTypeLabel,
} from "./wallet.js";

export type { ApiKeyCreds };

const DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com";

export const MIN_ORDER_SHARES = 5;

export const DEFAULT_HOST =
  process.env.CLOB_HOST ?? "https://clob.polymarket.com";

export function tickRoundDown(price: number, tick: number): number {
  const t = tick > 0 ? tick : 0.01;
  const p = Math.floor(price / t + 1e-9) * t;
  const clamped = Math.min(Math.max(p, t), 1 - t);
  return Math.round(clamped * 1e6) / 1e6;
}

export interface ClobWrapperOptions {
  key: string;
  /** Optional override — auto-detected via Gamma + on-chain when omitted. */
  sigType?: number;
  funder?: Address;
}

export interface SubmitOrderArgs {
  tokenId: string;
  price: number;
  size: number;
  expiration: number;
  tickSize: number;
}

export interface SubmitOrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  errorMsg?: string;
  latencyMs?: number;
  signLatencyMs?: number;
  ackLatencyMs?: number;
  tradeIds?: string[];
  /** The request may have reached CLOB even though no ACK was received. */
  stateUnknown?: boolean;
}

const DEFAULT_WARM_TIMEOUT_MS = 3_000;
const DEFAULT_WARM_ATTEMPTS = 2;
const DEFAULT_ORDER_TIMEOUT_MS = 3_000;
const POST_ORDER_PATH = "/order";
const CANCEL_ALL_PATH = "/cancel-all";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isVersionMismatch(value: unknown): boolean {
  try {
    return JSON.stringify(value).includes("order_version_mismatch");
  } catch {
    return false;
  }
}

function responseError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const error = record.error ?? record.errorMsg ?? record.error_msg;
  if (error == null || error === "") return undefined;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function responseTradeIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>).tradeIDs;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

function requestStateUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = Number((error as Error & { status?: number }).status);
  const code = String((error as Error & { code?: string }).code ?? "");
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error instanceof TypeError ||
    status >= 500 ||
    /ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR/i.test(code) ||
    /timed out|timeout|aborted|fetch failed|connection reset|socket hang up/i.test(error.message)
  );
}

function sdkTickSize(value: number): TickSize {
  const tick = String(value);
  if (["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"].includes(tick)) {
    return tick as TickSize;
  }
  throw new Error(`unsupported CLOB tick size ${tick}`);
}

/** Thin wrapper over @polymarket/clob-client-v2 + viem. */
export class ClobWrapper {
  readonly client: ClobClient;
  readonly signerAddress: Address;
  readonly funder: Address;
  readonly creds: ApiKeyCreds;
  readonly signatureType: number;

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatId?: string;
  private orderVersion: 1 | 2 | 3 = 2;
  private requestTimeoutMs = DEFAULT_ORDER_TIMEOUT_MS;

  private constructor(
    client: ClobClient,
    signerAddress: Address,
    funder: Address,
    creds: ApiKeyCreds,
    signatureType: number,
  ) {
    this.client = client;
    this.signerAddress = signerAddress;
    this.funder = funder;
    this.creds = creds;
    this.signatureType = signatureType;
  }

  static async connect(opts: ClobWrapperOptions): Promise<ClobWrapper> {
    const pk = (opts.key.startsWith("0x") ? opts.key : `0x${opts.key}`) as Hex;
    const account = privateKeyToAccount(pk);
    const rpc = process.env.POLYGON_RPC ?? DEFAULT_RPC;

    const env = envWalletOverrides();
    const resolved = await resolveWallet(account.address, {
      funderOverride: opts.funder ?? env.funder,
      sigTypeOverride: opts.sigType ?? env.sigType,
      rpcUrl: rpc,
    });

    console.info(
      `wallet resolved: signer=${resolved.signer} funder=${resolved.funder} ` +
        `sig_type=${signatureTypeLabel(resolved.signatureType)} (${resolved.source})`,
    );

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(rpc),
    }) as WalletClient;

    const l1 = new ClobClient({
      host: DEFAULT_HOST,
      chain: polygon.id,
      signer: walletClient,
    });
    const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();

    const client = new ClobClient({
      host: DEFAULT_HOST,
      chain: polygon.id,
      signer: walletClient,
      creds,
      signatureType: resolved.signatureType,
      funderAddress: resolved.funder,
    });

    const wrapper = new ClobWrapper(
      client,
      account.address,
      resolved.funder,
      creds,
      resolved.signatureType,
    );
    await wrapper.syncCollateralBalance();
    return wrapper;
  }

  /** Push on-chain USDC balance to CLOB and log tradable collateral. */
  async syncCollateralBalance(): Promise<number> {
    try {
      await this.client.updateBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      const bal = await this.client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      const raw = Number.parseFloat(String(bal.balance ?? "0"));
      const usdc = Number.isFinite(raw) ? raw / 1e6 : 0;
      console.info(`CLOB tradable balance (pUSD): $${usdc.toFixed(2)}`);
      if (usdc < 2) {
        console.warn(
          "CLOB balance < $2 — deposit on polymarket.com or wrap USDC.e → pUSD",
        );
      }
      return usdc;
    } catch (e) {
      console.warn(`CLOB balance sync failed (${e}) — orders may reject until synced`);
      return 0;
    }
  }

  /** Keep CLOB session alive (required for some wallet types). Returns stop fn. */
  startHeartbeat(intervalMs = 25_000): () => void {
    this.stopHeartbeat();
    const tick = async () => {
      try {
        const resp = await this.client.postHeartbeat(this.heartbeatId);
        if (resp?.heartbeat_id) this.heartbeatId = resp.heartbeat_id;
        if (resp?.error_msg) {
          console.warn(`CLOB heartbeat: ${resp.error_msg}`);
        }
      } catch (e) {
        console.warn(`CLOB heartbeat failed: ${e}`);
      }
    };
    void tick();
    this.heartbeatTimer = setInterval(() => void tick(), intervalMs);
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async fetchJson(
    path: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const response = await fetch(`${DEFAULT_HOST}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = { error: text };
      }
    }
    if (response.status >= 500) {
      const error = new Error(
        responseError(payload) ??
          `CLOB ${init.method ?? "GET"} ${path} failed (${response.status})`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    if (!response.ok && !responseError(payload)) {
      throw new Error(`CLOB ${init.method ?? "GET"} ${path} failed (${response.status})`);
    }
    return payload;
  }

  private async l2Json(
    path: string,
    method: "POST" | "DELETE",
    data?: unknown,
  ): Promise<unknown> {
    const body = data == null ? undefined : JSON.stringify(data);
    const signer = this.client.signer;
    if (!signer) throw new Error("CLOB signer unavailable");
    const headers = await createL2Headers(
      signer,
      this.creds,
      { method, requestPath: path, body },
    );
    return this.fetchJson(path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
  }

  private async currentVersion(): Promise<1 | 2 | 3> {
    const payload = await this.fetchJson("/version", { method: "GET" });
    const version = Number((payload as Record<string, unknown>)?.version ?? 2);
    if (version !== 1 && version !== 2 && version !== 3) {
      throw new Error(`unsupported CLOB order version ${version}`);
    }
    return version;
  }

  private async postSignedOrder(
    order: SignedOrder,
    orderType: OrderType,
    postOnly: boolean,
  ): Promise<OrderResponse> {
    const payload = isV2Order(order)
      ? orderToJsonV2(order, this.creds.key, orderType, postOnly, true)
      : orderToJsonV1(order, this.creds.key, orderType, postOnly, true);
    return (await this.l2Json(POST_ORDER_PATH, "POST", payload)) as OrderResponse;
  }

  /** Warm all metadata used by the signing path before the first order. */
  async warmMarket(
    conditionId: string,
    timeoutMs = DEFAULT_WARM_TIMEOUT_MS,
    attempts = DEFAULT_WARM_ATTEMPTS,
  ): Promise<number> {
    const started = performance.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await withTimeout(
          (async () => {
            const [market, version] = await Promise.all([
              this.client.getClobMarketInfo(conditionId),
              this.currentVersion(),
            ]);
            const tokenId = market.t?.find((token) => token?.t)?.t;
            if (!tokenId) throw new Error(`market ${conditionId} has no tradable token`);
            const tickSize = sdkTickSize(Number(market.mts));
            this.orderVersion = version;
            await this.client.createOrder(
              {
                tokenID: tokenId,
                price: 0.5,
                size: MIN_ORDER_SHARES,
                side: ClobSide.BUY,
              },
              { tickSize, negRisk: market.nr ?? false, version },
            );
          })(),
          timeoutMs,
          "CLOB market warmup",
        );
        return performance.now() - started;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async tickSize(tokenId: string): Promise<number> {
    try {
      const ts = await this.client.getTickSize(tokenId);
      const n = Number.parseFloat(String(ts));
      return Number.isFinite(n) && n > 0 ? n : 0.01;
    } catch {
      return 0.01;
    }
  }

  updateTickSize(tokenId: string, tickSize: number): void {
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    this.client.tickSizes[tokenId] = sdkTickSize(tickSize);
  }

  async submitOrder(args: SubmitOrderArgs): Promise<SubmitOrderResult> {
    const started = performance.now();
    try {
      const negRisk = await this.client.getNegRisk(args.tokenId);
      let signLatencyMs = 0;
      let ackLatencyMs = 0;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const signStarted = performance.now();
        const order = await this.client.createOrder(
          {
            tokenID: args.tokenId,
            price: args.price,
            size: args.size,
            side: ClobSide.BUY,
            expiration: args.expiration,
          },
          {
            tickSize: sdkTickSize(args.tickSize),
            negRisk,
            version: this.orderVersion,
          },
        );
        signLatencyMs += performance.now() - signStarted;

        const ackStarted = performance.now();
        const resp = await this.postSignedOrder(order, OrderType.GTD, true);
        ackLatencyMs += performance.now() - ackStarted;
        const orderId = resp?.orderID;
        const apiError = responseError(resp);
        const success = !apiError && Boolean(resp?.success ?? orderId);
        if (success || attempt > 0 || !isVersionMismatch(resp)) {
          return {
            success,
            orderId,
            status: resp?.status,
            errorMsg: apiError ?? resp?.errorMsg,
            latencyMs: performance.now() - started,
            signLatencyMs,
            ackLatencyMs,
            tradeIds: responseTradeIds(resp),
          };
        }

        this.orderVersion = await this.currentVersion();

      }
      throw new Error("order submission exhausted retries");
    } catch (e) {
      return {
        success: false,
        errorMsg: e instanceof Error ? e.message : String(e),
        latencyMs: performance.now() - started,
        stateUnknown: requestStateUnknown(e),
      };
    }
  }

  async cancel(orderId: string): Promise<boolean> {
    const resp = (await this.l2Json(POST_ORDER_PATH, "DELETE", {
      orderID: orderId,
    })) as Record<string, unknown>;
    const error = responseError(resp);
    if (error) throw new Error(`CLOB cancel failed: ${error}`);
    const canceled = resp?.canceled;
    if (!Array.isArray(canceled)) {
      throw new Error("CLOB cancel response did not include a canceled order list");
    }
    return canceled.includes(orderId);
  }

  async cancelAll(): Promise<void> {
    const resp = (await this.l2Json(CANCEL_ALL_PATH, "DELETE")) as Record<string, unknown>;
    const error = responseError(resp);
    if (error) throw new Error(`CLOB cancel-all failed: ${error}`);
    if (!("canceled" in resp) || !("not_canceled" in resp)) {
      throw new Error("CLOB cancel-all response did not confirm cancellation status");
    }
    if (!Array.isArray(resp.canceled)) {
      throw new Error("CLOB cancel-all response has invalid canceled field");
    }
    const notCanceled = resp.not_canceled;
    if (!Array.isArray(notCanceled) && (!notCanceled || typeof notCanceled !== "object")) {
      throw new Error("CLOB cancel-all response has invalid not_canceled field");
    }
    const unresolved = Array.isArray(notCanceled)
      ? notCanceled.length
      : notCanceled && typeof notCanceled === "object"
        ? Object.keys(notCanceled).length
        : 0;
    if (unresolved > 0) {
      throw new Error(`CLOB cancel-all left ${unresolved} order(s) unresolved`);
    }
  }

  async getTradesByIds(ids: string[]): Promise<unknown[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    const pages = await Promise.all(
      unique.map((id) =>
        withTimeout(this.client.getTrades({ id }, true), 3_000, `trade ${id} reconcile`)
          .catch(() => []),
      ),
    );
    return pages.flat().filter((trade) => unique.includes(String(trade.id)));
  }

  async getRecentTrades(conditionId: string, afterUnix: number): Promise<unknown[]> {
    return withTimeout(
      this.client.getTrades(
        { market: conditionId, after: String(Math.max(0, Math.floor(afterUnix))) },
        false,
      ),
      3_000,
      "recent trade reconciliation",
    );
  }

  async getOpenOrders(conditionId: string): Promise<unknown[]> {
    return withTimeout(
      this.client.getOpenOrders({ market: conditionId }, false),
      3_000,
      "open order reconciliation",
    );
  }

  /** FOK market buy — amount is USDC notional. */
  async submitMarketBuy(
    tokenId: string,
    usdcAmount: number,
    price: number,
    tickSize: number,
  ): Promise<SubmitOrderResult> {
    const started = performance.now();
    try {
      const negRisk = await this.client.getNegRisk(tokenId);
      let signLatencyMs = 0;
      let ackLatencyMs = 0;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const signStarted = performance.now();
        const order = await this.client.createMarketOrder(
          {
            tokenID: tokenId,
            amount: usdcAmount,
            price,
            side: ClobSide.BUY,
            orderType: OrderType.FOK,
          },
          {
            tickSize: sdkTickSize(tickSize),
            negRisk,
            version: this.orderVersion,
          },
        );
        signLatencyMs += performance.now() - signStarted;

        const ackStarted = performance.now();
        const resp = await this.postSignedOrder(order, OrderType.FOK, false);
        ackLatencyMs += performance.now() - ackStarted;
        const orderId = resp?.orderID;
        const apiError = responseError(resp);
        const success = !apiError && Boolean(resp?.success ?? orderId);
        if (success || attempt > 0 || !isVersionMismatch(resp)) {
          return {
            success,
            orderId,
            status: resp?.status,
            errorMsg: apiError ?? resp?.errorMsg,
            latencyMs: performance.now() - started,
            signLatencyMs,
            ackLatencyMs,
            tradeIds: responseTradeIds(resp),
          };
        }

        this.orderVersion = await this.currentVersion();

      }
      throw new Error("market order submission exhausted retries");
    } catch (e) {
      return {
        success: false,
        errorMsg: e instanceof Error ? e.message : String(e),
        latencyMs: performance.now() - started,
        stateUnknown: requestStateUnknown(e),
      };
    }
  }
}

// Official geoblock docs list these countries as close-only on the frontend;
// the API itself remains available. Keep this separate from account eligibility.
const FRONTEND_ONLY_RESTRICTED_COUNTRIES = new Set(["IE", "JP", "MT", "NL"]);

export function apiOrderRegionAllowed(v: {
  blocked?: boolean;
  country?: string;
}): boolean {
  const country = String(v.country ?? "").toUpperCase();
  return v.blocked === false || (
    v.blocked === true && FRONTEND_ONLY_RESTRICTED_COUNTRIES.has(country)
  );
}

export async function geocheck(): Promise<void> {
  try {
    const resp = await fetch("https://polymarket.com/api/geoblock", httpClientInit());
    if (!resp.ok) {
      throw new Error(`GEO-CHECK FAILED: HTTP ${resp.status}`);
    }
    const v = (await resp.json()) as { blocked?: boolean; country?: string };
    if (typeof v.blocked !== "boolean" || typeof v.country !== "string") {
      throw new Error("GEO-CHECK FAILED: response fields are missing");
    }
    console.info(
      `geoblock: country=${v.country ?? "?"} blocked=${v.blocked ?? false}`,
    );
    if (!apiOrderRegionAllowed(v)) {
      throw new Error(
        "GEO-BLOCKED: official rules restrict API order placement from this IP",
      );
    }
    if (v.blocked) {
      console.warn(
        "FRONTEND-ONLY RESTRICTION: official docs currently allow API orders from this country; account eligibility still applies.",
      );
    }
    console.warn(
      "NOTE: /api/geoblock allowed != CLOB order acceptance — datacenter/VPN IPs are often 403'd at order time.",
    );
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.startsWith("GEO-BLOCKED") || e.message.startsWith("GEO-CHECK FAILED"))
    ) {
      throw e;
    }
    throw new Error(`GEO-CHECK FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function httpClientInit(): RequestInit {
  return { signal: AbortSignal.timeout(10_000) };
}
