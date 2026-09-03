import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScorecardAccountability } from "../src/tools/scorecard-accountability.js";
import { runInterviewFeedbackDrag } from "../src/tools/interview-feedback-drag.js";
import { runPipelineQuality } from "../src/tools/pipeline-quality.js";
import { registerRecruiterTools } from "../src/tools/register.js";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";
import { analysisRuntime, fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";

/**
 * Lane D / P3 — "windows mean one thing".
 *
 * D1/D1b: the scorecard recipes must select on the basis they actually analyse (interviewed_at, or
 * submitted_at when no interview date exists), server-side, instead of a created_at floor that has
 * nothing to do with the window they report.
 * D2/D2b: every row read lands in exactly one partition, so the completeness accounting identity
 * total_records_in_scope === records_analyzed + records_excluded holds.
 * D3: pipeline_quality's snapshot is labelled as current state and its weekly inflow is genuinely
 * windowed rather than silently anchored to now over a fixed 12-week horizon.
 * D4: the registered model-facing text states the clock.
 */

const NOW_ISO = "2026-06-23T12:00:00.000Z";
const WINDOW_START_ISO = "2026-05-24T12:00:00.000Z";

/** Read a date-range bound off a read's params, tolerating either v3 encoding. */
function windowBounds(params: Record<string, unknown> | undefined, field: string): { gte?: string; lte?: string } {
  const out: { gte?: string; lte?: string } = {};
  if (!params) return out;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;
    if (key === `${field}[gte]`) out.gte = value;
    else if (key === `${field}[lte]`) out.lte = value;
    else if (key === field) {
      const match = /^(gte|lte)\|(.+)$/.exec(value);
      if (match) out[match[1] as "gte" | "lte"] = match[2];
    }
  }
  return out;
}

function scorecardApplications() {
  return [{ id: 10, jobs: [{ id: 100 }] }, { id: 20, jobs: [{ id: 200 }] }];
}

