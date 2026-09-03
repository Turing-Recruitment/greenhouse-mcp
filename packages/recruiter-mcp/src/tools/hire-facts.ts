import {
  APPLICATION_ANALYSIS_READ_PARAM_NAMES,
  HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES,
  HIRE_FACTS_OFFER_READ_PARAM_NAMES,
  HIRE_FACTS_OPENING_READ_PARAM_NAMES,
  sanitizeReadParams,
} from "../limits.js";
import {
  combineReadStatuses,
  denialTruncationStatus,
  type ReadAllRowsResult,
  type ReadAllStatus,
} from "../read-all.js";
import type { RecruiterToolRuntime, ToolDeadline } from "../runtime.js";
import type { RecruiterToolResult } from "../types.js";
import { HIRE_ACCEPTED_OFFER_STATUS } from "../facts.js";
import { chunks } from "./application-job-lookup.js";
import {
  bracketParamsForWindows,
  readAllWithDateFallback,
  type DateWindowSpec,
} from "./read-with-date-fallback.js";

/**
 * The hire read. One definition of a hire, read once, for every People Ops recipe above it.
 *
 * Three facts about the live API decide the shape:
 *
 *  1. The LIVE `/v3/offers` endpoint 422s every date filter the vendored contract advertises, so
 *     the `resolved_at` range goes through `readAllWithDateFallback` — native filter first, local
 *     window and a disclosure second. Never a denial.
 *  2. The default org-wide scope carries NO `job_ids` (analysis-context.ts), so a permission-wide
 *     hire read is ONE permission-bounded read. Chunking is for a FROZEN explicit job set only;
 *     chunking a permission-wide read would turn one call into one per permitted req for nothing.
 *  3. On the privacy-only branches every offer batch also walks `application_id` and
 *     `candidate_id` upstream, so each optional bridge here is a real cost and is opt-in.
 */

/** 50 is Greenhouse's practical id-filter batch size, and the one the sibling bridges already use. */
export const HIRE_JOB_ID_CHUNK_SIZE = 50;
export const HIRE_ID_BRIDGE_CHUNK_SIZE = 50;

export interface HireScope {
  /**
   * The FROZEN explicit job set to constrain the read to. Undefined means permission-wide: the
   * scoped reader's own permission floor is the scope, and no `job_ids` are invented for it.
   */
  jobIds?: number[];
  /** What to call this scope in the answer. Mandatory — a count with no stated scope is a rumour. */
  label: string;
}

export interface HireWindow {
  start: string;
  end: string;
  /** What to call this window in the answer ("Q2 2026", "last quarter", "2026-04-01 to 2026-06-30"). */
  label: string;
}

export interface HireSetOptions {
  /**
   * Also read every VERSION of the accepted set's offers (`current_only=false`, keyed by their
   * application_ids), which is the only honest source for offer-rows-per-hire (the re-extension
   * denominator). Off by default: it is a second full read.
   */
  includeChain?: boolean;
  /**
   * Also bridge the hires' `candidate_ids` to candidate rows for names. The private-candidate gate
   * runs upstream, so what comes back is what this actor may see and the withheld count is reported
   * beside it rather than silently absorbed.
   */
  includeCandidates?: boolean;
}

export interface HireReadStatus {
  status: ReadAllStatus;
  complete: boolean;
  pagesRead: number;
  rawRowsRead: number;
  /**
   * Rows Greenhouse's private-candidate permission withheld from THIS read. Never summed with
   * another read's figure: each read has its own population and its own privacy regime.
   */
  privacyWithheld: number;
  windowAppliedLocally: boolean;
  dateParamsRejected: string[];
  warnings: string[];
}

export interface HireCandidateRow {
  id: number;
  first_name?: string;
  last_name?: string;
  preferred_name?: string;
}

export type HireSetResult =
  | {
      kind: "rows";
      hires: Array<Record<string, unknown>>;
      chain?: Array<Record<string, unknown>>;
      candidates?: HireCandidateRow[];
      read: HireReadStatus;
      chainRead?: HireReadStatus;
      candidatesRead?: HireReadStatus;
      scope: HireScope;
      window: HireWindow;
    }
  | { kind: "denial"; result: RecruiterToolResult };

type RowsResult = Extract<ReadAllRowsResult<Record<string, unknown>>, { kind: "rows" }>;

