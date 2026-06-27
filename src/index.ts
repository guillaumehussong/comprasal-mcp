#!/usr/bin/env node
/**
 * COMPRASAL MCP server.
 *
 * Exposes El Salvador's public procurement data (comprasal.gob.sv) to MCP-compatible
 * AI assistants (Claude Desktop, Cursor, etc.) as a set of read-only tools.
 *
 * Design constraints (from API reconnaissance):
 *  - Backend latency ~7s/request. Multi-page tools scan a bounded number of pages per call.
 *  - Pagination is exposed to the USER (page/per_page args) rather than auto-walked
 *    without limit, so responses stay within reasonable time.
 *  - Responses are optionally cached on disk (see cache.ts).
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
import {
  emptySchema,
  getAwardReportSchema,
  getProcessDetailSchema,
  getSupplierContractsSchema,
  listInstitutionsSchema,
  parseToolArgs,
  searchProcurementSchema,
  toolInputSchemas,
  ValidationError,
} from "./schemas.js";

const server = new Server(
  { name: "comprasal-mcp", version: "0.2.0" },
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
    inputSchema: toolInputSchemas.search_procurement,
  },
  {
    name: "get_process_detail",
    description:
      "Get full detail of one procurement process by its proceso_compra id: code, internal code, " +
      "publication/award dates, awarded amount, contracting form, follow-up state, and the full stage calendar " +
      "(reception of offers, evaluation, etc.). The id comes from the 'proceso_compra.id' field of a " +
      "search_procurement result.",
    inputSchema: toolInputSchemas.get_process_detail,
  },
  {
    name: "get_award_report",
    description:
      "Get the richest award report for a process: contract name, contracting form, contractual term, " +
      "planned vs certified amounts, signature date, budget codes (cifrados presupuestarios), and the list of " +
      "bidders (oferentes). CAVEAT: this endpoint's id is NOT the proceso_compra.id used elsewhere; it lives in a " +
      "different id space. Obtain the correct id from a process detail payload. If you pass the wrong id you will " +
      "get a different contract. When unsure, prefer get_process_detail.",
    inputSchema: toolInputSchemas.get_award_report,
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
    inputSchema: toolInputSchemas.get_supplier_contracts,
  },
  {
    name: "list_institutions",
    description:
      "List/search government institutions registered in COMPRASAL, to resolve a name into the numeric " +
      "id_institucion used by search_procurement. Pass 'search' with a partial name (e.g. 'salud', 'hacienda').",
    inputSchema: toolInputSchemas.list_institutions,
  },
  {
    name: "list_modalities",
    description:
      "List contracting modalities (formas de contratación: Licitación competitiva, Libre Gestión, " +
      "Contratación Directa, Comparación de precios, etc.) with their ids, to use as id_modalidad filters.",
    inputSchema: toolInputSchemas.list_modalities,
  },
  {
    name: "list_states",
    description:
      "List procurement process states with their ids, to use as id_estado filters.",
    inputSchema: toolInputSchemas.list_states,
  },
  {
    name: "list_years",
    description: "List the fiscal years (ejercicios) available in COMPRASAL.",
    inputSchema: toolInputSchemas.list_years,
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function ok(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const msg =
    err instanceof ComprasalError || err instanceof ValidationError
      ? err.message
      : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "search_procurement": {
        const input = parseToolArgs(searchProcurementSchema, args);
        const r = await searchProcesses(input);
        return ok({
          matches_in_scanned_window: r.pagination.total_rows,
          page: r.pagination.page,
          per_page: r.pagination.per_page,
          count: r.data.length,
          filtering: r.filtering,
          results: r.data,
        });
      }
      case "get_process_detail": {
        const input = parseToolArgs(getProcessDetailSchema, args);
        return ok(await getProcessDetail(input.id_proceso_compra));
      }
      case "get_award_report": {
        const input = parseToolArgs(getAwardReportSchema, args);
        return ok(await getAwardReport(input.id));
      }
      case "get_supplier_contracts": {
        const input = parseToolArgs(getSupplierContractsSchema, args);
        return ok(await getSupplierContracts(input));
      }
      case "list_institutions": {
        const input = parseToolArgs(listInstitutionsSchema, args);
        const r = await listInstitutions(input);
        return ok({ total_rows: r.pagination.total_rows, count: r.data.length, results: r.data });
      }
      case "list_modalities":
        parseToolArgs(emptySchema, args);
        return ok(await listModalities());
      case "list_states":
        parseToolArgs(emptySchema, args);
        return ok(await listStates());
      case "list_years":
        parseToolArgs(emptySchema, args);
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
  console.error("comprasal-mcp v0.2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