describe("lane D P3 — scorecard recipes window on the basis they analyse", () => {
  it("D1 selects on interviewed_at/submitted_at, not a created_at floor, and keeps a card interviewed in-window but created long before it", async () => {
    // Created 20 days BEFORE window_start, interviewed inside the window. The old created_at floor
    // would have asked Greenhouse to drop exactly this row.
    const owed = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const seenScorecardParams: Array<Record<string, unknown> | undefined> = [];
    const reader = () =>
      fakeScopedReader((toolName, params) => {
        if (toolName === "list_scorecards") {
          seenScorecardParams.push(params);
          const interviewed = windowBounds(params, "interviewed_at");
          const submitted = windowBounds(params, "submitted_at");
          if (interviewed.gte !== undefined) return scopedSuccess(toolName, [owed]);
          if (submitted.gte !== undefined) return scopedSuccess(toolName, []);
          return scopedSuccess(toolName, []);
        }
        if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
        throw new Error(`unexpected tool ${toolName}`);
      });

    for (const run of [runScorecardAccountability, runInterviewFeedbackDrag]) {
      seenScorecardParams.length = 0;
      const { runtime } = analysisRuntime(reader());
      const result = await run(runtime, {});
      assert.equal(result.ok, true, `${run.name} must succeed`);
      const data = result.ok ? (result.data as any) : null;

      const interviewedRead = seenScorecardParams.find((p) => windowBounds(p, "interviewed_at").gte !== undefined);
      const submittedRead = seenScorecardParams.find((p) => windowBounds(p, "submitted_at").gte !== undefined);
      assert.ok(interviewedRead, `${run.name}: expected a list_scorecards read filtered on interviewed_at`);
      assert.ok(submittedRead, `${run.name}: expected a list_scorecards read filtered on submitted_at`);
      assert.deepStrictEqual(windowBounds(interviewedRead, "interviewed_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO });
      assert.deepStrictEqual(windowBounds(submittedRead, "submitted_at"), { gte: WINDOW_START_ISO, lte: NOW_ISO });
      for (const params of seenScorecardParams) {
        assert.equal(params?.created_at, undefined, `${run.name}: the created_at floor must be gone`);
      }

      assert.deepStrictEqual(
        data.rankings.map((row: any) => row.person_key),
        ["greenhouse_user:5"],
        `${run.name}: a card interviewed inside the window must be owed even when it was created before it`
      );
    }
  });

  it("D1b reads a submitted-only card through the second filter and dedupes rows seen by both", async () => {
    const interviewedCard = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const submittedOnlyCard = {
      id: 7,
      application_id: 20,
      interviewer_id: 6,
      submitter_id: 6,
      status: "submitted",
      submitted_at: "2026-06-12T00:00:00.000Z",
      interviewed_at: null,
      created_at: "2026-05-11T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) return scopedSuccess(toolName, [interviewedCard]);
        if (windowBounds(params, "submitted_at").gte !== undefined) {
          // The interviewed card is ALSO returned here (it has no submitted_at, but a real tenant
          // routinely returns overlapping sets): the union must not double-count it.
          return scopedSuccess(toolName, [interviewedCard, submittedOnlyCard]);
        }
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.metrics.total_scorecards, 2, "the union must be deduped by scorecard id");
    assert.equal(data.completeness.total_records_in_scope, 2);
    assert.equal(data.summary.data_quality.in_window, 2);
  });

  it("D2 partitions a no-basis scorecard out of the accountability ranking and keeps the accounting identity", async () => {
    const inWindow = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const noBasis = {
      id: 2,
      application_id: 20,
      interviewer_id: 9,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: null,
      created_at: "2026-05-18T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) return scopedSuccess(toolName, [inWindow, noBasis]);
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runScorecardAccountability(runtime, {});
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;

    assert.equal(data.summary.data_quality.missing_basis, 1);
    assert.equal(data.summary.data_quality.in_window, 1);
    assert.equal(data.summary.data_quality.outside_window, 0);
    assert.ok(
      !data.rankings.some((row: any) => row.person_key === "greenhouse_user:9"),
      "a scorecard with neither an interview nor a submission date carries no owed-age and must not be ranked"
    );
    assert.deepStrictEqual(
      data.completeness.exclusion_reasons.find((entry: any) => entry.reason === "missing_window_basis"),
      { reason: "missing_window_basis", count: 1 }
    );
    assert.equal(
      data.completeness.total_records_in_scope,
      data.completeness.records_analyzed + data.completeness.records_excluded,
      "total_records_in_scope must equal records_analyzed + records_excluded"
    );
    assert.notEqual(data.completeness.status, "incomplete");
    assert.match(
      JSON.stringify(data.summary.data_quality),
      /neither an interview date nor a submission date/,
      "the summary must disclose that basis-less scorecards are not selectable by the API"
    );
  });

  it("D2b counts a no-basis card and a submitted-before-interview card separately in feedback drag, and repairs its accounting identity", async () => {
    const inWindow = {
      id: 1,
      application_id: 10,
      interviewer_id: 5,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: "2026-06-10T00:00:00.000Z",
      created_at: "2026-05-04T00:00:00.000Z",
    };
    const noBasis = {
      id: 2,
      application_id: 20,
      interviewer_id: 9,
      submitter_id: null,
      status: "pending",
      submitted_at: null,
      interviewed_at: null,
      created_at: "2026-05-18T00:00:00.000Z",
    };
    const submittedBeforeInterview = {
      id: 3,
      application_id: 20,
      interviewer_id: 8,
      submitter_id: 8,
      status: "submitted",
      submitted_at: "2026-06-10T00:00:00.000Z",
      interviewed_at: "2026-06-15T00:00:00.000Z",
      created_at: "2026-05-25T00:00:00.000Z",
    };
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_scorecards") {
        if (windowBounds(params, "interviewed_at").gte !== undefined) {
          return scopedSuccess(toolName, [inWindow, noBasis, submittedBeforeInterview]);
        }
        return scopedSuccess(toolName, []);
      }
      if (toolName === "list_applications") return scopedSuccess(toolName, scorecardApplications());
      throw new Error(`unexpected tool ${toolName}`);
    });
    const { runtime } = analysisRuntime(reader);
    const result = await runInterviewFeedbackDrag(runtime, { due_days: 2 });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;

    assert.equal(data.summary.data_quality.missing_basis, 1);
    assert.equal(data.summary.data_quality.submitted_before_interview, 1);
    assert.deepStrictEqual(
      data.completeness.exclusion_reasons.find((entry: any) => entry.reason === "missing_window_basis"),
      { reason: "missing_window_basis", count: 1 }
    );
    assert.deepStrictEqual(
      data.completeness.exclusion_reasons.find((entry: any) => entry.reason === "submitted_before_interview"),
      { reason: "submitted_before_interview", count: 1 }
    );
    assert.equal(
      data.completeness.total_records_in_scope,
      data.completeness.records_analyzed + data.completeness.records_excluded,
      "feedback drag's long-standing accounting mismatch must be gone"
    );
    assert.notEqual(data.completeness.status, "incomplete");
    assert.equal(data.completeness.message, undefined);
  });
});