export function hireWindowSpec(window: HireWindow): DateWindowSpec {
  return {
    field: "resolved_at",
    // A hire whose resolved_at Greenhouse never wrote is still a hire; on the local-window leg it
    // is placed by sent_on rather than dropped. buildHireFacts labels the substitution on the row.
    fallbackFields: ["sent_on"],
    gte: window.start,
    lte: window.end,
  };
}

export async function readHireSet(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  window: HireWindow,
  deadline?: ToolDeadline,
  options: HireSetOptions = {}
): Promise<HireSetResult> {
  const spec = hireWindowSpec(window);
  const jobChunks: Array<number[] | null> = scope.jobIds && scope.jobIds.length > 0
    ? chunks([...new Set(scope.jobIds)], HIRE_JOB_ID_CHUNK_SIZE)
    : [null];

  const hires: Array<Record<string, unknown>> = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let pagesRead = 0;
  let rawRowsRead = 0;
  let privacyWithheld = 0;
  let windowAppliedLocally = false;
  const dateParamsRejected = new Set<string>();

  for (const jobChunk of jobChunks) {
    const params = sanitizeReadParams(
      {
        status: HIRE_ACCEPTED_OFFER_STATUS,
        current_only: true,
        ...(jobChunk ? { job_ids: jobChunk.join(",") } : {}),
        ...bracketParamsForWindows([spec]),
      },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_OFFER_READ_PARAM_NAMES }
    );
    const outcome = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_offers",
      params,
      [spec],
      deadline
    );
    if (outcome.read.kind === "denial") {
      const truncation = denialTruncationStatus(outcome.read.result);
      // A budget/deadline denial on a LATER chunk is truncation, not failure: the hires already
      // read are real and the answer says the set is short. A permission/upstream denial is a real
      // error at any point, and so is any denial on the first chunk (nothing was read).
      if (truncation === null || hires.length === 0) return { kind: "denial", result: outcome.read.result };
      statuses.push(truncation);
      warnings.push("the hire read stopped before every explicit req chunk was read");
      break;
    }
    foldRead(outcome.read, hires, statuses, warnings);
    pagesRead += outcome.read.pagesRead;
    rawRowsRead += outcome.read.rawRowsRead;
    privacyWithheld += outcome.read.privacyWithheld;
    if (outcome.windowAppliedLocally) windowAppliedLocally = true;
    for (const rejected of outcome.dateParamsRejected) dateParamsRejected.add(rejected);
  }

  const read: HireReadStatus = {
    status: combineReadStatuses(statuses),
    complete: combineReadStatuses(statuses) === "complete",
    pagesRead,
    rawRowsRead,
    privacyWithheld,
    windowAppliedLocally,
    dateParamsRejected: [...dateParamsRejected].sort(),
    warnings,
  };

  const applicationIds = uniquePositiveIds(hires, "application_id");
  const candidateIds = uniquePositiveIds(hires, "candidate_id");

  let chain: Array<Record<string, unknown>> | undefined;
  let chainRead: HireReadStatus | undefined;
  if (options.includeChain) {
    const chainResult = await readOfferChain(runtime, exposedToolName, applicationIds, deadline);
    if (chainResult.kind === "denial") return chainResult;
    chain = chainResult.rows;
    chainRead = chainResult.read;
  }

  let candidates: HireCandidateRow[] | undefined;
  let candidatesRead: HireReadStatus | undefined;
  if (options.includeCandidates) {
    const bridged = await readHireCandidates(runtime, exposedToolName, candidateIds, deadline);
    if (bridged.kind === "denial") return bridged;
    candidates = bridged.candidates;
    candidatesRead = bridged.read;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (let index = 0; index < hires.length; index += 1) {
      const candidateId = hires[index]!.candidate_id;
      const candidate = typeof candidateId === "number" ? byId.get(candidateId) : undefined;
      // A hire whose candidate the privacy gate withheld carries NO candidate key at all, rather
      // than a placeholder that would read as a name Greenhouse does not have.
      if (candidate) hires[index] = { ...hires[index]!, candidate };
    }
  }

  return {
    kind: "rows",
    hires,
    ...(chain ? { chain } : {}),
    ...(candidates ? { candidates } : {}),
    read,
    ...(chainRead ? { chainRead } : {}),
    ...(candidatesRead ? { candidatesRead } : {}),
    scope,
    window,
  };
}

/**
 * Every VERSION of the accepted set's offers. `current_only=false` and NO status filter: a
 * superseded version carries status `Deprecated`, so filtering on `Accepted` would return exactly
 * the rows the caller already has and report a re-extension count of 1.0 for every hire.
 */
