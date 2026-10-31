// src/types/config.ts — Plugin configuration and Schemastery types for dsh-key-rotation

export type QuotaWindowType = 'midnight_utc' | 'fixed_interval' | 'sliding';

export interface QuotaWindowConfig {
  type: QuotaWindowType;
  hour?: number;
  intervalMs?: number;
}

export interface ModelQuotaConfig {
  tokenLimit?: number;
  requestLimit?: number;
  resetWindow?: QuotaWindowConfig;
}

export type RoutingStrategy = 'round-robin' | 'sticky' | 'random' | 'weighted';

export interface FailoverConfig {
  statusCodes?: number[];
  retryAttempts?: number;
  backoffFactor?: number;
  initialBackoffMs?: number;
}

export interface PoolConfig {
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

export interface PluginConfig {
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
