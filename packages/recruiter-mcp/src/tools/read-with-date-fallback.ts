import { httpErrorStatus } from "../upstream-error.js";
import {
  combineReadStatuses,
  readAllScopedRows,
  type ReadAllOptions,
  type ReadAllRowsResult,
  type ReadAllStatus,
} from "../read-all.js";
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
  /**
   * The declared fallback fields this read ALSO asked the upstream for, on the leg where the
   * native filter WORKED. Empty when no fallback field was declared, or when the native filter was
   * rejected and the whole window ran locally instead.
   */
  fallbackFieldsQueried: string[];
  /** Rows those extra legs recovered — rows the primary-field filter could never have returned. */
  fallbackFieldRowsAdded: number;
  /**
   * What the private-candidate gate withheld from the FALLBACK-FIELD legs, kept as its own number.
   *
   * Deliberately NOT added to the primary read's figure. The fallback leg's server-side filter
   * returns a population that OVERLAPS the primary leg's (a row can carry both dates), so the two
   * withheld counts are not disjoint and adding them would report a number no read produced. It is
   * reported beside the primary figure instead.
   */
  fallbackFieldPrivacyWithheld: number;
}

export const LOCAL_WINDOW_NOTE =
  "Upstream rejected the date filter (422 — this endpoint does not support it live); the window was applied locally to the complete scoped set. Rows lacking the field were excluded.";

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
 * and this must never become "always read everything". A 422 with THIS CALL'S OWN range params in
 * play re-reads without them and applies the window locally to the complete scoped set, and the
 * caller is handed everything it needs to say so out loud.
 *
 * Two things the fallback deliberately does NOT do, because both turn a self-heal into silent data
 * loss (Codex review of 61e48ad):
 *
 *  - It does not treat every 422 as a date 422. Only the bracket keys these `windowSpecs` produced
 *    are stripped, and when the request carries none of them the error is rethrown: a 422 about a
 *    malformed `job_ids` would otherwise be "healed" into a full unfiltered read of the tenant.
 *  - It does not strip range params it did not add. A caller filtering `salary[gte]` alongside a
 *    date window keeps that filter on the re-read.
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
    if (read.kind === "denial") {
      return {
        read,
        windowAppliedLocally: false,
        dateParamsRejected: [],
        windowFields,
        rowsMissingField: 0,
        fallbackFieldsQueried: [],
        fallbackFieldRowsAdded: 0,
        fallbackFieldPrivacyWithheld: 0,
      };
    }
    // The native filter held. A row whose PRIMARY field Greenhouse never wrote can never come back
    // from a primary-field range filter, so on this leg the declared fallback fields have to be
    // asked for separately or the two legs of this helper would answer with different populations —
    // the fallback leg counting a `sent_on`-dated hire and the native leg silently missing it.
    const supplement = await readFallbackFieldLegs<T>(
      runtime, exposedToolName, scopedToolName, params, windowSpecs, deadline, options
    );
    return {
      read: supplement.rows.length > 0 || supplement.warnings.length > 0
        ? {
            ...read,
            rows: [...read.rows, ...supplement.rows],
            rawRowsRead: read.rawRowsRead + supplement.rawRowsRead,
            pagesRead: read.pagesRead + supplement.pagesRead,
            warnings: [...read.warnings, ...supplement.warnings],
            status: combineReadStatuses([read.status, ...supplement.statuses]),
            complete: combineReadStatuses([read.status, ...supplement.statuses]) === "complete" && read.complete,
          }
        : read,
      windowAppliedLocally: false,
      dateParamsRejected: [],
      windowFields,
      rowsMissingField: 0,
      fallbackFieldsQueried: supplement.fieldsQueried,
      fallbackFieldRowsAdded: supplement.rows.length,
      fallbackFieldPrivacyWithheld: supplement.privacyWithheld,
    };
  } catch (error) {
    if (windowSpecs.length === 0 || httpErrorStatus(error) !== 422) throw error;
    // Exactly the bracket keys these specs asked for — never every `*[gte]` in the request.
    const ownBracketKeys = new Set(Object.keys(bracketParamsForWindows(windowSpecs)));
    const rejected = Object.keys(params).filter((key) => ownBracketKeys.has(key));
    // A 422 on a request that carries none of this window's bracket params is about something
    // else. Re-reading without them would drop nothing and hide a real error.
    if (rejected.length === 0) throw error;
    const stripped = Object.fromEntries(Object.entries(params).filter(([key]) => !ownBracketKeys.has(key)));
    const read = await readAllScopedRows<T>(runtime, exposedToolName, scopedToolName, stripped, deadline, options);
    if (read.kind === "denial") {
      return {
        read,
        windowAppliedLocally: false,
        dateParamsRejected: rejected.sort(),
        windowFields,
        rowsMissingField: 0,
        fallbackFieldsQueried: [],
        fallbackFieldRowsAdded: 0,
        fallbackFieldPrivacyWithheld: 0,
      };
    }
    const windowed = applyLocalWindow(read.rows, windowSpecs);
    return {
      read: { ...read, rows: windowed.rows },
      windowAppliedLocally: true,
      dateParamsRejected: rejected.sort(),
      windowFields,
      rowsMissingField: windowed.missing,
      fallbackFieldsQueried: [],
      fallbackFieldRowsAdded: 0,
      fallbackFieldPrivacyWithheld: 0,
    };
  }
}

