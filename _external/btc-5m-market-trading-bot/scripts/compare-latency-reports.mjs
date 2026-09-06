#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const paths = process.argv.slice(2);
if (paths.length < 2) {
  throw new Error("usage: node scripts/compare-latency-reports.mjs report-a.json report-b.json");
}

function metric(report, path) {
  return path.reduce((value, key) => value?.[key], report);
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "不可用";
}

// Malta's frontend restriction currently applies to sports only.
const FRONTEND_ONLY_RESTRICTED_COUNTRIES = new Set(["IE", "JP", "MT", "NL"]);

function apiRegionPassed(report) {
  if (typeof report.api_region?.allowed === "boolean") {
    return report.api_region.allowed;
  }
  const country = String(report.geoblock?.country ?? "").toUpperCase();
  return report.geoblock?.blocked === false || (
    report.geoblock?.blocked === true && FRONTEND_ONLY_RESTRICTED_COUNTRIES.has(country)
  );
}

const rows = [];
for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  const adjusted = metric(report, ["websocket", "adjusted_steady_message_age", "p95_ms"]);
  const raw = metric(report, ["websocket", "steady_message_age", "p95_ms"]);
  rows.push({
    path,
    host: report.hostname ?? path,
    regionPassed: apiRegionPassed(report),
    endpointBlocked: report.geoblock?.blocked === true,
    country: report.geoblock?.country ?? "?",
    clockCalibrated:
      report.clock_sync?.synchronized === true &&
      Number.isFinite(report.clock_sync?.local_minus_ntp_ms),
    messageAgeP95: Number.isFinite(adjusted) ? adjusted : null,
    rawMessageAgeP95: raw,
    restP95: metric(report, ["clob_rest", "p95_ms"]),
    firstBookP95: metric(report, ["websocket", "first_book", "p95_ms"]),
    gapP99: metric(report, ["websocket", "receive_gap", "p99_ms"]),
    errors: Array.isArray(report.errors) ? report.errors.length : 0,
  });
}

rows.sort((a, b) => {
  if (a.regionPassed !== b.regionPassed) return a.regionPassed ? -1 : 1;
  if (a.clockCalibrated !== b.clockCalibrated) return a.clockCalibrated ? -1 : 1;
  if (a.errors !== b.errors) return a.errors - b.errors;
  return (a.messageAgeP95 ?? Infinity) - (b.messageAgeP95 ?? Infinity)
    || (a.restP95 ?? Infinity) - (b.restP95 ?? Infinity);
});

console.log("主机\t地区\tAPI地理规则通过\t网页端标记受限\t真实接单\t时钟已校准\t校准后盘口P95\t原始盘口P95\tREST P95\t首盘口P95\t收包间隔P99\t错误");
for (const row of rows) {
  console.log([
    row.host,
    row.country,
    row.regionPassed ? "是" : "否",
    row.endpointBlocked ? "是" : "否",
    "未测试",
    row.clockCalibrated ? "是" : "否",
    `${fmt(row.messageAgeP95)}ms`,
    `${fmt(row.rawMessageAgeP95)}ms`,
    `${fmt(row.restP95)}ms`,
    `${fmt(row.firstBookP95)}ms`,
    `${fmt(row.gapP99)}ms`,
    row.errors,
  ].join("\t"));
}

const eligible = rows.filter(
  (row) => row.regionPassed && row.errors === 0 && row.clockCalibrated,
);
console.log(eligible.length > 0
  ? `\n当前只读测速第一名：${eligible[0].host}。这里只通过了 API 地理规则，真实接单仍需极小额订单验证。`
  : "\n没有主机同时满足：官方 API 地区规则通过、时钟偏差已量化、零测速错误。暂不能选实盘机房。");
