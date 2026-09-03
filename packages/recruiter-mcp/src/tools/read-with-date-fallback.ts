import { httpErrorStatus } from "../upstream-error.js";
import { readAllScopedRows, type ReadAllOptions, type ReadAllRowsResult } from "../read-all.js";
import type { RecruiterToolRuntime, ToolDeadline } from "../runtime.js";

/**
 * A date window a caller asked for, in the shape both legs of the read need: the field it applies
 * to, its bounds, and (for the hire path) the fields that stand in when the primary one is absent.
 *
 * `fallbackFields` exists because a hire's date is `resolved_at` OR, when Greenhouse never wrote
 * one, `sent_on` — windowing a hire set on `resolved_at` alone would drop those rows silently on
 * the fallback leg, which is exactly the class of quiet loss this module was lifted out to stop.
 * Empty for every other caller, whose window means one field and no substitutes.
 */
export interface DateWindowSpec {
  field: string;
  fallbackFields?: string[];
  gte?: string;
  lte?: string;
  gt?: string;
  lt?: string;
}

export interface DateFallbackOutcome<T extends Record<string, unknown>> {
  read: ReadAllRowsResult<T>;
  /** True when the upstream rejected the native filter and the window was applied here instead. */
  windowAppliedLocally: boolean;
  /** The bracket params the upstream 422'd, verbatim, so the disclosure can name them. */
  dateParamsRejected: string[];
  /** The row-level fields the local window was evaluated on (primary + declared fallbacks). */
  windowFields: string[];
  /** Rows dropped by the local window because they carried none of those fields. */
  rowsMissingField: number;
}

export const LOCAL_WINDOW_NOTE =
  "Upstream rejected the date filter (422 — this endpoint does not support it live); the window was applied locally to the complete scoped set. Rows lacking the field were excluded.";

const RANGE_BRACKET_PATTERN = /\[(gte|lte|gt|lt)\]$/;

/**
 * The v3 bracket params for a set of window specs, so every caller that wants a server-side date
 * filter builds the SAME shape (`resolved_at[gte]=…`) and the fallback leg can strip exactly what
 * it added.
 */
export function bracketParamsForWindows(specs: readonly DateWindowSpec[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const spec of specs) {
    for (const operator of ["gte", "lte", "gt", "lt"] as const) {
      const bound = spec[operator];
      if (typeof bound === "string" && bound.length > 0) params[`${spec.field}[${operator}]`] = bound;
    }
  }
  return params;
}

/**
 * Read the complete scoped set for a windowed query, self-healing the docs-vs-live divergence that
 * the live demo (2026-07-02) turned up and the repo's own live probe still records: some LIVE
 * endpoints 422 the date filters the vendored contract advertises. `/v3/offers` rejects every one
 * of them (`resolved_at`, `created_at`, `updated_at`); `/v3/applications` accepts them.
 *
 * Native filtering stays the FIRST attempt — it is cheap wherever the endpoint really supports it,
 * and this must never become "always read everything". A 422 with range params in play re-reads
 * WITHOUT them and applies the window locally to the complete scoped set, and the caller is handed
 * everything it needs to say so out loud.
 *
 * Lifted out of `runEvidenceListRead`, where it was the only copy and unreachable from the recipes
 * and the planner (`read-all.ts` rethrows a non-timeout error), so the hire path and the planner's
 * offer read get the same two legs rather than a hard failure on the endpoint that needs it most.
 */
export async function readAllWithDateFallback<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  params: Record<string, unknown>,
  windowSpecs: readonly DateWindowSpec[],
  deadline?: ToolDeadline,
  options: ReadAllOptions = {}
): Promise<DateFallbackOutcome<T>> {
  const windowFields = [...new Set(windowSpecs.flatMap((spec) => [spec.field, ...(spec.fallbackFields ?? [])]))];
  try {
    const read = await readAllScopedRows<T>(runtime, exposedToolName, scopedToolName, params, deadline, options);
    return { read, windowAppliedLocally: false, dateParamsRejected: [], windowFields, rowsMissingField: 0 };
  } catch (error) {
    if (windowSpecs.length === 0 || httpErrorStatus(error) !== 422) throw error;
    const rejected = Object.keys(params).filter((key) => RANGE_BRACKET_PATTERN.test(key));
    const stripped = Object.fromEntries(Object.entries(params).filter(([key]) => !RANGE_BRACKET_PATTERN.test(key)));
    const read = await readAllScopedRows<T>(runtime, exposedToolName, scopedToolName, stripped, deadline, options);
    if (read.kind === "denial") {
      return { read, windowAppliedLocally: false, dateParamsRejected: rejected, windowFields, rowsMissingField: 0 };
    }
    const windowed = applyLocalWindow(read.rows, windowSpecs);
    return {
      read: { ...read, rows: windowed.rows },
      windowAppliedLocally: true,
      dateParamsRejected: rejected.sort(),
      windowFields,
      rowsMissingField: windowed.missing,
    };
  }
}

/** The `read.window_applied_locally` envelope, or undefined when the native filter held. */
export function localWindowDisclosure<T extends Record<string, unknown>>(
  outcome: DateFallbackOutcome<T>
): { fields: string[]; rows_missing_field: number; note: string } | undefined {
  if (!outcome.windowAppliedLocally) return undefined;
  return { fields: outcome.windowFields, rows_missing_field: outcome.rowsMissingField, note: LOCAL_WINDOW_NOTE };
}

// Date-only bounds (YYYY-MM-DD) are END-of-day inclusive for upper bounds under local windowing —
// a timestamp ON the lte date must stay in-window, matching the upstream filters' semantics.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function upperBound(bound: string): string {
  return DATE_ONLY_PATTERN.test(bound) ? `${bound}T23:59:59.999Z` : bound;
}

export function applyLocalWindow<T extends Record<string, unknown>>(
  rows: T[],
  specs: readonly DateWindowSpec[]
): { rows: T[]; missing: number } {
  let missing = 0;
  const kept = rows.filter((row) => {
    for (const spec of specs) {
      const value = firstPresentField(row, spec);
      if (value === null) {
        missing += 1;
        return false;
      }
      if (spec.gte && value < spec.gte) return false;
      if (spec.gt && value <= upperBound(spec.gt)) return false;
      if (spec.lte && value > upperBound(spec.lte)) return false;
      if (spec.lt && value >= spec.lt) return false;
    }
    return true;
  });
  return { rows: kept, missing };
}

function firstPresentField(row: Record<string, unknown>, spec: DateWindowSpec): string | null {
  for (const field of [spec.field, ...(spec.fallbackFields ?? [])]) {
    const value = row[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
