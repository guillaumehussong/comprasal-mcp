/** Zod schemas for validating MCP tool arguments before calling the API. */

import { z } from "zod";

/** Validates a positive integer, coercing string numbers from MCP clients. */
const positiveInt = z.coerce.number().int().positive();

/** Validates a non-empty string after trimming whitespace. */
const nonEmptyString = z.string().trim().min(1);

/** Input schema for the search_procurement tool. */
export const searchProcurementSchema = z.object({
  search: z.string().optional(),
  id_institucion: positiveInt.optional(),
  anio: z.coerce.number().int().min(2000).max(2100).optional(),
  fecha_inicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_inicio must be YYYY-MM-DD")
    .optional(),
  fecha_fin: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_fin must be YYYY-MM-DD")
    .optional(),
  id_modalidad: positiveInt.optional(),
  id_estado: positiveInt.optional(),
  nombre_proceso: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
});

/** Input schema for the get_process_detail tool. */
export const getProcessDetailSchema = z.object({
  id_proceso_compra: positiveInt,
});

/** Input schema for the get_award_report tool. */
export const getAwardReportSchema = z.object({
  id: positiveInt,
});

/** Input schema for the get_supplier_contracts tool. */
export const getSupplierContractsSchema = z.object({
  supplier: nonEmptyString,
  id_institucion: positiveInt.optional(),
  anio: z.coerce.number().int().min(2000).max(2100).optional(),
  max_pages: z.coerce.number().int().min(1).max(30).optional(),
});

/** Input schema for the list_institutions tool. */
export const listInstitutionsSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(200).optional(),
});

/** Input schema for tools that accept no arguments. */
export const emptySchema = z.object({});

/** Parsed input type for search_procurement. */
export type SearchProcurementInput = z.infer<typeof searchProcurementSchema>;

/** Parsed input type for get_process_detail. */
export type GetProcessDetailInput = z.infer<typeof getProcessDetailSchema>;

/** Parsed input type for get_award_report. */
export type GetAwardReportInput = z.infer<typeof getAwardReportSchema>;

/** Parsed input type for get_supplier_contracts. */
export type GetSupplierContractsInput = z.infer<typeof getSupplierContractsSchema>;

/** Parsed input type for list_institutions. */
export type ListInstitutionsInput = z.infer<typeof listInstitutionsSchema>;

/** Error thrown when tool arguments fail Zod validation. */
export class ValidationError extends Error {
  /** Creates a validation error with the given message. */
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Formats a Zod error into a short human-readable string. */
export function formatZodError(err: z.ZodError): string {
  const parts = err.errors.map((e) => `${e.path.join(".") || "input"}: ${e.message}`);
  return `Invalid arguments: ${parts.join("; ")}`;
}

/** Parses and validates tool arguments, throwing ValidationError on failure. */
export function parseToolArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    throw new ValidationError(formatZodError(result.error));
  }
  return result.data;
}

/** JSON Schema definitions exposed to MCP clients via ListTools. */
export const toolInputSchemas = {
  search_procurement: {
    type: "object" as const,
    properties: {
      search: { type: "string", description: "Free-text, matched client-side." },
      id_institucion: { type: "number", description: "Institution id from list_institutions." },
      anio: { type: "number", description: "Fiscal year (client-side on fecha_adjudicacion)." },
      fecha_inicio: { type: "string", description: "Award-date lower bound YYYY-MM-DD." },
      fecha_fin: { type: "string", description: "Award-date upper bound YYYY-MM-DD." },
      id_modalidad: { type: "number", description: "Modality id from list_modalities." },
      id_estado: { type: "number", description: "State id from list_states." },
      nombre_proceso: { type: "string", description: "Process name (client-side)." },
      page: { type: "number", description: "Scan window start, 1-based." },
      per_page: { type: "number", description: "Max matched results (default 20)." },
    },
  },
  get_process_detail: {
    type: "object" as const,
    properties: {
      id_proceso_compra: { type: "number", description: "proceso_compra.id from search results." },
    },
    required: ["id_proceso_compra"],
  },
  get_award_report: {
    type: "object" as const,
    properties: {
      id: { type: "number", description: "Award/contract id (not proceso_compra.id)." },
    },
    required: ["id"],
  },
  get_supplier_contracts: {
    type: "object" as const,
    properties: {
      supplier: { type: "string", description: "Supplier name (partial match)." },
      id_institucion: { type: "number", description: "Optional institution to narrow scan." },
      anio: { type: "number", description: "Optional year filter." },
      max_pages: { type: "number", description: "Max pages to scan (default 6, max 30)." },
    },
    required: ["supplier"],
  },
  list_institutions: {
    type: "object" as const,
    properties: {
      search: { type: "string", description: "Partial institution name." },
      page: { type: "number", description: "Page, default 1." },
      per_page: { type: "number", description: "Per page, default 30." },
    },
  },
  list_modalities: { type: "object" as const, properties: {} },
  list_states: { type: "object" as const, properties: {} },
  list_years: { type: "object" as const, properties: {} },
};
