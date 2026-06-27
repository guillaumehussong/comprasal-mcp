/** Unit tests for client-side record filter functions. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  awardDate,
  matchesAwardDateRange,
  matchesText,
  matchesYear,
  recordText,
  supplierName,
} from "../src/filters.js";

/** Sample procurement record used across filter tests. */
const sampleRecord = {
  institucion: { nombre: "Ministerio de Salud" },
  proveedor: { nombre: "ACME Corp", nombre_comercial: "ACME" },
  proceso_compra: {
    nombre_proceso: "Compra de medicamentos",
    codigo_proceso: "3200-2025-P0001",
    fecha_adjudicacion: "2025-03-15",
  },
};

describe("filters", () => {
  it("recordText flattens searchable fields", () => {
    const text = recordText(sampleRecord);
    assert.match(text, /ministerio de salud/);
    assert.match(text, /acme/);
    assert.match(text, /medicamentos/);
  });

  it("matchesYear uses fecha_adjudicacion", () => {
    assert.equal(matchesYear(sampleRecord, 2025), true);
    assert.equal(matchesYear(sampleRecord, 2024), false);
    assert.equal(matchesYear(sampleRecord), true);
  });

  it("matchesYear falls back to codigo_proceso", () => {
    const noDate = {
      proceso_compra: { codigo_proceso: "3200-2026-P0099" },
    };
    assert.equal(matchesYear(noDate, 2026), true);
  });

  it("matchesText is case-insensitive", () => {
    assert.equal(matchesText(sampleRecord, "SALUD"), true);
    assert.equal(matchesText(sampleRecord, "inexistente"), false);
  });

  it("matchesAwardDateRange respects bounds", () => {
    assert.equal(matchesAwardDateRange(sampleRecord, "2025-01-01", "2025-12-31"), true);
    assert.equal(matchesAwardDateRange(sampleRecord, "2025-04-01"), false);
    assert.equal(awardDate(sampleRecord), "2025-03-15");
  });

  it("supplierName aggregates provider fields", () => {
    assert.match(supplierName(sampleRecord), /acme corp/);
  });
});
