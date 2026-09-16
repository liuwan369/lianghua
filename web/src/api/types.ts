export type Obj = Record<string, unknown>;
export interface ControlSource { scope: 'local_preview' | 'collector_host'; label: string; market_node: string }
export interface Config { control_source?: ControlSource; schemaVersion: 1; revision: number; savedAt: string | null; params: Obj; capabilities: Obj }
export interface Status { control_source?: ControlSource; schemaVersion: 1; asOf: number; running: boolean; mode: string | null; run_id: string | null; account_id: string | null; config_revision: number | null; params: Obj; live_unlocked: boolean; stop_result: Obj; stats: Obj; projection: Obj | null; execution_target?: 'platform'; engine?: 'platform' | 'legacy' | null; execution?: 'observation' | 'strategy' | 'legacy' | null; strategy_id?: string | null }
export interface PlatformRuntime extends Obj { engine: 'platform'; execution: 'observation' | 'strategy'; strategy_id: string | null; status: string; mode: string; source_at: number; expires_at: number; stale: boolean; cash_usd: number | null; positions_count: number | null; orders_count: number | null; active_orders: number | null; fills_count: number | null; risk: Obj | null; limits: Obj | null; markets: Obj[]; books: Obj[] }
export interface Market { slug: string; start: number; end: number; up_bid: number | null; up_ask: number | null; down_bid: number | null; down_ask: number | null; ask_sum: number | null; quote_at: string | null }
export interface Markets { schemaVersion: 1; asOf: number; node_label: string; collector_online: boolean; cache_age_seconds: number | null; current_markets: Market[]; latest_event_at?: string; stale_reason?: string; error?: string; error_code?: string }
export interface Account { control_source?: ControlSource; wallet: string; wallet_configured: boolean; owner_signer_configured: boolean; relayer_api_configured: boolean; builder_api_configured: boolean; config_error: string | null; last_check: Obj | null }
export interface Run { id: number; run_id: string; mode: string; account_id: string | null; config_revision: number | null; created_at: number }
export interface Runs { control_source?: ControlSource; schemaVersion: 1; runs: Run[]; next_before_id: number | null }
export interface Event { id: number; event: string; market: string | null; time: number | null; side: string | null; price: number | null; shares: number | null; amount: number | null; fee: number | null; pnl: number | null; is_maker: boolean | null; has_observed_fills?: boolean }
export interface Events { control_source?: ControlSource; schemaVersion: 1; run_id: string; events: Event[]; next_before_id: number | null }
export interface Summary extends Obj { run_id: string; mode: string; account_id: string | null; fill_count: number; fill_notional: number | null; fees: number | null; settled_markets: number; settled_pnl: number | null; pnl_semantics: string; completeness: string; order_lifecycle_available: boolean }
export interface SummaryResponse { control_source?: ControlSource; schemaVersion: 1; summary: Summary }
export type TaskStatus = 'DONE' | 'RUNNING' | 'REVIEW' | 'TODO' | 'BLOCKED' | 'PAUSED';
export interface TaskItem { id: string; title: string; status: TaskStatus; owner: string; detail: string; next: string; runId?: string }
export interface TaskPhase { id: string; title: string; status: TaskStatus; owner: string; detail: string; tasks: TaskItem[] }
export type ArchitectureStatus = 'DONE' | 'PARTIAL' | 'TODO' | 'DEFERRED' | 'PAUSED';
export type ArchitectureScope = 'CORE' | 'STRATEGY' | 'DELIVERY';
export interface ArchitectureItem { id: string; title: string; status: ArchitectureStatus; detail: string; next: string; verification: string }
export interface ArchitectureGroup { id: string; title: string; owner: string; scope: ArchitectureScope; detail: string; items: ArchitectureItem[] }
export interface TaskArchitecture { title: string; summary: string; groups: ArchitectureGroup[] }
export interface TaskView { schemaVersion: 1; title: string; updatedAt: string; summary: string; hardRules: string[]; phases: TaskPhase[]; architecture?: TaskArchitecture }
export interface EdgeCandidate { direction: string; reason?: string | null; historical_signals: number | null; historical_hits: number | null; historical_accuracy: number | null; live_signals?: number | null; live_hits?: number | null; live_accuracy?: number | null }
export interface EdgeLive { schemaVersion: 1; updated?: number; phase?: string; collector_status?: string; mode?: string; latest_freeze: Obj; decisions: Obj; candidates: Record<string, EdgeCandidate>; collection: Obj; market?: Obj; limitations: string[] }
export interface Resource<T> { data: T | null; error: string | null; receivedAt: number; loading: boolean }
export interface StrategyComparison { receivedAt: number; sources: Obj[] }
export interface AntiSignalRow { slug: string; start: number; end: number; created: number; cutoff: number; direction: string; reason: string; features: string; outcome: string | null; direct_hit: number | null; inverse_hit: number | null; settled: number | null }
export interface AntiSignal { schemaVersion: 1; status: string; rule: string; version?: string; mode: string; started?: number | null; updated?: number | null; samples?: { observed: number; skipped: number; forecasted: number; settled: number; pending: number; direct_hits: number; inverse_hits: number; direct_accuracy: number | null; inverse_accuracy: number | null }; current?: AntiSignalRow | null; recent?: AntiSignalRow[]; limitations?: string[] }
