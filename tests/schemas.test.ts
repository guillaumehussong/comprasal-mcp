import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getProcessDetailSchema,
  getSupplierContractsSchema,
  parseToolArgs,
  searchProcurementSchema,
  ValidationError,
} from "../src/schemas.js";

describe("schemas", () => {
  it("accepts valid search_procurement args", () => {
    const input = parseToolArgs(searchProcurementSchema, {
      id_institucion: 42,
      anio: 2025,
      page: 1,
      per_page: 20,
    });
    assert.equal(input.id_institucion, 42);
    assert.equal(input.anio, 2025);
  });

  it("rejects invalid date format", () => {
    assert.throws(
      () =>
        parseToolArgs(searchProcurementSchema, {
          fecha_inicio: "15-03-2025",
        }),
      ValidationError,
    );
  });

  it("rejects missing required get_process_detail id", () => {
    assert.throws(() => parseToolArgs(getProcessDetailSchema, {}), ValidationError);
  });

  it("rejects empty supplier name", () => {
    assert.throws(
      () => parseToolArgs(getSupplierContractsSchema, { supplier: "   " }),
      ValidationError,
    );
  });

  it("coerces string numeric ids like pre-v0.2 Number() calls", () => {
    const input = parseToolArgs(getProcessDetailSchema, { id_proceso_compra: "83743" });
    assert.equal(input.id_proceso_compra, 83743);
  });
});