async function readOfferChain(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  applicationIds: number[],
  deadline: ToolDeadline | undefined
): Promise<{ kind: "rows"; rows: Array<Record<string, unknown>>; read: HireReadStatus } | { kind: "denial"; result: RecruiterToolResult }> {
  return readIdChunks(
    runtime,
    exposedToolName,
    "list_offers",
    applicationIds,
    (batch) => sanitizeReadParams(
      { application_ids: batch.join(","), current_only: false },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_OFFER_READ_PARAM_NAMES }
    ),
    deadline
  );
}

async function readHireCandidates(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  candidateIds: number[],
  deadline: ToolDeadline | undefined
): Promise<{ kind: "rows"; candidates: HireCandidateRow[]; read: HireReadStatus } | { kind: "denial"; result: RecruiterToolResult }> {
  const bridged = await readIdChunks(
    runtime,
    exposedToolName,
    "list_candidates",
    candidateIds,
    (batch) => sanitizeReadParams(
      { ids: batch.join(",") },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }
    ),
    deadline
  );
  if (bridged.kind === "denial") return bridged;
  const candidates: HireCandidateRow[] = [];
  for (const row of bridged.rows) {
    const id = row.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    candidates.push({
      id,
      ...(typeof row.first_name === "string" && row.first_name.length > 0 ? { first_name: row.first_name } : {}),
      ...(typeof row.last_name === "string" && row.last_name.length > 0 ? { last_name: row.last_name } : {}),
      ...(typeof row.preferred_name === "string" && row.preferred_name.length > 0 ? { preferred_name: row.preferred_name } : {}),
    });
  }
  return { kind: "rows", candidates, read: bridged.read };
}

/**
 * Read an endpoint in id-bounded chunks and fold the results into ONE honest read status. Shared by
 * the chain read, the candidate bridge and the applications bridge so all three account for
 * truncation and privacy the same way.
 */
export async function readIdChunks(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scopedToolName: string,
  ids: number[],
  paramsFor: (batch: number[]) => Record<string, unknown>,
  deadline: ToolDeadline | undefined
): Promise<{ kind: "rows"; rows: Array<Record<string, unknown>>; read: HireReadStatus } | { kind: "denial"; result: RecruiterToolResult }> {
  const rows: Array<Record<string, unknown>> = [];
  const statuses: ReadAllStatus[] = [];
  const warnings: string[] = [];
  let pagesRead = 0;
  let rawRowsRead = 0;
  let privacyWithheld = 0;

  if (ids.length === 0) {
    return {
      kind: "rows",
      rows,
      read: {
        status: "complete",
        complete: true,
        pagesRead: 0,
        rawRowsRead: 0,
        privacyWithheld: 0,
        windowAppliedLocally: false,
        dateParamsRejected: [],
        warnings,
      },
    };
  }

  for (const batch of chunks(ids, HIRE_ID_BRIDGE_CHUNK_SIZE)) {
    const outcome = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      scopedToolName,
      paramsFor(batch),
      [],
      deadline
    );
    if (outcome.read.kind === "denial") {
      const truncation = denialTruncationStatus(outcome.read.result);
      if (truncation === null || rows.length === 0) return { kind: "denial", result: outcome.read.result };
      statuses.push(truncation);
      warnings.push(`the ${scopedToolName} bridge stopped before every id batch was read`);
      break;
    }
    foldRead(outcome.read, rows, statuses, warnings);
    pagesRead += outcome.read.pagesRead;
    rawRowsRead += outcome.read.rawRowsRead;
    privacyWithheld += outcome.read.privacyWithheld;
  }

  return {
    kind: "rows",
    rows,
    read: {
      status: combineReadStatuses(statuses),
      complete: combineReadStatuses(statuses) === "complete",
      pagesRead,
      rawRowsRead,
      privacyWithheld,
      windowAppliedLocally: false,
      dateParamsRejected: [],
      warnings,
    },
  };
}

function foldRead(
  read: RowsResult,
  rows: Array<Record<string, unknown>>,
  statuses: ReadAllStatus[],
  warnings: string[]
): void {
  rows.push(...read.rows);
  statuses.push(read.status);
  warnings.push(...read.warnings);
}

// ---------------------------------------------------------------------------
// The reconciliation line.
//
// On this tenant the accepted-offer count, the status=hired application count and
// the openings-closed-by-hire count are three DIFFERENT numbers, and each is
// right about a different thing. Printing one of them alone is how a hire report
// acquires a number nobody can reproduce. So the line prints them together, each
// with the clock it is dated on, the scope and window it ran over, and its OWN
// private-candidate withholding — never a total, because a total across three
// populations is a number no read produced.
// ---------------------------------------------------------------------------

