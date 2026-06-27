import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cacheKey, FileCache } from "../src/cache.js";

describe("FileCache", () => {
  let dir: string;
  let cache: FileCache;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "comprasal-cache-"));
    cache = new FileCache({ enabled: true, dir, ttlMs: 60_000 });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores and retrieves a response", async () => {
    const key = cacheKey("https://example.com/api?page=1");
    await cache.set(key, { data: [1, 2] }, { total_rows: "2" });
    const hit = await cache.get(key);
    assert.ok(hit);
    assert.deepEqual(hit.body, { data: [1, 2] });
    assert.equal(hit.headers.total_rows, "2");
  });

  it("returns null when disabled", async () => {
    const disabled = new FileCache({ enabled: false, dir, ttlMs: 60_000 });
    const key = cacheKey("https://example.com/disabled");
    await disabled.set(key, { ok: true }, {});
    assert.equal(await disabled.get(key), null);
  });

  it("expires entries past TTL", async () => {
    const short = new FileCache({ enabled: true, dir: join(dir, "ttl"), ttlMs: 1 });
    const key = cacheKey("https://example.com/expired");
    await short.set(key, { stale: true }, {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await short.get(key), null);
  });

  it("cacheKey is stable for the same URL", () => {
    const a = cacheKey("https://www.comprasal.gob.sv/api/v1/anios");
    const b = cacheKey("https://www.comprasal.gob.sv/api/v1/anios");
    assert.equal(a, b);
    assert.notEqual(a, cacheKey("https://www.comprasal.gob.sv/api/v1/estados"));
  });
});
