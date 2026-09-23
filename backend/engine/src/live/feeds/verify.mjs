import WebSocket from "ws";
import { parseArgs } from "node:util";
import { findMarket } from "../../../dist/live/discovery.js";
import { runPolymarketFeed } from "../../../dist/live/feeds/polymarket.js";

// Public market data only. No account, strategy, or order client is imported.
const { values } = parseArgs({ options: {
  "duration-sec": { type: "string", default: "25" },
  "disconnect-after-sec": { type: "string", default: "0" },
} });
const durationSec = Number(values["duration-sec"]);
const disconnectSec = Number(values["disconnect-after-sec"]);
if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600
  || !Number.isFinite(disconnectSec) || disconnectSec < 0 || disconnectSec >= durationSec) {
  throw new Error("duration must be 1..600 seconds; disconnect must be 0 or less than duration");
}

let socket;
const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (...args) {
  socket = this;
  return send.apply(this, args);
};

const market = await findMarket(Date.now() / 1000, false, true);
console.log("DISCOVERY", JSON.stringify(market));
if (!market) process.exit(2);

const books = [];
const statuses = [];
let brokenAt;
let resumedAt;
let sequenceRegressions = 0;
let sourceRegressions = 0;
let depthSample;
const processing = [];
const feed = runPolymarketFeed(event => {
  if (event.kind === "book") {
    const previous = books.at(-1);
    if (previous && previous.sequence >= event.snapshot.sequence) sequenceRegressions++;
    if (previous && previous.sourceAt > event.snapshot.sourceAt) sourceRegressions++;
    if (brokenAt && !resumedAt) resumedAt = Date.now();
    if (event.snapshot.YES?.bids?.length === 5 && event.snapshot.YES?.asks?.length === 5
      && event.snapshot.NO?.bids?.length === 5 && event.snapshot.NO?.asks?.length === 5) depthSample = event.snapshot;
    processing.push(event.snapshot.processedAtMonoMs - event.snapshot.receivedAtMonoMs);
    books.push(event.snapshot);
  }
  if (event.kind === "bookStatus") statuses.push({
    healthy: event.healthy,
    connected: event.connected,
    reason: event.reason,
  });
}, market.upToken, market.downToken, market.end, {
  marketId: market.conditionId,
  roundId: market.roundId,
});

const disconnectTimer = disconnectSec > 0 ? setTimeout(() => {
  brokenAt = Date.now();
  console.log("FORCE_DISCONNECT", JSON.stringify({ books: books.length }));
  socket?.terminate();
}, disconnectSec * 1000) : undefined;

const finish = () => {
  clearTimeout(disconnectTimer);
  clearTimeout(durationTimer);
  feed.stop();
  WebSocket.prototype.send = send;
  process.removeListener("SIGINT", finish);
  process.removeListener("SIGTERM", finish);
  const latest = books.at(-1);
  processing.sort((a, b) => a - b);
  console.log("PROBE", JSON.stringify({
    books: books.length,
    sequenceRegressions,
    sourceRegressions,
    fullDepthReceived: Boolean(depthSample),
    depthSample: depthSample && { YES: depthSample.YES, NO: depthSample.NO },
    recoveryMs: resumedAt ? resumedAt - brokenAt : null,
    processingMs: books.length ? {
      p50: processing[Math.floor(processing.length * 0.5)],
      p99: processing[Math.floor(processing.length * 0.99)],
    } : null,
    statuses,
    latest: latest && {
      marketId: latest.marketId,
      roundId: latest.roundId,
      sequence: latest.sequence,
      sourceAt: latest.sourceAt,
      expiresAt: latest.expiresAt,
      YES: latest.YES,
      NO: latest.NO,
    },
  }));
  if (!books.length || sequenceRegressions || sourceRegressions || (brokenAt && !resumedAt)) process.exitCode = 1;
};
const durationTimer = setTimeout(finish, durationSec * 1000);
process.once("SIGINT", finish);
process.once("SIGTERM", finish);
