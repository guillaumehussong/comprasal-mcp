/** HTTP client for the public COMPRASAL REST API (comprasal.gob.sv). */

import { request } from "undici";
import { cacheKey, getGlobalCache } from "./cache.js";
import {
  matchesAwardDateRange,
  matchesText,
  matchesYear,
  supplierName,
} from "./filters.js";

/** Base URL for all COMPRASAL API requests. */
const BASE = "https://www.comprasal.gob.sv/api/v1";

/** Browser-like User-Agent to avoid Cloudflare blocks. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Request timeout in ms (the upstream API is slow, ~7s per call). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Number of records fetched per upstream page. */
const PER_PAGE_UPSTREAM = 50;

/** Max upstream pages scanned in a single searchProcesses call. */
const MAX_PAGES_PER_CALL = 6;

/** Paginated API result with data rows and pagination metadata. */
export interface PagedResult<T> {
  data: T[];
  pagination: {
    page: number | null;
    per_page: number | null;
    total_rows: number | null;
  };
}

/** Error thrown when the COMPRASAL API returns a network or HTTP failure. */
export class ComprasalError extends Error {
  /** Creates an API error, optionally with an HTTP status code. */
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ComprasalError";
  }
}

/** Parsed JSON body plus response headers from one API call. */
export type JsonResponse = {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  fromCache?: boolean;
};

/** Function signature for fetching JSON from the COMPRASAL API. */
export type HttpFetcher = (
  path: string,
  query?: Record<string, string | number | undefined>,
) => Promise<JsonResponse>;

/** Optional mock fetcher injected during tests. */
let httpFetcher: HttpFetcher | null = null;

/** Sets a custom HTTP fetcher (pass null to restore the default). */
export function setHttpFetcher(fetcher: HttpFetcher | null): void {
  httpFetcher = fetcher;
}

