import { strict as assert } from "node:assert";
import { checkSettlementCredentials } from "./wallet.js";

const base = {
  ownerSignerPresent: true,
  ownerMatchesSigner: true,
  builderCredentialsPresent: false,
  relayerCredentialsPresent: false,
} as const;

assert.equal(checkSettlementCredentials({ ...base, walletKind: "EOA" }).ready, true);
assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET" }).ready, false);
assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET", builderCredentialsPresent: true }).route, "builder");
assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET", relayerCredentialsPresent: true }).route, "relayer");
assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET", ownerMatchesSigner: false }).reason, "wallet_owner_mismatch");
assert.equal(checkSettlementCredentials({ ...base, walletKind: "CONTRACT_UNKNOWN" }).ready, false);

console.log("settlement-credentials.test: PASS");