export interface ReconciliationCount {
  /** null when the read this count needs was not made. */
  value: number | null;
  /** True when no read was made for this count. Distinct from a genuine zero. */
  not_read: boolean;
  /** The field this count is dated on. Three counts, three clocks. */
  clock: string;
  window_label: string;
  scope_label: string;
  /** Rows Greenhouse's private-candidate permission withheld from THIS read alone. */
  privacy_withheld: number;
  notes: string[];
}

export interface OpeningsClosedByHireCount extends ReconciliationCount {
  /** Closed openings carrying no close_reason_id at all — hire or cancel is unknowable. */
  closed_with_no_reason: number;
  /** Closed openings whose close_reason_id the close-reason dictionary did not resolve. */
  closed_reason_unresolved: number;
}

export interface HireReconciliationLine {
  accepted_current_offers: ReconciliationCount;
  offer_rows_per_hire: ReconciliationCount;
  accepted_offer_applications_marked_hired: ReconciliationCount;
  applications_status_hired_scope_all_time?: ReconciliationCount;
  openings_closed_by_hire: OpeningsClosedByHireCount;
  read: { status: ReadAllStatus; complete: boolean; warnings: string[] };
  scope: HireScope;
  window: HireWindow;
}

export interface ReconciliationOptions {
  /** Read every offer version for the accepted set, so offer-rows-per-hire has a real source. */
  includeChain?: boolean;
  /** Read the closed openings and the close-reason dictionary. A third population, a third read. */
  includeOpenings?: boolean;
  /**
   * Also count status=hired applications across the whole scope with NO window. Off by default and
   * labeled all-time when on: it answers a different question from the other counts and putting it
   * beside them unlabeled is how an all-time number gets read as a quarter's.
   */
  includeAllTimeHiredApplications?: boolean;
}

export type ReconciliationResult =
  | { kind: "line"; line: HireReconciliationLine }
  | { kind: "denial"; result: RecruiterToolResult };

const HIRE_CLOSE_REASON_PREFIX = "Hire -";

