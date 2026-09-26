import assert from "node:assert/strict";
import { accountSignatureTypeValue, accountWalletKindValue } from "./account-status.js";

assert.equal(accountWalletKindValue("EOA"), "eoa");
assert.equal(accountWalletKindValue("DEPOSIT_WALLET"), "deposit_wallet");
assert.equal(accountWalletKindValue("CONTRACT_UNKNOWN"), "contract_unknown");
assert.equal(accountSignatureTypeValue(0), "eoa");
assert.equal(accountSignatureTypeValue(1), "poly_proxy");
assert.equal(accountSignatureTypeValue(2), "poly_gnosis_safe");
assert.equal(accountSignatureTypeValue(3), "poly_1271");
assert.equal(accountSignatureTypeValue(null), null);

const publicStatus = {
  wallet_kind: accountWalletKindValue("DEPOSIT_WALLET"),
  signature_type: accountSignatureTypeValue(3),
  settlement_credentials_ready: true,
};
assert.deepEqual(publicStatus, {
  wallet_kind: "deposit_wallet",
  signature_type: "poly_1271",
  settlement_credentials_ready: true,
});
assert.equal(Object.keys(publicStatus).some(key => /secret|token|private|passphrase|api_key/i.test(key)), false);

console.log("account-status.test: PASS");
