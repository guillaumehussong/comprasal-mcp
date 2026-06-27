/** Live integration smoke test against the real COMPRASAL API (requires network). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setHttpFetcher } from "../../src/comprasal.js";

describe("comprasal live API", () => {
  it("listYears returns data from real API", async () => {
    setHttpFetcher(null);
    const { listYears } = await import("../../src/comprasal.js");
    const years = await listYears();
    assert.ok(Array.isArray(years));
    assert.ok(years.length > 0);
  });
});