describe("lane D P3 — pipeline_quality labels the snapshot and windows the inflow", () => {
  function pipelineReader(rows: Array<Record<string, unknown>>) {
    return fakeScopedReader((toolName) => {
      if (toolName === "list_applications") return scopedSuccess(toolName, rows);
      throw new Error(`unexpected tool ${toolName}`);
    });
  }

  function application(id: number, createdAt: string, status = "active") {
    return {
      id,
      candidate_id: id + 500,
      job_id: 100,
      stage_id: 7,
      stage_name: "Onsite",
      status,
      created_at: createdAt,
      current_stage_at: createdAt,
      last_activity_at: createdAt,
    };
  }

  it("D3 labels snapshot_as_of as now and drops freshness_window_start", async () => {
    const { runtime } = analysisRuntime(pipelineReader([application(1, "2026-06-19T00:00:00.000Z")]));
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-10T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal("freshness_window_start" in data.summary, false, "freshness_window_start had one reader — its own emission");
    assert.equal(
      data.summary.snapshot_as_of,
      NOW_ISO,
      "/v3/applications returns CURRENT rows, so a historical window_end cannot rewind status; the label must say now"
    );
  });

  it("D3 emits inflow_window derived from the buckets the view actually produced", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-01-13T00:00:00.000Z"),
        application(2, "2026-01-20T00:00:00.000Z"),
        application(3, "2026-01-27T00:00:00.000Z"),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-01-05T00:00:00.000Z",
      window_end: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    const inflow = data.summary.inflow_window;
    assert.ok(inflow, "summary.inflow_window must be emitted");
    assert.equal(inflow.start, "2026-01-05T00:00:00.000Z");
    assert.equal(inflow.end, "2026-02-02T00:00:00.000Z");
    assert.equal(inflow.weeks_covered, 4);
    assert.equal(inflow.first_bucket_week, "2026-01-12");
    assert.equal(inflow.last_bucket_week, "2026-01-26");
    assert.equal(inflow.excluded_before_window, 0);
    assert.equal(inflow.excluded_after_window, 0);
    assert.equal(inflow.missing_timestamp, 0);
    // excluded_before_window belongs to the inflow window, NOT to completeness: those rows are still
    // analysed in the snapshot cohort.
    assert.equal(
      data.completeness.exclusion_reasons.some((entry: any) => entry.reason === "excluded_before_window"),
      false
    );
  });

  it("D3 covers a historical explicit window instead of returning an empty weekly series", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-01-13T00:00:00.000Z"),
        application(2, "2026-01-20T00:00:00.000Z"),
        application(3, "2026-01-27T00:00:00.000Z"),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-01-05T00:00:00.000Z",
      window_end: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.deepStrictEqual(
      data.temporal.weekly_inflow.map((bucket: any) => bucket.week),
      ["2026-01-12", "2026-01-19", "2026-01-26"],
      "a six-months-ago window must bucket over that span, not over the 12 weeks before now"
    );
    assert.ok(data.temporal.week_over_week, "both comparison weeks sit fully inside this window");
    assert.equal(data.temporal.week_over_week.current_week, "2026-01-26");
    assert.equal(data.temporal.week_over_week.prior_week, "2026-01-19");
  });

  it("D3 nulls week-over-week with a reason rather than substituting 0 for a week outside the window", async () => {
    const { runtime } = analysisRuntime(
      pipelineReader([
        application(1, "2026-06-02T00:00:00.000Z"),
        application(2, "2026-06-09T00:00:00.000Z"),
        application(3, "2026-06-16T00:00:00.000Z"),
        application(4, "2026-06-19T00:00:00.000Z"),
      ])
    );
    const result = await runPipelineQuality(runtime, {
      window_start: "2026-06-18T12:00:00.000Z",
      window_end: NOW_ISO,
    });
    assert.equal(result.ok, true);
    const data = result.ok ? (result.data as any) : null;
    assert.equal(data.temporal.week_over_week, null, "a comparison week that is not fully inside the window is not a 0");
    assert.equal(data.temporal.velocity, null);
    assert.match(String(data.temporal.comparison_unavailable_reason ?? ""), /window/i);
    assert.equal(data.summary.inflow_window.excluded_before_window, 4);
  });
});

