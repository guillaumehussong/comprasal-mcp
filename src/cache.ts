/**
 * Optional file-based HTTP response cache for COMPRASAL API calls.
 *
 * Disabled by default (live API on every request). Opt in with COMPRASAL_CACHE_ENABLED=true.
 * Cache dir: COMPRASAL_CACHE_DIR or .comprasal-cache/ in cwd.
 * TTL: COMPRASAL_CACHE_TTL_MS (default 1 hour).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface CachedResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  cachedAt: number;
}

export interface CacheOptions {
  enabled?: boolean;
  dir?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_DIR = ".comprasal-cache";

function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v === "1" || v.toLowerCase() === "true";
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

export function resolveCacheOptions(overrides?: CacheOptions): Required<CacheOptions> {
  return {
    enabled: overrides?.enabled ?? envBool("COMPRASAL_CACHE_ENABLED", false),
    dir: overrides?.dir ?? process.env.COMPRASAL_CACHE_DIR ?? DEFAULT_DIR,
    ttlMs: overrides?.ttlMs ?? envInt("COMPRASAL_CACHE_TTL_MS", DEFAULT_TTL_MS),
  };
}

export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export class FileCache {
  private readonly opts: Required<CacheOptions>;

  constructor(options?: CacheOptions) {
    this.opts = resolveCacheOptions(options);
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private filePath(key: string): string {
    return join(this.opts.dir, `${key}.json`);
  }

  async get(key: string): Promise<CachedResponse | null> {
    if (!this.opts.enabled) return null;
    try {
      const raw = await readFile(this.filePath(key), "utf8");
      const entry = JSON.parse(raw) as CachedResponse;
      if (Date.now() - entry.cachedAt > this.opts.ttlMs) {
        await unlink(this.filePath(key)).catch(() => {});
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  async set(key: string, body: unknown, headers: Record<string, string | string[] | undefined>): Promise<void> {
    if (!this.opts.enabled) return;
    await mkdir(this.opts.dir, { recursive: true });
    const entry: CachedResponse = { body, headers, cachedAt: Date.now() };
    await writeFile(this.filePath(key), JSON.stringify(entry), "utf8");
  }
}

/** Singleton used by the HTTP client; tests may replace via setGlobalCache(). */
let globalCache: FileCache | null = null;

export function getGlobalCache(): FileCache {
  if (!globalCache) globalCache = new FileCache();
  return globalCache;
}

/** @internal Test hook */
export function setGlobalCache(cache: FileCache | null): void {
  globalCache = cache;
}
