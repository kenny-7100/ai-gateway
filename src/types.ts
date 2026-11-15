export type App = 'codex' | 'claude';
export type Selection = { mode: 'follow' } | { mode: 'fixed'; id: string };

/** Credentials remain private to the resolver and transport; never serialize this type. */
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
}
export interface ProviderResolver {
  resolve(app: App, selection: Selection): Provider;
  close?(): void;
}
export interface GatewayOptions {
  host: string;
  port: number;
  selections: Record<App, Selection>;
  proxyUrl?: string;
  headerTimeoutMs: number;
  shutdownGraceMs: number;
  log?: (record: { event: string; app?: App; status?: number; durationMs?: number }) => void;
}
export class GatewayError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
