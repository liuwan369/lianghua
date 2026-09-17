import { afterEach, expect, it, vi } from 'vitest';
import { mountLayout } from './layout';
import { pageTelemetry } from './page-telemetry';
import { renderSystemMetrics } from './system-metrics';
import type { SystemMetrics } from './api/types';

afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();});
function mount(){document.body.innerHTML='<div id="app"></div>';mountLayout(document.getElementById('app')!);}
const metrics: SystemMetrics={schemaVersion:1,asOf:Date.now()/1000,cpu:{percent:41.2,cores:2},load:{one:.3,five:.2,fifteen:.1},memory:{used_bytes:1024**3,total_bytes:2*1024**3,percent:50},disk:{used_bytes:7*1024**3,total_bytes:10*1024**3,free_bytes:3*1024**3,percent:70},services:{dashboard:{state:'active',pid:11,rss_bytes:20*1024**2,uptime_seconds:60},trader:{state:'stopped',pid:null,rss_bytes:null,uptime_seconds:null}},journal_backlog:0,event_loop_lag_ms:null};

it('renders actual host resources and process health without inventing unknown values',()=>{
  mount();renderSystemMetrics(metrics,null);
  expect(document.querySelector('[data-system-cpu]')!.textContent).toBe('41.2% · 2 核');
  expect(document.querySelector('[data-system-memory]')!.textContent).toContain('1.0 GB / 2.0 GB');
  expect(document.querySelector('[data-system-services]')!.textContent).toContain('交易进程未运行');
  renderSystemMetrics(null,'读取失败');expect(document.querySelector('[data-system-cpu]')!.textContent).toBe('--');
});
it('expires a cached resource snapshot while the next request is still pending',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(metrics.asOf!*1000));mount();renderSystemMetrics(metrics,null);
  expect(document.querySelector('[data-system-cpu]')!.textContent).toContain('41.2%');
  vi.setSystemTime(new Date(metrics.asOf!*1000+6000));renderSystemMetrics(metrics,null);
  expect(document.querySelector('[data-system-cpu]')!.textContent).toBe('--');
  expect(document.querySelector('[data-system-state]')!.textContent).toContain('已过期');
});

it('binds latency cards to the current run and keeps browser timing separate',()=>{
  mount();const telemetry=pageTelemetry();telemetry.selectRun('current');
  const metric={latest_ms:4,p50_ms:3,p95_ms:5,p99_ms:6,max_ms:7,samples:9};
  telemetry.renderServer({latency:{run_id:'old',as_of:Date.now()/1000,metrics:{order_http_ack:metric}}},'old');
  expect(document.querySelector('[data-latency-summary="order_http_ack"] strong')!.textContent).toContain('--');
  telemetry.renderServer({latency:{run_id:'current',as_of:Date.now()/1000,metrics:{order_http_ack:metric,reaction:{...metric,p95_ms:12}}}},'current');
  expect(document.querySelector('[data-latency-summary="order_http_ack"] strong')!.textContent).toContain('5.0');
  expect(document.querySelector('[data-latency-reaction]')!.textContent).toContain('12.0 ms');
  expect(document.querySelector('[data-latency-metric="order_http_ack"]')!.textContent).toContain('6.0');
  telemetry.record(8);expect(document.querySelector('[data-latency-page]')!.textContent).toContain('浏览器本页实测');
});
