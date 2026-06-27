#!/usr/bin/env node
/**
 * COMPRASAL MCP server.
 *
 * Exposes El Salvador's public procurement data (comprasal.gob.sv) to MCP-compatible
 * AI assistants (Claude Desktop, etc.) as a set of read-only tools.
 *
 * Design constraints (from API reconnaissance):
 *  - Backend latency ~7s/request. Each tool = exactly ONE upstream call. No hidden loops.
 *  - Pagination is exposed to the USER (page/per_page args) rather than auto-walked,
 *    so responses stay within reasonable time.
 *  - Data is public under LACAP. This server only reads; it never writes.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  searchProcesses,
  getProcessDetail,
  getAwardReport,
  getSupplierContracts,
  listInstitutions,
  listModalities,
  listStates,
  listYears,
  ComprasalError,
} from "./comprasal.js";

const server = new Server(
  { name: "comprasal-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: "search_procurement",
    description:
      "Search awarded public procurement processes from El Salvador's COMPRASAL system. " +
      "Returns matched awards, each with institution, supplier, awarded amount, dates, and process code. " +
      "Use list_institutions first to turn an institution name into id_institucion. " +
      "HOW FILTERING WORKS: the upstream government API only filters server-side by id_institucion. " +
      "Year, free-text and date-range are applied CLIENT-SIDE by this server over the award date " +
      "(fecha_adjudicacion) and text fields, by scanning newest-first pages. Because of that, prefer " +
      "always passing id_institucion to keep the scan focused. The response includes a 'filtering' block: " +
      "if window_fully_covered is false, increase 'page' to keep scanning older records. " +
      "fecha_inicio/fecha_fin here DO filter on the actual award date. " +
      "Each upstream record may represent one lot/supplier line of a larger process. One call scans a bounded " +
      "number of pages (~7s each upstream), so it may take 10-40s.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Free-text, matched client-side against process name, code, institution, supplier.",
        },
        id_institucion: {
          type: "number",
          description: "Numeric institution id (from list_institutions). The ONLY server-side filter; pass it.",
        },
        anio: {
          type: "number",
          description: "Fiscal year, e.g. 2025. Applied client-side on the award date (fecha_adjudicacion).",
        },
        fecha_inicio: {
          type: "string",
          description: "Award-date lower bound YYYY-MM-DD (client-side, on fecha_adjudicacion).",
        },
        fecha_fin: {
          type: "string",
          description: "Award-date upper bound YYYY-MM-DD (client-side, on fecha_adjudicacion).",
        },
        id_modalidad: {
          type: "number",
          description: "Contracting modality id (from list_modalities). Sent upstream; effect unverified.",
        },
        id_estado: { type: "number", description: "Process state id (from list_states). Sent upstream." },
        nombre_proceso: { type: "string", description: "Filter by process name (client-side text match)." },
        page: {
          type: "number",
          description: "Scan window start, 1-based. Increase to reach older records when a year isn't yet covered.",
        },
        per_page: {
          type: "number",
          description: "Max matched results to return. Default 20. Keep modest due to ~7s/page upstream latency.",
        },
      },
    },
  },
  {
    name: "get_process_detail",
    description:
      "Get full detail of one procurement process by its proceso_compra id: code, internal code, " +
      "publication/award dates, awarded amount, contracting form, follow-up state, and the full stage calendar " +
      "(reception of offers, evaluation, etc.). The id comes from the 'proceso_compra.id' field of a " +
      "search_procurement result.",
    inputSchema: {
      type: "object",
      properties: {
        id_proceso_compra: {
          type: "number",
          description: "The proceso_compra.id from a search result.",
        },
      },
      required: ["id_proceso_compra"],
    },
  },
  {
    name: "get_award_report",
    description:
      "Get the richest award report for a process: contract name, contracting form, contractual term, " +
      "planned vs certified amounts, signature date, budget codes (cifrados presupuestarios), and the list of " +
      "bidders (oferentes). CAVEAT: this endpoint's id is NOT the proceso_compra.id used elsewhere; it lives in a " +
      "different id space. Obtain the correct id from a process detail payload. If you pass the wrong id you will " +
      "get a different contract. When unsure, prefer get_process_detail.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The award/contract id (distinct from proceso_compra.id).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_supplier_contracts",
    description:
      "Find the public contracts won by a specific SUPPLIER (company), by name, across institutions. " +
      "Useful to build a supplier's public-sector track record ('what has company X been awarded?'). " +
      "CRITICAL LIMITATION: the upstream government API cannot filter by supplier, and only sorts newest-first, " +
      "so this performs a BOUNDED scan of the most-recent records — it does NOT return a supplier's full multi-year " +
      "history. The response includes a 'coverage' block stating exactly what was scanned and warning when the result " +
      "is bounded. Always relay that limitation to the user; never present a bounded scan as exhaustive. " +
      "If you know which institution to look within, pass id_institucion to make the scan far faster and deeper. " +
      "Each page is ~7s; raising max_pages increases coverage but also wait time.",
    inputSchema: {
      type: "object",
      properties: {
        supplier: {
          type: "string",
          description: "Supplier/company name (or distinctive part of it), matched case-insensitively.",
        },
        id_institucion: {
          type: "number",
          description: "Optional institution id to narrow & deepen the scan (from list_institutions).",
        },
        anio: { type: "number", description: "Optional year filter (client-side, on award date)." },
        max_pages: {
          type: "number",
          description: "Max upstream pages to scan (default 6, ceiling 30). Higher = more coverage but slower (~7s/page).",
        },
      },
      required: ["supplier"],
    },
  },
  {
    name: "list_institutions",
    description:
      "List/search government institutions registered in COMPRASAL, to resolve a name into the numeric " +
      "id_institucion used by search_procurement. Pass 'search' with a partial name (e.g. 'salud', 'hacienda').",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Partial institution name." },
        page: { type: "number", description: "Page, default 1." },
        per_page: { type: "number", description: "Per page, default 30." },
      },
    },
  },
  {
    name: "list_modalities",
    description:
      "List contracting modalities (formas de contratación: Licitación competitiva, Libre Gestión, " +
      "Contratación Directa, Comparación de precios, etc.) with their ids, to use as id_modalidad filters.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_states",
    description:
      "List procurement process states with their ids, to use as id_estado filters.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_years",
    description: "List the fiscal years (ejercicios) available in COMPRASAL.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function ok(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const msg =
    err instanceof ComprasalError
      ? err.message
      : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "search_procurement": {
        const r = await searchProcesses(args as any);
        return ok({
          matches_in_scanned_window: r.pagination.total_rows,
          page: r.pagination.page,
          per_page: r.pagination.per_page,
          count: r.data.length,
          filtering: r.filtering,
          results: r.data,
        });
      }
      case "get_process_detail":
        return ok(await getProcessDetail(Number((args as any).id_proceso_compra)));
      case "get_award_report":
        return ok(await getAwardReport(Number((args as any).id)));
      case "get_supplier_contracts":
        return ok(await getSupplierContracts(args as any));
      case "list_institutions": {
        const r = await listInstitutions(args as any);
        return ok({ total_rows: r.pagination.total_rows, count: r.data.length, results: r.data });
      }
      case "list_modalities":
        return ok(await listModalities());
      case "list_states":
        return ok(await listStates());
      case "list_years":
        return ok(await listYears());
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return fail(err);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it doesn't corrupt the stdio JSON-RPC channel
  console.error("comprasal-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
