import { signatureTypeLabel } from "./wallet.js";

export type AccountWalletKind = "EOA" | "DEPOSIT_WALLET" | "CONTRACT_UNKNOWN";

/** Stable, non-secret values consumed by the control-plane account status DTO. */
export function accountWalletKindValue(kind: AccountWalletKind): string {
  return kind.toLowerCase();
}

/** Keep the numeric CLOB enum internal while exposing a readable stable value. */
export function accountSignatureTypeValue(type: number | null): string | null {
  if (type === null) return null;
  return signatureTypeLabel(type as Parameters<typeof signatureTypeLabel>[0])
    .replace(/\s*\(\d+\)$/, "")
    .toLowerCase()
    .replaceAll("-", "_");
}
