import assert from "node:assert/strict";
import { discoveryOptions, isActiveMarket } from "./polymarket.js";

assert.deepEqual(discoveryOptions(), { allowCollectorFallback: true, directOnly: false },
  "normal runtime discovery can use the fresh collector market");
assert.deepEqual(discoveryOptions(true), { allowCollectorFallback: false, directOnly: true },
  "boundary prewarm remains deterministic and direct-only");
assert.equal(isActiveMarket({ startsAt: 1790395800, endsAt: 1790396100 }, 1790395800), true);
assert.equal(isActiveMarket({ startsAt: 1790395800, endsAt: 1790396100 }, 1790395799), false,
  "a future prewarm round is not the active execution round");
assert.equal(isActiveMarket({ startsAt: 1790395800, endsAt: 1790396100 }, 1790396100), false);

console.log("runtime-discovery-routing.test: PASS");