/** Performs a real GET request to COMPRASAL, with optional disk caching. */
async function defaultGetJson(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<JsonResponse> {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const key = cacheKey(url.toString());
  const cache = getGlobalCache();
  const cached = await cache.get(key);
  if (cached) {
    return { body: cached.body, headers: cached.headers, fromCache: true };
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ComprasalError(
      `Network error reaching COMPRASAL (${url.pathname}): ${msg}. ` +
        `The backend is slow (~7s) and occasionally unreachable; retrying usually works.`,
    );
  }

  if (res.statusCode >= 400) {
    throw new ComprasalError(
      `COMPRASAL returned HTTP ${res.statusCode} for ${url.pathname}.`,
      res.statusCode,
    );
  }

  let body: unknown;
  const text = await res.body.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ComprasalError(
      `COMPRASAL returned non-JSON for ${url.pathname} (first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  const headers = res.headers as Record<string, string | string[] | undefined>;
  await cache.set(key, body, headers);
  return { body, headers, fromCache: false };
}

/** Fetches JSON using the mock fetcher if set, otherwise the real API. */
async function getJson(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<JsonResponse> {
  const fetcher = httpFetcher ?? defaultGetJson;
  return fetcher(path, query);
}

/** Parses a numeric value from a response header. */
function num(h: string | string[] | undefined): number | null {
  if (h === undefined) return null;
  const v = Array.isArray(h) ? h[0] : h;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Searches awarded processes with client-side filtering over fetched pages. */
export async function searchProcesses(params: {
  page?: number;
  per_page?: number;
  id_institucion?: number;
  anio?: number;
  fecha_inicio?: string;
  fecha_fin?: string;
  id_estado?: number;
  id_modalidad?: number;
  nombre_proceso?: string;
  search?: string;
}): Promise<
  PagedResult<unknown> & {
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

  const matched: unknown[] = [];
  let pagesScanned = 0;
  let rowsScanned = 0;
  let upstreamTotal: number | null = null;
  let exhausted = false;

  for (let i = 0; i < MAX_PAGES_PER_CALL; i++) {
    const upstreamPage = ((params.page ?? 1) - 1) * 1 + i + 1;
    const { body, headers } = await getJson("/publico/obtener/procesos/publicos", {
      pagination: "true",
      page: upstreamPage,
      per_page: PER_PAGE_UPSTREAM,
      id_institucion: params.id_institucion,
      id_modalidad: params.id_modalidad,
      id_estado: params.id_estado,
    });

    if (upstreamTotal === null) upstreamTotal = num(headers["total_rows"]);
    const rows = Array.isArray((body as any)?.data)
      ? (body as any).data
      : Array.isArray(body)
        ? body
        : [];
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
      total_rows: matched.length,
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

/** Fetches full detail and stage calendar for one procurement process. */
export async function getProcessDetail(idProcesoCompra: number): Promise<unknown> {
  const { body } = await getJson(
    `/publico/obtener/detalle/procesos/publicos/${idProcesoCompra}`,
  );
  return (body as any)?.data ?? body;
}

/** Fetches the award report with bidders, amounts, and budget codes. */
export async function getAwardReport(id: number): Promise<unknown> {
  const { body } = await getJson(`/publico/obtener/informe-adjudicacion/${id}`);
  return (body as any)?.data ?? body;
}

/** Lists institutions, with optional client-side name filtering and pagination. */
export async function listInstitutions(params: {
  search?: string;
  page?: number;
  per_page?: number;
}): Promise<PagedResult<unknown>> {
  const { body } = await getJson("/publico/obtener/instituciones", {
    pagination: "true",
    page: 1,
    per_page: 1000,
  });
  let data = Array.isArray((body as any)?.data)
    ? (body as any).data
    : Array.isArray(body)
      ? body
      : [];

  if (params.search) {
    const needle = params.search.toLowerCase();
    data = data.filter((inst: any) =>
      String(inst?.nombre ?? "")
        .toLowerCase()
        .includes(needle),
    );
  }

  const perPage = params.per_page ?? 30;
  const page = params.page ?? 1;
  const start = (page - 1) * perPage;
  const pageData = data.slice(start, start + perPage);

  return {
    data: pageData,
    pagination: {
      page,
      per_page: perPage,
      total_rows: data.length,
    },
  };
}

/** Returns all contracting modalities (licitación, contratación directa, etc.). */
export async function listModalities(): Promise<unknown[]> {
  const { body } = await getJson("/publico/obtener/modalidades");
  return (body as any)?.data ?? body ?? [];
}

/** Returns all procurement process states with their ids. */
export async function listStates(): Promise<unknown[]> {
  const { body } = await getJson("/publico/obtener/estados");
  return (body as any)?.data ?? body ?? [];
}

/** Returns all fiscal years available in COMPRASAL. */
export async function listYears(): Promise<unknown[]> {
  const { body } = await getJson("/anios");
  return (body as any)?.data ?? body ?? [];
}

/** Finds contracts won by a supplier name within a bounded recent scan window. */
export async function getSupplierContracts(params: {
  supplier: string;
  max_pages?: number;
  id_institucion?: number;
  anio?: number;
}): Promise<{
  supplier_query: string;
  matches: unknown[];
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
  const maxPages = Math.max(1, Math.min(params.max_pages ?? 6, 30));
  const matched: unknown[] = [];
  let pagesScanned = 0;
  let rowsScanned = 0;
  let upstreamTotal: number | null = null;
  let exhausted = false;

  for (let i = 0; i < maxPages; i++) {
    const { body, headers } = await getJson("/publico/obtener/procesos/publicos", {
      pagination: "true",
      page: i + 1,
      per_page: PER_PAGE_UPSTREAM,
      id_institucion: params.id_institucion,
    });

    if (upstreamTotal === null) upstreamTotal = num(headers["total_rows"]);
    const rows = Array.isArray((body as any)?.data)
      ? (body as any).data
      : Array.isArray(body)
        ? body
        : [];
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