describe("lane D P3 — the registered text states the clock", () => {
  function registeredDescriptions() {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const descriptions = new Map<string, string>();
    const schemas = new Map<string, Record<string, any>>();
    registerRecruiterTools(
      {
        tool(name: string, description: string, paramsSchema: Record<string, any>) {
          descriptions.set(name, description);
          schemas.set(name, paramsSchema);
        },
      } as any,
      runtime
    );
    return { descriptions, schemas };
  }

  it("D4 states the pipeline clock on the registered tool and the capability recipe", () => {
    const { descriptions, schemas } = registeredDescriptions();
    const registered = descriptions.get("analyze_pipeline_quality") ?? "";
    assert.match(registered, /snapshot of current state/i);
    assert.match(registered, /weekly inflow is bucketed by application created date over the window/i);

    const recipe = getRecruitingCapabilities().recipes.find((entry) => entry.id === "pipeline_quality");
    assert.ok(recipe);
    assert.match(recipe.description, /snapshot of current state/i);
    assert.match(recipe.description, /weekly inflow is bucketed by application created date over the window/i);

    const windowStart = schemas.get("analyze_pipeline_quality")?.window_start?.description ?? "";
    assert.doesNotMatch(windowStart, /freshness lookback/i, "window_start no longer means a 'freshness lookback'");
  });

  it("D4 states the scorecard clock on both registered scorecard tools and their capability recipes", () => {
    const { descriptions } = registeredDescriptions();
    for (const name of ["analyze_scorecard_accountability", "analyze_interview_feedback_drag"]) {
      const registered = descriptions.get(name) ?? "";
      assert.match(registered, /windowed on the interview date/i, `${name} must state its clock`);
      assert.match(registered, /submission date when no interview date is recorded/i, `${name} must state its fallback`);
    }
    for (const id of ["scorecard_accountability", "interview_feedback_drag"]) {
      const recipe = getRecruitingCapabilities().recipes.find((entry) => entry.id === id);
      assert.ok(recipe, `${id} recipe missing`);
      assert.match(recipe.description, /windowed on the interview date/i);
      assert.match(recipe.description, /submission date when no interview date is recorded/i);
    }
  });
});