export async function reconciliationLine(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  window: HireWindow,
  deadline?: ToolDeadline,
  options: ReconciliationOptions = {}
): Promise<ReconciliationResult> {
  const hireSet = await readHireSet(runtime, exposedToolName, scope, window, deadline, {
    includeChain: options.includeChain === true,
  });
  if (hireSet.kind === "denial") return hireSet;

  const statuses: ReadAllStatus[] = [hireSet.read.status];
  const warnings = [...hireSet.read.warnings];
  const base = { window_label: window.label, scope_label: scope.label };

  const accepted_current_offers: ReconciliationCount = {
    ...base,
    value: hireSet.hires.length,
    not_read: false,
    clock: "offers.resolved_at",
    privacy_withheld: hireSet.read.privacyWithheld,
    notes: hireSet.read.windowAppliedLocally
      ? ["the upstream rejected the resolved_at filter, so the window was applied locally to the complete scoped set"]
      : [],
  };

  const offer_rows_per_hire: ReconciliationCount = hireSet.chain
    ? {
        ...base,
        value: hireSet.hires.length > 0
          ? Number((hireSet.chain.length / hireSet.hires.length).toFixed(2))
          : null,
        not_read: false,
        clock: "offers.resolved_at (accepted set), counted across every version",
        privacy_withheld: hireSet.chainRead?.privacyWithheld ?? 0,
        notes: [],
      }
    : {
        ...base,
        value: null,
        not_read: true,
        clock: "offers.resolved_at (accepted set), counted across every version",
        privacy_withheld: 0,
        notes: ["superseded versions were not read"],
      };
  if (hireSet.chainRead) statuses.push(hireSet.chainRead.status);

  // Count B: the SAME hires, asked of the application row. Greenhouse only sets status=hired once
  // somebody calls the hire endpoint, so this legitimately trails the accepted-offer count.
  const applicationIds = uniquePositiveIds(hireSet.hires, "application_id");
  const bridged = await readIdChunks(
    runtime,
    exposedToolName,
    "list_applications",
    applicationIds,
    (batch) => sanitizeReadParams(
      { ids: batch.join(",") },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }
    ),
    deadline
  );
  if (bridged.kind === "denial") return bridged;
  statuses.push(bridged.read.status);
  warnings.push(...bridged.read.warnings);

  const accepted_offer_applications_marked_hired: ReconciliationCount = {
    ...base,
    value: bridged.rows.filter((row) => normalizedText(row.status) === "hired").length,
    not_read: false,
    // Deliberately NOT dated: /v3/applications carries no hire timestamp, so this count is a
    // snapshot of the accepted set's applications as they stand right now.
    clock: "applications.status (point-in-time, not dated)",
    privacy_withheld: bridged.read.privacyWithheld,
    notes: ["Greenhouse sets status=hired only once the hire endpoint has fired, so this count trails the accepted-offer count rather than contradicting it"],
  };

  let applications_status_hired_scope_all_time: ReconciliationCount | undefined;
  if (options.includeAllTimeHiredApplications) {
    const allTime = await readAllWithDateFallback<Record<string, unknown>>(
      runtime,
      exposedToolName,
      "list_applications",
      sanitizeReadParams(
        { status: "hired", ...(scope.jobIds && scope.jobIds.length > 0 ? { job_ids: scope.jobIds.join(",") } : {}) },
        runtime.limits,
        { allowedParamNames: APPLICATION_ANALYSIS_READ_PARAM_NAMES }
      ),
      [],
      deadline
    );
    if (allTime.read.kind === "denial") return { kind: "denial", result: allTime.read.result };
    statuses.push(allTime.read.status);
    warnings.push(...allTime.read.warnings);
    applications_status_hired_scope_all_time = {
      value: allTime.read.rows.length,
      not_read: false,
      clock: "applications.status (point-in-time, not dated)",
      window_label: "all time",
      scope_label: scope.label,
      privacy_withheld: allTime.read.privacyWithheld,
      notes: ["this count is NOT windowed — it is every hired application in scope, whenever it was hired"],
    };
  }

  const openings = options.includeOpenings
    ? await readOpeningsClosedByHire(runtime, exposedToolName, scope, window, deadline)
    : null;
  if (openings && openings.kind === "denial") return openings;
  if (openings) {
    statuses.push(openings.status);
    warnings.push(...openings.warnings);
  }
  const openings_closed_by_hire: OpeningsClosedByHireCount = openings
    ? {
        ...base,
        value: openings.hireClosed,
        not_read: false,
        clock: "openings.closed_at",
        privacy_withheld: openings.privacyWithheld,
        closed_with_no_reason: openings.closedWithNoReason,
        closed_reason_unresolved: openings.closedReasonUnresolved,
        notes: [],
      }
    : {
        ...base,
        value: null,
        not_read: true,
        clock: "openings.closed_at",
        privacy_withheld: 0,
        closed_with_no_reason: 0,
        closed_reason_unresolved: 0,
        notes: ["openings closed by a hire were not read"],
      };

  const status = combineReadStatuses(statuses);
  return {
    kind: "line",
    line: {
      accepted_current_offers,
      offer_rows_per_hire,
      accepted_offer_applications_marked_hired,
      ...(applications_status_hired_scope_all_time ? { applications_status_hired_scope_all_time } : {}),
      openings_closed_by_hire,
      read: { status, complete: status === "complete", warnings },
      scope,
      window,
    },
  };
}

/**
 * Count C: seats closed by a hire.
 *
 * `list_openings` rows carry `application_id` and go through the candidate privacy gate, so this
 * count has its own withheld figure like the other two. The close reason is the only
 * hire-vs-cancel discriminator, and on this tenant it is often absent — 882 of 4,102 closed
 * openings carried none — so "no reason" and "reason we could not resolve" are reported as their
 * own numbers rather than folded into the hire count or into each other.
 */
async function readOpeningsClosedByHire(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  scope: HireScope,
  window: HireWindow,
  deadline: ToolDeadline | undefined
): Promise<
  | {
      kind: "counts";
      hireClosed: number;
      closedWithNoReason: number;
      closedReasonUnresolved: number;
      privacyWithheld: number;
      status: ReadAllStatus;
      warnings: string[];
    }
  | { kind: "denial"; result: RecruiterToolResult }
