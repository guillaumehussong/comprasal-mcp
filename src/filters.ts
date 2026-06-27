/** Client-side filters applied because the upstream API ignores most query params. */

/** Builds a lowercase search string from all text fields on a record. */
export function recordText(rec: any): string {
  const pc = rec?.proceso_compra ?? {};
  const prov = rec?.proveedor ?? {};
  return [
    pc?.nombre_proceso,
    pc?.codigo_proceso,
    rec?.institucion?.nombre,
    pc?.Institucion?.nombre,
    prov?.nombre,
    prov?.nombre_comercial,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Returns the award date (fecha_adjudicacion) from a record, or null. */
export function awardDate(rec: any): string | null {
  return rec?.proceso_compra?.fecha_adjudicacion ?? null;
}

/** Returns true if the record matches the given fiscal year. */
export function matchesYear(rec: any, anio?: number): boolean {
  if (!anio) return true;
  const d = awardDate(rec);
  if (d && d.length >= 4) return d.slice(0, 4) === String(anio);
  const code: string = rec?.proceso_compra?.codigo_proceso ?? "";
  return code.includes(`-${anio}-`);
}

/** Returns true if the record contains the search text (case-insensitive). */
export function matchesText(rec: any, search?: string): boolean {
  if (!search) return true;
  return recordText(rec).includes(search.toLowerCase());
}

/** Returns true if the record's award date falls within the given range. */
export function matchesAwardDateRange(rec: any, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const d = awardDate(rec);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/** Returns a lowercase string with all supplier name fields from a record. */
export function supplierName(rec: any): string {
  const prov = rec?.proveedor ?? {};
  return [prov?.nombre, prov?.nombre_comercial, rec?.proceso_compra?.proveedor?.nombre]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
