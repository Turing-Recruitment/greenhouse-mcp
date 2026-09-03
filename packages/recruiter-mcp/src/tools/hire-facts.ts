import {
  HIRE_FACTS_ID_BRIDGE_READ_PARAM_NAMES,
  HIRE_FACTS_OFFER_READ_PARAM_NAMES,
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

export function uniquePositiveIds(rows: Array<Record<string, unknown>>, field: string): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    const value = row[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ids.add(value);
  }
  return [...ids];
}