> {
  // Whether /v3/openings honours closed_at[gte] live is UNPROVEN, so this read goes through the
  // same 422 fallback the offer read does rather than assuming either answer.
  const spec: DateWindowSpec = { field: "closed_at", gte: window.start, lte: window.end };
  const outcome = await readAllWithDateFallback<Record<string, unknown>>(
    runtime,
    exposedToolName,
    "list_openings",
    sanitizeReadParams(
      {
        open: false,
        ...(scope.jobIds && scope.jobIds.length > 0 ? { job_ids: scope.jobIds.join(",") } : {}),
        ...bracketParamsForWindows([spec]),
      },
      runtime.limits,
      { allowedParamNames: HIRE_FACTS_OPENING_READ_PARAM_NAMES }
    ),
    [spec],
    deadline
  );
  if (outcome.read.kind === "denial") return { kind: "denial", result: outcome.read.result };

  const reasons = await readAllWithDateFallback<Record<string, unknown>>(
    runtime,
    exposedToolName,
    "list_close_reasons",
    sanitizeReadParams({}, runtime.limits, { allowedParamNames: HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES }),
    [],
    deadline
  );
  if (reasons.read.kind === "denial") return { kind: "denial", result: reasons.read.result };
  const reasonNames = new Map<number, string>();
  for (const row of reasons.read.rows) {
    if (typeof row.id === "number" && typeof row.name === "string") reasonNames.set(row.id, row.name);
  }

  let hireClosed = 0;
  let closedWithNoReason = 0;
  let closedReasonUnresolved = 0;
  for (const row of outcome.read.rows) {
    const reasonId = row.close_reason_id;
    if (typeof reasonId !== "number") {
      closedWithNoReason += 1;
      continue;
    }
    const name = reasonNames.get(reasonId);
    if (name === undefined) {
      closedReasonUnresolved += 1;
      continue;
    }
    // A seat closed by a hire has BOTH: a hire close reason and the application it was filled by.
    if (name.startsWith(HIRE_CLOSE_REASON_PREFIX) && typeof row.application_id === "number") hireClosed += 1;
  }

  return {
    kind: "counts",
    hireClosed,
    closedWithNoReason,
    closedReasonUnresolved,
    privacyWithheld: outcome.read.privacyWithheld,
    status: combineReadStatuses([outcome.read.status, reasons.read.status]),
    warnings: [...outcome.read.warnings, ...reasons.read.warnings],
  };
}

/**
 * The line, in a recruiter's words: one sentence per count, each carrying its own clock, its own
 * privacy regime and the window and scope it ran over. Counts that were not read say so instead of
 * reading as zero.
 */
export function hireReconciliationSummary(line: HireReconciliationLine): string {
  const sentences: string[] = [];
  sentences.push(
    line.accepted_current_offers.not_read
      ? "Accepted current offers were not read."
      : `${line.accepted_current_offers.value} accepted current offers${withheldClause(line.accepted_current_offers)}, dated on ${line.accepted_current_offers.clock} over ${line.window.label} across ${line.scope.label}.`
  );
  sentences.push(
    line.accepted_offer_applications_marked_hired.not_read
      ? "The accepted set's applications were not read."
      : `${line.accepted_offer_applications_marked_hired.value} of those applications are marked hired in Greenhouse${withheldClause(line.accepted_offer_applications_marked_hired)} — ${line.accepted_offer_applications_marked_hired.clock}, so it trails the offer count until the hire endpoint fires.`
  );
  sentences.push(
    line.openings_closed_by_hire.not_read
      ? "Openings closed by a hire were not read."
      : `${line.openings_closed_by_hire.value} openings closed on a hire reason${withheldClause(line.openings_closed_by_hire)}, dated on ${line.openings_closed_by_hire.clock}; ${line.openings_closed_by_hire.closed_with_no_reason} closed with no reason at all and ${line.openings_closed_by_hire.closed_reason_unresolved} on a reason this read could not resolve, so neither can be called a hire or a cancel.`
  );
  sentences.push(
    line.offer_rows_per_hire.not_read
      ? "Superseded versions were not read, so offer rows per hire is not reported."
      : `${line.offer_rows_per_hire.value} offer rows per hire across every version${withheldClause(line.offer_rows_per_hire)}.`
  );
  if (line.applications_status_hired_scope_all_time) {
    sentences.push(
      `Separately, and over all time rather than ${line.window.label}: ${line.applications_status_hired_scope_all_time.value} applications in scope carry status=hired${withheldClause(line.applications_status_hired_scope_all_time)}.`
    );
  }
  sentences.push("These count different populations on different clocks; they are not expected to match, and no total across them is meaningful.");
  return sentences.join(" ");
}

function withheldClause(count: ReconciliationCount): string {
  return count.privacy_withheld > 0
    ? ` (${count.privacy_withheld} withheld as private candidates you cannot see)`
    : "";
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function uniquePositiveIds(rows: Array<Record<string, unknown>>, field: string): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    const value = row[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ids.add(value);
  }
  return [...ids];
}
