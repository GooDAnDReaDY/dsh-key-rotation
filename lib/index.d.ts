type QuotaWindowType = 'midnight_utc' | 'fixed_interval' | 'sliding';
interface QuotaWindowConfig {
  type: QuotaWindowType;
  hour?: number;
  intervalMs?: number;
}
interface ModelQuotaConfig {
  tokenLimit?: number;
  requestLimit?: number;
  resetWindow?: QuotaWindowConfig;
}
type RoutingStrategy = 'round-robin' | 'sticky' | 'random' | 'weighted';
interface FailoverConfig {
  statusCodes?: number[];
  retryAttempts?: number;
  backoffFactor?: number;
  initialBackoffMs?: number;
}
interface PoolConfig {
  provider: string;
  keys: string[];
  models?: string[];
  strategy?: RoutingStrategy;
  weights?: Record<string, number>;
  failover?: FailoverConfig;
  quotaResetWindow?: QuotaWindowConfig;
  modelQuotas?: Record<string, Record<string, ModelQuotaConfig>>;
  priority?: number;
  disabled?: boolean;
}
interface PluginConfig {
  pools?: PoolConfig[];
  defaultStrategy?: RoutingStrategy;
  cooldownPeriodMs?: number;
  maxRetries?: number;
  telemetryEnabled?: boolean;
  showChatHeaderChip?: boolean;
  webhookActionToken?: string;
  webhookUrl?: string;
  webhookEvents?: string[];
  trafficSmoothing?: boolean;
  maxConcurrentRequestsPerKey?: number;
  [key: string]: unknown;
}
type KeyStatus = 'healthy' | 'cooling' | 'exhausted' | 'disabled' | 'retesting';
interface KeyState {
  ref: string;
  status: KeyStatus;
  failureCount: number;
  lastUsed?: number;
  cooldownUntil?: number;
  penaltyUntil?: number;
  tags?: Record<string, unknown>;
  consecutiveFailures?: number;
  totalRequests?: number;
  successfulRequests?: number;
  lastError?: {
    code?: string;
    message?: string;
    timestamp: number;
    status?: number;
  };
}
interface PoolState {
  keys: Map<string, KeyState> | Record<string, KeyState>;
  lastUsed?: string;
  sessionSticky?: Map<string, string>;
  roundRobinIndex?: number;
  [key: string]: unknown;
}
interface PoolItem {
  provider: string;
  refs: string[];
  state: PoolState;
  strategy: RoutingStrategy | string;
  models?: string[];
  weights?: Record<string, number>;
  quotaResetWindow?: QuotaWindowConfig;
  modelQuotas?: Record<string, unknown>;
  failover?: unknown;
}
interface ResolvedKey {
  ref: string;
  value: string;
  provider: string;
  source?: string;
  headers?: Record<string, string>;
}
interface RoutingDecision {
  key: string;
  pool: string;
  strategy: string;
  attempt: number;
  sessionId?: string;
  timestamp: number;
}
interface QuotaWindow {
  type: 'midnight_utc' | 'fixed_interval' | 'sliding';
  hour?: number;
  intervalMs?: number;
  nextResetAt: number;
}
interface CredentialsService {
  resolve: (ref: string, ctx?: unknown) => Promise<{
    value: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}
interface LlmStreamOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}
interface LlmService {
  stream?: (options: LlmStreamOptions, ...args: unknown[]) => AsyncIterable<unknown>;
  models?: () => Promise<unknown[]>;
  providers?: unknown;
  [key: string]: unknown;
}
interface WebServerService {
  routes?: unknown;
  listen?: (port: number, host?: string) => Promise<unknown>;
  [key: string]: unknown;
}
interface SettingsService {
  getSnapshot?: () => {
    value?: unknown;
    service?: {
      getSnapshot?: () => {
        value?: unknown;
      };
    };
  };
  subscribe?: (callback: () => void) => () => void;
  [key: string]: unknown;
}
interface Disposable {
  (): void;
  dispose?: () => void;
}
interface Context {
  plugin: (plugin: unknown, config?: unknown) => Disposable;
  on: (event: string, listener: (...args: any[]) => void | Promise<void>) => Disposable;
  inject: (services: string[], callback: (ctx: Context) => void | Disposable) => Disposable;
  effect: (callback: () => void | (() => void)) => Disposable;
  provide: (name: string, value?: unknown) => void;
  credentials?: CredentialsService;
  llm?: LlmService;
  webServer?: WebServerService;
  settings?: SettingsService;
  locale?: {
    register: (namespace: string, dicts: Record<string, Record<string, string>>) => void;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export type { Context, CredentialsService, Disposable, FailoverConfig, KeyState, KeyStatus, LlmService, LlmStreamOptions, ModelQuotaConfig, PluginConfig, PoolConfig, PoolItem, PoolState, QuotaWindow, QuotaWindowConfig, QuotaWindowType, ResolvedKey, RoutingDecision, RoutingStrategy, SettingsService, WebServerService };