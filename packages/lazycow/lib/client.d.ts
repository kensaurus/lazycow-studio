// Types for the lazycow package. Part of Lazycow Studio by kensaurus (https://kensaur.us). Apache-2.0.

export interface ClientOptions {
  /** Full base URL, e.g. "http://127.0.0.1:4317". Wins over port. */
  base?: string;
  /** Studio port. Default: STUDIO_PORT, else the studio's .env, else 4317. */
  port?: number;
  /** API token. Default: STUDIO_API_TOKEN, else the studio's .env. */
  token?: string;
  /** The studio folder whose .env to read. Default: LAZYCOW_DIR, else the folder the setup recorded. */
  dir?: string;
  /** Per-request timeout in ms. Default 120000. */
  timeoutMs?: number;
  /** A fetch implementation (tests, proxies). Default: global fetch. */
  fetch?: typeof fetch;
}

export declare class StudioError extends Error {
  status: number;
  path: string;
  body: unknown;
}

export interface StudioClient {
  readonly base: string;
  request<T = unknown>(method: string, path: `/${string}`, body?: unknown): Promise<T>;
  get<T = unknown>(path: `/${string}`): Promise<T>;
  post<T = unknown>(path: `/${string}`, body?: unknown): Promise<T>;
  health<T = Record<string, unknown>>(): Promise<T>;
  about<T = Record<string, unknown>>(): Promise<T>;
  overview<T = Record<string, unknown>>(): Promise<T>;
  posts<T = unknown>(): Promise<T>;
  themes<T = unknown>(): Promise<T>;
  projects<T = unknown>(): Promise<T>;
  problems<T = unknown>(): Promise<T>;
}

export declare function createClient(opts?: ClientOptions): StudioClient;
export default createClient;
