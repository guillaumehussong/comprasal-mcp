/**
 * Thin HTTP client for the COMPRASAL public REST API.
 *
 * Base: https://www.comprasal.gob.sv/api/v1
 * No authentication required. Endpoints are public (LACAP-mandated procurement data).
 *
 * Key facts established by network reconnaissance (2026-06):
 *  - Pagination metadata is returned in RESPONSE HEADERS (total_rows, page, per_page),
 *    NOT in the body. We read them from headers.
 *  - Backend latency is ~7s/request and constant (not a throttle). Use generous timeouts.
 *  - Results are sorted by id DESC (newest first).
 *  - No rate limiting observed, but we stay polite: one request per tool call, no loops.
 */

import { request } from "undici";

const BASE = "https://www.comprasal.gob.sv/api/v1";

// A realistic browser UA keeps us under Cloudflare's radar (it does not challenge normal UAs).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Backend is slow (~7s). Give it room, then fail clearly.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface PagedResult<T> {
  data: T[];
  pagination: {
    page: number | null;
    per_page: number | null;
    total_rows: number | null;
  };
}

export class ComprasalError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ComprasalError";
  }
}

/** Low-level GET returning parsed JSON plus the pagination headers. */
async function getJson(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<{ body: any; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  let res;
  try {
    res = await request(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      headersTimeout: DEFAULT_TIMEOUT_MS,
      bodyTimeout: DEFAULT_TIMEOUT_MS,
    });
  } catch (err: any) {
    throw new ComprasalError(
      `Network error reaching COMPRASAL (${url.pathname}): ${err?.message ?? err}. ` +
        `The backend is slow (~7s) and occasionally unreachable; retrying usually works.`,
    );
  }

  if (res.statusCode >= 400) {
    throw new ComprasalError(
      `COMPRASAL returned HTTP ${res.statusCode} for ${url.pathname}.`,
      res.statusCode,
    );
  }

  let body: any;
  const text = await res.body.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ComprasalError(
      `COMPRASAL returned non-JSON for ${url.pathname} (first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  return { body, headers: res.headers };
}

function num(h: string | string[] | undefined): number | null {
  if (h === undefined) return null;
  const v = Array.isArray(h) ? h[0] : h;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * IMPORTANT — server-side filtering reality (confirmed by recon + live testing):
 * The upstream COMPRASAL API only honors `id_institucion`. The `anio`, `search`,
 * `nombre_proceso`, `fecha_inicio` and `fecha_fin` query params are SILENTLY IGNORED
 * by the government backend. We still send `id_institucion` (works) and `id_modalidad`
 * (sends, unverified), but we apply year / text / award-date filtering CLIENT-SIDE,
 * over `proceso_compra.fecha_adjudicacion` and the textual fields.
 *
 * Because the only reliable server filter is institution, and results are sorted by id
 * DESC (newest first), reaching e.g. 2025 awards requires fetching pages and filtering
 * locally until the desired window is covered. We cap how many pages we pull per call so
 * a single tool call stays bounded in time (~7s/page upstream).
 */

const PER_PAGE_UPSTREAM = 50; // fetched per upstream page (server honors per_page)
const MAX_PAGES_PER_CALL = 6; // hard cap so one tool call can't run away (≈ up to ~42s worst case)

function recordText(rec: any): string {
  // Flatten the fields a user might free-text search against.
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

function awardDate(rec: any): string | null {
  return rec?.proceso_compra?.fecha_adjudicacion ?? null;
}

function matchesYear(rec: any, anio?: number): boolean {
  if (!anio) return true;
  const d = awardDate(rec);
  if (d && d.length >= 4) return d.slice(0, 4) === String(anio);
  // Fallback to codigo_proceso like "3200-2026-P0001"
  const code: string = rec?.proceso_compra?.codigo_proceso ?? "";
  return code.includes(`-${anio}-`);
}

function matchesText(rec: any, search?: string): boolean {
  if (!search) return true;
  return recordText(rec).includes(search.toLowerCase());
}

function matchesAwardDateRange(rec: any, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const d = awardDate(rec);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * Search awarded procurement processes.
 * Wraps GET /publico/obtener/procesos/publicos, then applies client-side filtering for
 * everything the upstream ignores (year, text, award-date range).
 *
 * Returns up to `per_page` matched rows. Because filtering happens client-side, the
 * `total_rows` we report is the count of MATCHES FOUND within the pages we scanned, not
 * the upstream grand total; we also surface scan diagnostics so the caller knows whether
 * the window was fully covered.
 */
export async function searchProcesses(params: {
  page?: number;
  per_page?: number;
  id_institucion?: number;
  anio?: number;
  fecha_inicio?: string; // filters on AWARD date (fecha_adjudicacion), client-side
  fecha_fin?: string;
  id_estado?: number;
  id_modalidad?: number;
  nombre_proceso?: string;
  search?: string;
}): Promise<
  PagedResult<any> & {
    filtering: {
      server_side: string[];
      client_side: string[];
      pages_scanned: number;
      rows_scanned: number;
      upstream_total_rows: number | null;
      window_fully_covered: boolean;
      note: string;
    };
  }
> {
  const wantPerPage = params.per_page ?? 20;
  const textNeedle = params.search ?? params.nombre_proceso;

  const matched: any[] = [];
  let pagesScanned = 0;
  let rowsScanned = 0;
  let upstreamTotal: number | null = null;
  let exhausted = false;

  for (let i = 0; i < MAX_PAGES_PER_CALL; i++) {
    const upstreamPage = ((params.page ?? 1) - 1) * 1 + i + 1; // continue from requested page
    const { body, headers } = await getJson("/publico/obtener/procesos/publicos", {
      pagination: "true",
      page: upstreamPage,
      per_page: PER_PAGE_UPSTREAM,
      id_institucion: params.id_institucion, // the only server filter that works
      id_modalidad: params.id_modalidad, // sent; effectiveness unverified upstream
      id_estado: params.id_estado,
    });

    if (upstreamTotal === null) upstreamTotal = num(headers["total_rows"]);
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    pagesScanned++;
    rowsScanned += rows.length;

    for (const rec of rows) {
      if (
        matchesYear(rec, params.anio) &&
        matchesText(rec, textNeedle) &&
        matchesAwardDateRange(rec, params.fecha_inicio, params.fecha_fin)
      ) {
        matched.push(rec);
      }
    }

    if (rows.length < PER_PAGE_UPSTREAM) {
      exhausted = true;
      break;
    }
    if (matched.length >= wantPerPage) break;
  }

  const serverSide = ["id_institucion"];
  const clientSide: string[] = [];
  if (params.anio) clientSide.push("anio (on fecha_adjudicacion)");
  if (textNeedle) clientSide.push("text search");
  if (params.fecha_inicio || params.fecha_fin)
    clientSide.push("award-date range (fecha_adjudicacion)");

  return {
    data: matched.slice(0, wantPerPage),
    pagination: {
      page: params.page ?? 1,
      per_page: wantPerPage,
      total_rows: matched.length, // matches found in scanned window
    },
    filtering: {
      server_side: serverSide,
      client_side: clientSide,
      pages_scanned: pagesScanned,
      rows_scanned: rowsScanned,
      upstream_total_rows: upstreamTotal,
      window_fully_covered: exhausted || matched.length >= wantPerPage,
      note:
        "COMPRASAL only filters by id_institucion server-side; year/text/date are applied " +
        "client-side over fetched pages (newest-first). If window_fully_covered is false, " +
        "increase 'page' to continue scanning older records, or narrow by id_institucion.",
    },
  };
}

/** Full detail of one process (calendar, awarded amount, stages). */
export async function getProcessDetail(idProcesoCompra: number): Promise<any> {
  const { body } = await getJson(
    `/publico/obtener/detalle/procesos/publicos/${idProcesoCompra}`,
  );
  return body?.data ?? body;
}

/**
 * Award report: bidders, budget codes, planned vs certified amounts.
 * The {id} here is NOT proceso_compra.id — it lives in a different id space.
 * We expose this but document the caveat; callers should pass an id obtained from a
 * process detail payload, not the search list id.
 */
export async function getAwardReport(id: number): Promise<any> {
  const { body } = await getJson(`/publico/obtener/informe-adjudicacion/${id}`);
  return body?.data ?? body;
}

/**
 * Catalog: institutions. The upstream `search` param is IGNORED by the server, so we
 * fetch a large page and filter by name client-side.
 */
export async function listInstitutions(params: {
  search?: string;
  page?: number;
  per_page?: number;
}): Promise<PagedResult<any>> {
  const { body, headers } = await getJson("/publico/obtener/instituciones", {
    pagination: "true",
    page: 1,
    per_page: 1000, // pull the full catalog (institutions are few hundred) and filter locally
  });
  let data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];

  if (params.search) {
    const needle = params.search.toLowerCase();
    data = data.filter((inst: any) =>
      String(inst?.nombre ?? "")
        .toLowerCase()
        .includes(needle),
    );
  }

  // Optional client-side pagination over the filtered set.
  const perPage = params.per_page ?? 30;
  const page = params.page ?? 1;
  const start = (page - 1) * perPage;
  const pageData = data.slice(start, start + perPage);

  return {
    data: pageData,
    pagination: {
      page,
      per_page: perPage,
      total_rows: data.length, // count after client-side name filter
    },
  };
}

/** Catalog: contracting modalities (Licitación, Libre Gestión, etc.). */
export async function listModalities(): Promise<any[]> {
  const { body } = await getJson("/publico/obtener/modalidades");
  return body?.data ?? body ?? [];
}

/** Catalog: process states. */
export async function listStates(): Promise<any[]> {
  const { body } = await getJson("/publico/obtener/estados");
  return body?.data ?? body ?? [];
}

/** Catalog: available fiscal years. */
export async function listYears(): Promise<any[]> {
  const { body } = await getJson("/anios");
  return body?.data ?? body ?? [];
}

/** Extract the supplier name from a record, across the field shapes seen in the API. */
function supplierName(rec: any): string {
  const prov = rec?.proveedor ?? {};
  return [prov?.nombre, prov?.nombre_comercial, rec?.proceso_compra?.proveedor?.nombre]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Find all contracts won by a given supplier, by NAME, across institutions.
 *
 * HARD REALITY: the upstream API does not filter by supplier (the `search` param is
 * ignored), and without id_institucion every page is drawn from the full ~104k-row global
 * dataset, newest-first. So this can only scan a BOUNDED recent window — it CANNOT return a
 * supplier's full multi-year history. We make that explicit in the returned `coverage` block
 * so callers never mistake a bounded scan for an exhaustive one.
 *
 * Each upstream page costs ~7s. We cap pages (default 6 → up to ~50s) and let the caller
 * raise max_pages if they accept waiting longer.
 */
export async function getSupplierContracts(params: {
  supplier: string;
  max_pages?: number;
  id_institucion?: number; // optional: dramatically narrows & speeds the scan if known
  anio?: number; // optional client-side year filter
}): Promise<{
  supplier_query: string;
  matches: any[];
  coverage: {
    pages_scanned: number;
    rows_scanned: number;
    upstream_total_rows: number | null;
    scan_exhausted: boolean;
    bounded: boolean;
    warning: string;
  };
}> {
  const needle = params.supplier.toLowerCase().trim();
  const maxPages = Math.max(1, Math.min(params.max_pages ?? 6, 30)); // hard ceiling 30
  const matched: any[] = [];
  let pagesScanned = 0;
  let rowsScanned = 0;
  let upstreamTotal: number | null = null;
  let exhausted = false;

  for (let i = 0; i < maxPages; i++) {
    const { body, headers } = await getJson("/publico/obtener/procesos/publicos", {
      pagination: "true",
      page: i + 1,
      per_page: PER_PAGE_UPSTREAM,
      id_institucion: params.id_institucion, // only real server filter; narrows scan if given
    });

    if (upstreamTotal === null) upstreamTotal = num(headers["total_rows"]);
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    pagesScanned++;
    rowsScanned += rows.length;

    for (const rec of rows) {
      if (supplierName(rec).includes(needle) && matchesYear(rec, params.anio)) {
        matched.push(rec);
      }
    }

    if (rows.length < PER_PAGE_UPSTREAM) {
      exhausted = true;
      break;
    }
  }

  const bounded = !exhausted;
  return {
    supplier_query: params.supplier,
    matches: matched,
    coverage: {
      pages_scanned: pagesScanned,
      rows_scanned: rowsScanned,
      upstream_total_rows: upstreamTotal,
      scan_exhausted: exhausted,
      bounded,
      warning: bounded
        ? `Bounded scan: only the ${rowsScanned} most-recent records were searched (the upstream ` +
          `API cannot filter by supplier, so older contracts beyond this window are NOT included). ` +
          `This is NOT the supplier's full history. To go deeper, raise max_pages (slower, ~7s/page) ` +
          `or pass id_institucion if you know which institution to look within.`
        : `Full scan of the available dataset completed for this query window.`,
    },
  };
}
