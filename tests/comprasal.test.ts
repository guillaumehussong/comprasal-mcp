import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  getSupplierContracts,
  listInstitutions,
  searchProcesses,
  setHttpFetcher,
} from "../src/comprasal.js";

const mockProcesses = {
  data: Array.from({ length: 50 }, (_, i) =>
    i === 0
      ? {
          proveedor: { nombre: "Proveedor Alpha SA de CV" },
          proceso_compra: {
            nombre_proceso: "Suministro médico",
            codigo_proceso: "3200-2025-P0001",
            fecha_adjudicacion: "2025-06-01",
          },
          institucion: { nombre: "Salud" },
        }
      : {
          proveedor: { nombre: `Empresa ${i}` },
          proceso_compra: {
            nombre_proceso: "Otros bienes",
            codigo_proceso: `3200-2025-P${String(i).padStart(4, "0")}`,
            fecha_adjudicacion: "2025-06-01",
          },
          institucion: { nombre: "Varios" },
        },
  ),
};

const mockInstitutions = {
  data: [
    { id: 1, nombre: "Ministerio de Salud" },
    { id: 2, nombre: "Ministerio de Hacienda" },
  ],
};

function mockFetcher(routes: Record<string, unknown>) {
  return async (path: string) => {
    const body = routes[path];
    if (body === undefined) {
      throw new Error(`Unexpected path: ${path}`);
    }
    return {
      body,
      headers: { total_rows: String((body as any)?.data?.length ?? 0) },
      fromCache: false,
    };
  };
}

describe("comprasal (mocked HTTP)", () => {
  before(() => {
    setHttpFetcher(
      mockFetcher({
        "/publico/obtener/procesos/publicos": mockProcesses,
        "/publico/obtener/instituciones": mockInstitutions,
      }),
    );
  });

  after(() => {
    setHttpFetcher(null);
  });

  it("searchProcesses applies client-side year filter", async () => {
    const r = await searchProcesses({ anio: 2024, per_page: 10 });
    assert.equal(r.data.length, 0);
    assert.equal(r.filtering.client_side.includes("anio (on fecha_adjudicacion)"), true);
  });

  it("searchProcesses applies client-side text filter", async () => {
    const r = await searchProcesses({ search: "proveedor alpha", per_page: 1 });
    assert.equal(r.data.length, 1);
    assert.equal(r.filtering.client_side.includes("text search"), true);
  });

  it("listInstitutions filters by name client-side", async () => {
    const r = await listInstitutions({ search: "hacienda" });
    assert.equal(r.data.length, 1);
    assert.equal((r.data[0] as any).nombre, "Ministerio de Hacienda");
  });

  it("getSupplierContracts finds supplier in scanned window", async () => {
    const r = await getSupplierContracts({ supplier: "Alpha", max_pages: 1 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.coverage.bounded, true);
    assert.match(r.coverage.warning, /Bounded scan/);
  });
});

describe("comprasal live API", () => {
  it("listYears returns data from real API", { skip: !process.env.RUN_LIVE_TESTS }, async () => {
    setHttpFetcher(null);
    const { listYears } = await import("../src/comprasal.js");
    const years = await listYears();
    assert.ok(Array.isArray(years));
    assert.ok(years.length > 0);
  });
});
