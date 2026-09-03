/**
 * The scorecard recipes' window, read the same way it is reported.
 *
 * Both scorecard recipes analyse a card on its INTERVIEW date, falling back to its SUBMISSION date
 * when no interview date was recorded — but both used to ask Greenhouse for `created_at >= window_start`
 * instead. Those are different clocks: a card created before the window but interviewed inside it was
 * dropped upstream and never counted, while a card created inside the window but interviewed long
 * before it was read and then thrown away in memory. /v3/scorecards accepts `interviewed_at` and
 * `submitted_at` as server-side range filters (harvest-v3-registry.generated.ts, /v3/scorecards), so
 * the recipe now selects on the basis it reports.
 *
 * Two reads, unioned: one bounded on `interviewed_at`, one on `submitted_at`. The second read is what
 * catches a card carrying only a submission date; the union is deduped so a card matching both filters
 * is counted once. The in-memory `scorecardWindowBasis` check stays authoritative over both.
 *
 * Range encoding: v3 takes bracket params (`interviewed_at[gte]=...`), the same form
 * `evidence-read.ts` translates the model-facing date shorthands into, and the form
 * `sanitizeReadParams` explicitly admits by matching a bracket key against its BASE param name
 * (limits.ts). The older `gte|<iso>` pipe string used for `created_at` is not translated anywhere
 * between here and `buildUrlForAdapter`, so it reaches Greenhouse verbatim.
 */

import { combineReadStatuses, readAllScopedRows, type ReadAllRowsResult } from "../read-all.js";
import { readScorecardRowsForJobScope } from "./application-job-lookup.js";
import type { RecruiterToolRuntime, ToolDeadline } from "../runtime.js";

export interface ScorecardWindowRow extends Record<string, unknown> {
  id: number | null;
  submitted_at: string | null;
  interviewed_at: string | null;
}

/**
 * The one timestamp a scorecard is analysed on: the interview it was owed against, or — when the
 * tenant recorded no interview date — the moment it was submitted. `null` means the card carries
 * neither and cannot be placed on the recipe's clock at all.
 */
export function scorecardWindowBasis(row: { interviewed_at?: unknown; submitted_at?: unknown }): string | null {
  const basis = (row.interviewed_at ?? row.submitted_at) as unknown;
  return typeof basis === "string" && basis.length > 0 ? basis : null;
}

export type ScorecardWindowPartition = "in_window" | "outside_window" | "missing_basis";

export function partitionScorecardByWindow(
  row: { interviewed_at?: unknown; submitted_at?: unknown },
  startIso: string,
  endIso: string
): ScorecardWindowPartition {
  const basis = scorecardWindowBasis(row);
  if (basis === null) return "missing_basis";
  const at = Date.parse(basis);
  if (!Number.isFinite(at)) return "missing_basis";
  return at >= Date.parse(startIso) && at <= Date.parse(endIso) ? "in_window" : "outside_window";
}

export interface ScorecardWindowCounts {
  in_window: number;
  outside_window: number;
  missing_basis: number;
}

export function countScorecardWindowPartitions(
  rows: Array<{ interviewed_at?: unknown; submitted_at?: unknown }>,
  startIso: string,
  endIso: string
): ScorecardWindowCounts {
  const counts: ScorecardWindowCounts = { in_window: 0, outside_window: 0, missing_basis: 0 };
  for (const row of rows) counts[partitionScorecardByWindow(row, startIso, endIso)] += 1;
  return counts;
}

/**
 * The disclosure both recipes carry: a card with neither timestamp cannot be SELECTED by either
 * server-side filter, so the count above is only what arrived through some other path (a job-scoped
 * read bridged by application_ids, say). It is not a census of basis-less scorecards in the tenant.
 */
export const SCORECARD_MISSING_BASIS_DISCLOSURE =
  "Scorecards with neither an interview date nor a submission date cannot be selected by /v3/scorecards' " +
  "interviewed_at or submitted_at range filters, so they are not read by this window; missing_basis counts " +
  "only such rows that reached the analysis through another filter, not every basis-less scorecard in the tenant.";

export const SCORECARD_WINDOW_BASIS_LABEL =
  "interviewed_at, or submitted_at when the scorecard records no interview date";

/**
 * Read the window twice — once bounded on interviewed_at, once on submitted_at — and union the rows.
 * `requestedJobIds` selects the same two read paths the recipes used before: the bridged
 * application_ids read for a narrowed scope, the direct read otherwise.
 */
export async function readScorecardsForWindow<T extends ScorecardWindowRow>(
  runtime: RecruiterToolRuntime,
  toolName: string,
  requestedJobIds: Set<number> | null,
  baseParams: Record<string, string | number | boolean | undefined>,
  window: { windowStart: string; windowEnd: string },
  deadline?: ToolDeadline
): Promise<ReadAllRowsResult<T>> {
  const reads: Array<Extract<ReadAllRowsResult<T>, { kind: "rows" }>> = [];
  for (const field of ["interviewed_at", "submitted_at"] as const) {
    const params = {
      ...baseParams,
      [`${field}[gte]`]: window.windowStart,
      [`${field}[lte]`]: window.windowEnd,
    };
    const read = requestedJobIds
      ? await readScorecardRowsForJobScope<T>(runtime, toolName, [...requestedJobIds], params, deadline)
      : await readAllScopedRows<T>(runtime, toolName, "list_scorecards", params, deadline);
    if (read.kind === "denial") return read;
    reads.push(read);
  }
  return unionScorecardReads(reads);
}

/**
 * Union two read results by scorecard id. A row with no usable id cannot be identified across the two
 * reads, so it is deduped on its serialized payload instead — which collapses the genuine duplicate
 * (the same row returned by both filters) without discarding two distinct id-less rows.
 */
function unionScorecardReads<T extends ScorecardWindowRow>(
  reads: Array<Extract<ReadAllRowsResult<T>, { kind: "rows" }>>
): ReadAllRowsResult<T> {
  const rows: T[] = [];
  const seen = new Set<string>();
  for (const read of reads) {
    for (const row of read.rows) {
      const key = typeof row.id === "number" && Number.isSafeInteger(row.id) ? `id:${row.id}` : `row:${JSON.stringify(row)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  const first = reads[0]!;
  const status = combineReadStatuses(reads.map((read) => read.status));
  return {
    kind: "rows",
    rows,
    // Both reads really did hit the API, so the read-cost counters sum. `rows` is the deduped union,
    // which is what every downstream count is taken from.
    rawRowsRead: reads.reduce((sum, read) => sum + read.rawRowsRead, 0),
    rowsReturnedRead: reads.reduce((sum, read) => sum + (read.rowsReturnedRead ?? read.rows.length), 0),
    permissionExcluded: reads.reduce((sum, read) => sum + read.permissionExcluded, 0),
    unresolvedRows: reads.reduce((sum, read) => sum + read.unresolvedRows, 0),
    pagesRead: reads.reduce((sum, read) => sum + read.pagesRead, 0),
    status,
    complete: status === "complete",
    paginationTruncated: reads.some((read) => read.paginationTruncated),
    nextCursor: null,
    perPage: first.perPage,
    rateLimitRetries: reads.reduce((sum, read) => sum + read.rateLimitRetries, 0),
    rateLimitSleepMs: reads.reduce((sum, read) => sum + read.rateLimitSleepMs, 0),
    cacheHits: reads.reduce((sum, read) => sum + read.cacheHits, 0),
    warnings: reads.flatMap((read) => read.warnings),
    actorId: first.actorId,
    effectiveActorId: first.effectiveActorId,
    scoped: first.scoped,
    permissionScope: first.permissionScope,
  };
}
