// Proves ClobWrapper's native L2 headers are byte-identical to the SDK's
// createL2Headers, which the venue verifies. Run after `npm run build`:
//   node scripts/check-l2-headers.mjs
// Uses throwaway keys and never touches the network.
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { createL2Headers } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const { ClobWrapper } = await import("../dist/live/clob/client.js");

// connect() needs the network, so build the wrapper through its private
// constructor with a throwaway signer; l2Headers only reads fields.
const make = (secret) => {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const signer = createWalletClient({ account, chain: polygon, transport: http("http://127.0.0.1:9") });
  const creds = { key: randomBytes(8).toString("hex"), passphrase: randomBytes(8).toString("hex"), secret };
  const wrapper = new ClobWrapper({ signer }, account.address, account.address, creds, 3);
  return { wrapper, signer, creds };
};

// Secrets as the venue issues them (URL-safe base64), including the characters
// that the '-'/'_' translation and '=' padding must handle.
const secrets = [
  ...Array.from({ length: 40 }, () => randomBytes(32).toString("base64url")),
  randomBytes(32).toString("base64"),
  "_-_-" + randomBytes(30).toString("base64url"),
];
const bodies = [undefined, "", JSON.stringify({ orderID: "0x" + "ab".repeat(32) }),
  JSON.stringify({ order: { salt: "1", tokenId: "9".repeat(77), side: "BUY" }, owner: "k", orderType: "GTC" })];

let checked = 0;
for (const secret of secrets) {
  const { wrapper, signer, creds } = make(secret);
  for (const [method, path] of [["POST", "/order"], ["DELETE", "/order"]]) {
    for (const body of bodies) {
      // Freeze the clock so both sides sign the same timestamp.
      const ts = Math.floor(Date.now() / 1000);
      const realNow = Date.now;
      Date.now = () => ts * 1000;
      try {
        const ours = wrapper.l2Headers(method, path, body);
        const sdk = await createL2Headers(signer, creds, { method, requestPath: path, body }, ts);
        assert.deepEqual(ours, sdk, `${method} ${path} body=${String(body).slice(0, 20)}`);
      } finally { Date.now = realNow; }
      checked += 1;
    }
  }
}
assert.throws(() => make(""), /secret unavailable/);
console.log(`PASS l2 headers identical to SDK across ${checked} cases`);
