/** Optional on-disk cache for COMPRASAL HTTP responses (off by default). */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Shape of a single cached HTTP response on disk. */
export interface CachedResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  cachedAt: number;
}

/** Configurable options for the file cache. */
export interface CacheOptions {
  enabled?: boolean;
  dir?: string;
  ttlMs?: number;
}

/** Default cache entry lifetime: one hour. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Default cache folder name, created at runtime in the working directory. */
const DEFAULT_DIR = ".comprasal-cache";

/** Parses a boolean from an environment variable. */
function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v === "1" || v.toLowerCase() === "true";
}

/** Parses a non-negative integer from an environment variable. */
function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

/** Merges env vars and overrides into final cache settings. */
export function resolveCacheOptions(overrides?: CacheOptions): Required<CacheOptions> {
  return {
    enabled: overrides?.enabled ?? envBool("COMPRASAL_CACHE_ENABLED", false),
    dir: overrides?.dir ?? process.env.COMPRASAL_CACHE_DIR ?? DEFAULT_DIR,
    ttlMs: overrides?.ttlMs ?? envInt("COMPRASAL_CACHE_TTL_MS", DEFAULT_TTL_MS),
  };
}

/** Returns a stable SHA-256 hash for a request URL. */
export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/** Reads and writes cached API responses as JSON files. */
export class FileCache {
  private readonly opts: Required<CacheOptions>;

  /** Creates a cache using the given options or environment defaults. */
  constructor(options?: CacheOptions) {
    this.opts = resolveCacheOptions(options);
  }

  /** Returns whether caching is currently enabled. */
  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Returns the full file path for a cache key. */
  private filePath(key: string): string {
    return join(this.opts.dir, `${key}.json`);
  }

  /** Returns a cached response, or null if missing or expired. */
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

  /** Saves an API response to disk with the current timestamp. */
  async set(key: string, body: unknown, headers: Record<string, string | string[] | undefined>): Promise<void> {
    if (!this.opts.enabled) return;
    await mkdir(this.opts.dir, { recursive: true });
    const entry: CachedResponse = { body, headers, cachedAt: Date.now() };
    await writeFile(this.filePath(key), JSON.stringify(entry), "utf8");
  }
}

/** Shared cache instance used by the HTTP client. */
let globalCache: FileCache | null = null;

/** Returns the shared cache, creating it on first use. */
export function getGlobalCache(): FileCache {
  if (!globalCache) globalCache = new FileCache();
  return globalCache;
}

/** Replaces the shared cache instance (used in tests). */
export function setGlobalCache(cache: FileCache | null): void {
  globalCache = cache;
}
