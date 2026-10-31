// src/types/cordis.ts — Cordis service contracts and lifecycle types for dsh-key-rotation

export interface CredentialsService {
  resolve: (ref: string, ctx?: unknown) => Promise<{ value: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface LlmStreamOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface LlmService {
  stream?: (options: LlmStreamOptions, ...args: unknown[]) => AsyncIterable<unknown>;
  models?: () => Promise<unknown[]>;
  providers?: unknown;
  [key: string]: unknown;
}

export interface WebServerService {
  routes?: unknown;
  listen?: (port: number, host?: string) => Promise<unknown>;
  [key: string]: unknown;
}

export interface SettingsService {
  getSnapshot?: () => { value?: unknown; service?: { getSnapshot?: () => { value?: unknown } } };
  subscribe?: (callback: () => void) => () => void;
  [key: string]: unknown;
}

export interface Disposable {
  (): void;
  dispose?: () => void;
}

export interface Context {
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
