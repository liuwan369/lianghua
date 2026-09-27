import type { Address } from "viem";

/** Polygon mainnet — Polymarket CLOB V2 (April 2026). See docs.polymarket.com/resources/contracts */

export const USDC_E =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as Address;

/** Polymarket USD — V2 collateral token (replaces raw USDC.e for trading). */
export const PUSD =
  "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as Address;

export const COLLATERAL_ONRAMP =
  "0x93070a847efEf7F70739046A929D47a521F5B8ee" as Address;

export const COLLATERAL_OFFRAMP =
  "0x2957922Eb93258b93368531d39fAcCA3B4dC5854" as Address;

export const CTF =
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address;

/** CTF Exchange V2 (standard markets). */
export const CTF_EXCHANGE =
  "0xE111180000d2663C0091e4f400237545B87B996B" as Address;

/** Neg-risk CTF Exchange V2. */
export const NEG_RISK_CTF_EXCHANGE =
  "0xe2222d279d744050d28e00520010520000310F59" as Address;

/** @deprecated V1 exchange — do not use for new orders. */
export const CTF_EXCHANGE_V1 =
  "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as Address;
