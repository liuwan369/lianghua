import assert from "node:assert/strict";
import { checkSettlementCredentials } from "./wallet.js";

const base = {
  ownerSignerPresent: true,
  ownerMatchesSigner: true,
  builderCredentialsPresent: false,
  relayerCredentialsPresent: false,
} as const;

assert.deepEqual(checkSettlementCredentials({ ...base, walletKind: "EOA" }), {
  ready: true,
  route: "eoa",
  reason: "direct_eoa_submission_ready",
});
assert.equal(checkSettlementCredentials({ ...base, walletKind: "EOA", ownerMatchesSigner: false }).ready, false);
assert.equal(checkSettlementCredentials({ ...base, walletKind: "EOA", ownerSignerPresent: false }).reason, "owner_signer_missing");

assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET", builderCredentialsPresent: true }).ready, true);
assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET", relayerCredentialsPresent: true }).route, "relayer");
assert.equal(checkSettlementCredentials({ ...base, walletKind: "DEPOSIT_WALLET" }).reason, "builder_or_relayer_credentials_missing");
assert.equal(checkSettlementCredentials({ ...base, walletKind: "CONTRACT_UNKNOWN" }).reason, "settlement_wallet_type_unsupported");

console.log("settlement-credentials.test: PASS");