interface FallbackLegResult<T extends Record<string, unknown>> {
  rows: T[];
  fieldsQueried: string[];
  rawRowsRead: number;
  pagesRead: number;
  privacyWithheld: number;
  statuses: ReadAllStatus[];
  warnings: string[];
}

/**
 * One extra read per declared fallback field, for the leg where the native date filter WORKED.
 *
 * Each leg swaps that spec's own bracket params for the fallback field's, leaves every other
 * filter in place, and keeps only the rows the primary filter structurally could not have
 * returned — the ones carrying no value in the primary field (or in any earlier fallback), so the
 * legs never overlap and no row is counted twice.
 *
 * This is a read the previous version did not make, and it is an EXPANSION, not a narrowing: on
 * `/v3/offers` the native leg 422s live, so it costs nothing there; where an endpoint really does
 * honour the filter it buys back the rows a primary-field-only window would have dropped without
 * saying so. A failure on this leg degrades to a warning: the primary rows are real either way.
 */
async function readFallbackFieldLegs<T extends Record<string, unknown>>(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  params: Record<string, unknown>,
  windowSpecs: readonly DateWindowSpec[],
  deadline: ToolDeadline | undefined,
  options: ReadAllOptions
): Promise<FallbackLegResult<T>> {
  const result: FallbackLegResult<T> = {
    rows: [],
    fieldsQueried: [],
    rawRowsRead: 0,
    pagesRead: 0,
    privacyWithheld: 0,
    statuses: [],
    warnings: [],
  };
  for (const spec of windowSpecs) {
    const fallbacks = spec.fallbackFields ?? [];
    for (let index = 0; index < fallbacks.length; index += 1) {
      const field = fallbacks[index] as string;
      const legSpec: DateWindowSpec = { field, gte: spec.gte, lte: spec.lte, gt: spec.gt, lt: spec.lt };
      const ownKeys = new Set(Object.keys(bracketParamsForWindows([spec])));
      const legParams = {
        ...Object.fromEntries(Object.entries(params).filter(([key]) => !ownKeys.has(key))),
        ...bracketParamsForWindows([legSpec]),
      };
      let read: ReadAllRowsResult<T>;
      try {
        read = await readAllScopedRows<T>(runtime, exposedToolName, scopedToolName, legParams, deadline, options);
      } catch (error) {
        result.warnings.push(
          `the ${field} leg of the ${spec.field} window failed (${error instanceof Error ? error.message : String(error)}), so rows carrying only ${field} may be missing`
        );
        continue;
      }
      if (read.kind === "denial") {
        result.warnings.push(`the ${field} leg of the ${spec.field} window was denied, so rows carrying only ${field} may be missing`);
        continue;
      }
      result.fieldsQueried.push(field);
      result.rawRowsRead += read.rawRowsRead;
      result.pagesRead += read.pagesRead;
      result.privacyWithheld += read.privacyWithheld;
      result.statuses.push(read.status);
      result.warnings.push(...read.warnings);
      // Only the rows this leg alone can supply: everything earlier in the fallback order absent.
      const earlier = [spec.field, ...fallbacks.slice(0, index)];
      const recovered = read.rows.filter((row) => earlier.every((name) => !isPresentString(row[name])));
      result.rows.push(...applyLocalWindow(recovered, [legSpec]).rows);
    }
  }
  return result;
}

function isPresentString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
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
