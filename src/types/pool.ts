// src/types/pool.ts — Key state and pool domain types for dsh-key-rotation

import type { RoutingStrategy, QuotaWindowConfig } from './config.js';

export type KeyStatus = 'healthy' | 'cooling' | 'exhausted' | 'disabled' | 'retesting';

export interface KeyState {
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

export interface PoolState {
  keys: Map<string, KeyState> | Record<string, KeyState>;
  lastUsed?: string;
  sessionSticky?: Map<string, string>;
  roundRobinIndex?: number;
  [key: string]: unknown;
}

export interface PoolItem {
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

export interface ResolvedKey {
  ref: string;
  value: string;
  provider: string;
  source?: string;
  headers?: Record<string, string>;
}

export interface RoutingDecision {
  key: string;
  pool: string;
  strategy: string;
  attempt: number;
  sessionId?: string;
  timestamp: number;
}

export interface QuotaWindow {
  type: 'midnight_utc' | 'fixed_interval' | 'sliding';
  hour?: number;
  intervalMs?: number;
  nextResetAt: number;
}
