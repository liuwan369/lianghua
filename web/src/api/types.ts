export type Obj = Record<string, unknown>;
export interface ControlSource { scope: 'local_preview' | 'collector_host'; label: string; market_node: string }
export interface Config { control_source?: ControlSource; schemaVersion: 1; revision: number; savedAt: string | null; params: Obj; capabilities: Obj }
export interface Status { control_source?: ControlSource; schemaVersion: 1; asOf: number; running: boolean; mode: string | null; run_id: string | null; account_id: string | null; config_revision: number | null; params: Obj; live_unlocked: boolean; stop_result: Obj; stats: Obj; projection: Obj | null }
export interface Market { slug: string; start: number; end: number; up_bid: number | null; up_ask: number | null; down_bid: number | null; down_ask: number | null; ask_sum: number | null; quote_at: string | null }
export interface Markets { schemaVersion: 1; asOf: number; node_label: string; collector_online: boolean; cache_age_seconds: number | null; current_markets: Market[]; latest_event_at?: string; stale_reason?: string; error?: string; error_code?: string }
export interface Account { control_source?: ControlSource; wallet: string; wallet_configured: boolean; owner_signer_configured: boolean; relayer_api_configured: boolean; builder_api_configured: boolean; config_error: string | null; last_check: Obj | null }
export interface Run { id: number; run_id: string; mode: string; account_id: string | null; config_revision: number | null; created_at: number }
export interface Runs { control_source?: ControlSource; schemaVersion: 1; runs: Run[]; next_before_id: number | null }
export interface Event { id: number; event: string; market: string | null; time: number | null; side: string | null; price: number | null; shares: number | null; amount: number | null; fee: number | null; pnl: number | null; is_maker: boolean | null; has_observed_fills?: boolean }
export interface Events { control_source?: ControlSource; schemaVersion: 1; run_id: string; events: Event[]; next_before_id: number | null }
export interface Summary extends Obj { run_id: string; mode: string; account_id: string | null; fill_count: number; fill_notional: number | null; fees: number | null; settled_markets: number; settled_pnl: number | null; pnl_semantics: string; completeness: string; order_lifecycle_available: boolean }
export interface SummaryResponse { control_source?: ControlSource; schemaVersion: 1; summary: Summary }
export interface Resource<T> { data: T | null; error: string | null; receivedAt: number; loading: boolean }
