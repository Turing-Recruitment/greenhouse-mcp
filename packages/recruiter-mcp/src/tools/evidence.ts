import { z } from "zod";
import type { RecruiterToolDefinition } from "../types.js";
import { newCorrelationId } from "../audit.js";
import { deny, emitRequiredToolAudit, runScopedTool, type RecruiterToolRuntime } from "../runtime.js";
import {
  getHarvestEndpointForEvidenceTool,
  getModelExposedParametersForEndpoint,
  getModelParamNamesForEvidenceTool,
  type HarvestScopeClass,
  type ParameterSpec,
} from "../harvest-v3-registry.js";
import { projectEvidenceResult } from "./evidence-projection.js";
import { resolvePrivateCustomFieldKeys } from "../private-custom-fields.js";
import { getScopeBridgeSpec, runEvidenceListRead } from "./evidence-read.js";
import {
  EVIDENCE_TOOL_SCOPED_TOOL_NAMES,
  SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL,
  getEvidenceEndpointAdapter,
} from "./scoped-endpoint-adapters.js";

export const EVIDENCE_TOOL_MAP = EVIDENCE_TOOL_SCOPED_TOOL_NAMES;

const EVIDENCE_TOOL_PARAM_NAMES = new Map<string, ReadonlySet<string>>(
  [...EVIDENCE_TOOL_MAP.keys()].map((toolName) => [toolName, getModelParamNamesForEvidenceTool(toolName)])
);

export function evidenceToolParamsSchema(toolName: string): Record<string, z.ZodTypeAny> {
  if (toolName.startsWith("get_")) {
    return {
      id: z.number().int().positive().describe("Greenhouse record id."),
    };
  }
  const endpoint = getHarvestEndpointForEvidenceTool(toolName);
  if (!endpoint) return {};
  const schema: Record<string, z.ZodTypeAny> = {};
  for (const parameter of getModelExposedParametersForEndpoint(endpoint.path)) {
    schema[parameter.name] = zodSchemaForParameter(parameter);
  }
  // Deterministic continuation over the complete scoped set (the read is stable-sorted): pair with
  // per_page and follow result_truncated.next_offset to page past the payload-size cap.
  schema.offset = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Rows to skip; follow result_truncated.next_offset to page onward.");
  // Bridgeable endpoints have NO job_ids filter, so a confirmed requisition scope is otherwise inert on
  // them: application-backed (application_stages/scorecards/rejection_details/notes/attachments) bridge
  // to application_ids (L1); the R2 siblings bridge to their own id filter (scorecard_question_answers ->
  // scorecard_ids, interviewers -> interview_ids, candidates -> ids, candidate_educations/employments ->
  // candidate_ids). Advertise the two scope carriers; runEvidenceListRead auto-bridges them.
  // getScopeBridgeSpec is the SINGLE source of truth for which tools bridge (shared with the dispatch).
  // Other tools are bounded by their endpoint's own native job_ids filter, so they don't take these.
  if (getScopeBridgeSpec(getEvidenceEndpointAdapter(toolName))) {
    schema.scope_handle = z
      .string()
      .optional()
      .describe("Signed handle from resolve_job_scope; wins over job_ids.");
    schema.job_ids = z
      .string()
      .optional()
      .describe("Comma-separated Greenhouse job ids to scope this read to.");
  }
  return schema;
}

export const EVIDENCE_TOOL_DEFINITIONS: RecruiterToolDefinition[] = [
  { name: "search_my_jobs", kind: "evidence", description: "Search jobs visible to the authenticated recruiter." },
  { name: "get_my_job", kind: "evidence", description: "Get one job if it is visible to the authenticated recruiter." },
  { name: "search_my_job_owners", kind: "evidence", description: "Search job-owner assignments for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_openings", kind: "evidence", description: "Search openings/headcount rows for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_job_interview_stages", kind: "evidence", description: "Search interview-stage configuration for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_job_interviews", kind: "evidence", description: "Search job interview-kit rows for permitted jobs. Domain class: job_scoped; rows must carry a permitted job_id before projection." },
  { name: "search_my_interviews", kind: "evidence", description: "Search interview events bounded by permitted job or application association. Domain class: job_scoped; private candidate details are projected out." },
  { name: "search_my_application_stages", kind: "evidence", description: "Search application stage-transition rows for funnel conversion across permitted jobs. Domain class: application_backed; each row is scoped through its application's job_id before projection and carries no candidate identity. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids, since the endpoint has no job_ids filter); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_applications", kind: "evidence", description: "Search applications across the authenticated recruiter's permitted jobs. Domain class: job_scoped." },
  { name: "get_my_application", kind: "evidence", description: "Get one application if it belongs to a permitted job." },
  { name: "search_my_candidates", kind: "evidence", description: "Search candidates through applications on the recruiter's permitted jobs. Domain class: candidate_backed. Rows carry the candidate's name, email addresses and phone numbers (what a Job Admin sees in Greenhouse); home addresses and raw profiles are withheld. Filter by email to find a specific person. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's candidate ids, via its applications); without one it spans candidates across all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "get_my_candidate", kind: "evidence", description: "Get one candidate through applications on the recruiter's permitted jobs. Domain class: candidate_backed. Includes name, email addresses and phone numbers; home addresses and raw profiles are withheld." },
  { name: "search_my_scorecards", kind: "evidence", description: "Search scorecards scoped to applications on the recruiter's permitted jobs. Domain class: application_backed. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_rejection_details", kind: "evidence", description: "Search projected rejection-detail rows bounded through scoped applications. Domain class: application_backed. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_rejection_reasons", kind: "evidence", description: "Search projected rejection-reason reference data. Domain class: global_reference; not job-filtered and never treated as fake scoped data." },
  { name: "search_my_users", kind: "evidence", description: "Search projected Greenhouse user reference metadata (id, name, employee id, role flags). Domain class: global_reference; not job-filtered. Colleague email addresses are returned to site admins and operators only — they administer the staff directory; a job-scoped line recruiter gets names and ids." },
  { name: "get_my_user", kind: "evidence", description: "Get one projected Greenhouse user reference row by id. Domain class: global_reference. Colleague email addresses are returned to site admins and operators only; a job-scoped line recruiter gets names and ids." },
  { name: "search_my_sources", kind: "evidence", description: "Search projected application-source reference data (id, name, and source type). Domain class: global_reference; not job-filtered. Resolves source ids returned by analyses into human-readable source names." },
  { name: "search_my_referrers", kind: "evidence", description: "Search projected referrer reference data (id, name, and the linking user_id). Domain class: global_reference; not job-filtered. The user_id is the Greenhouse user who made the referral — an id, not contact data — so employee-referral yield can be attributed. Resolves referrer ids returned by analyses into referrer names." },
  { name: "search_my_notes", kind: "evidence", description: "Search public notes scoped to applications/candidates on permitted jobs. Domain class: application_backed. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids; application-keyed notes only — candidate-level notes with no application_id are not part of a req-scoped read); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_tracking_links", kind: "evidence", description: "Search projected tracking-link metadata for permitted jobs. Domain class: job_scoped; token/url fields are not exposed." },
  { name: "search_my_offers", kind: "evidence", description: "Search projected offer metadata for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id. Compensation custom fields pass through unless the field definition is flagged private in Greenhouse; if the definitions cannot be read at all, every custom field is withheld for that read rather than guessed at." },
  { name: "search_my_departments", kind: "evidence", description: "Search projected department reference data (id, name, parent_id, external_id). Domain class: global_reference; not job-filtered. Resolves department ids returned by analyses into department names and supports department rollups." },
  { name: "search_my_offices", kind: "evidence", description: "Search projected office reference data (id, name, location, parent_id). Domain class: global_reference; not job-filtered. Resolves office ids into office names/locations and supports office rollups." },
  { name: "search_my_close_reasons", kind: "evidence", description: "Search projected opening close-reason reference data (id, name). Domain class: global_reference; not job-filtered. Resolves the close_reason_id on a closed opening into a human-readable reason." },
  { name: "search_my_custom_field_options", kind: "evidence", description: "Search projected custom-field option reference data (id, name, custom_field_id). Domain class: global_reference; not job-filtered. Decodes the custom_field_option_id values that appear on openings, rejection details, users, and candidate history into their labels." },
  { name: "search_my_attachments", kind: "evidence", description: "List metadata for resumes, cover letters, and other files on candidates/applications within the recruiter's permitted jobs. Use this for file inventory and to choose an exact resume attachment_id; signed URLs and file contents are withheld. Then call read_my_resume only when actual resume text is needed. Domain class: application_backed; each row is bounded by its application's job, or — for a candidate-level attachment with no application_id — by the candidate's permitted applications. Filter with type=resume to list resume versions. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's application_ids; application-keyed attachments only — candidate-level files with no application_id are not part of a req-scoped read); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_job_hiring_managers", kind: "evidence", description: "Search hiring-manager assignments for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id and resolve the user_id of each hiring manager for accountability and stakeholder escalation." },
  { name: "search_my_job_notes", kind: "evidence", description: "Search job-level notes for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id. Free-text bodies are gated on per-note visibility — publicly_visible and admin_only_visible bodies reach a Job Admin; privately_visible bodies are withheld." },
  { name: "search_my_job_posts", kind: "evidence", description: "Search job-post/board listings for permitted jobs. Domain class: job_scoped; rows carry a permitted job_id. Surfaces which boards a req is live on plus the public posting title, content, and URL." },
  { name: "search_my_interviewers", kind: "evidence", description: "Search interview-panel membership and invite response status for permitted jobs. Domain class: interview_backed; each row is scoped through its interview to a permitted application or job. Surfaces who is on the panel and each member's interview-invite response (response_status is the calendar RSVP — accepted/declined/tentative/needs_action — NOT scorecard submission; for who has/hasn't submitted a scorecard use search_my_scorecards, status draft/complete). Interviewer email is excluded. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's interview ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_scorecard_question_answers", kind: "evidence", description: "Search structured scorecard question answers (question-level rubric responses) for permitted jobs. Domain class: scorecard_backed; each row is scoped through its scorecard to a permitted application. Surfaces what the rubric actually scored. (v3 scorecard privacy gates only the private_notes free text, which lives on the scorecard row, not these structured answers — there is no row-level private-scorecard flag.) Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's scorecard ids, via its applications); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_candidate_educations", kind: "evidence", description: "Search candidate education history for candidates on the recruiter's permitted jobs. Domain class: candidate_backed; scoped through the candidate's permitted applications. Degree/discipline/school are custom_field_option_id refs — decode them with search_my_custom_field_options. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's candidate ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_candidate_employments", kind: "evidence", description: "Search candidate employment history (company, title, dates) for candidates on the recruiter's permitted jobs. Domain class: candidate_backed; scoped through the candidate's permitted applications. Pass scope_handle or job_ids to narrow to a requisition (auto-bridged to that scope's candidate ids); without one it spans all your permitted jobs. Returns the complete scoped set in one call." },
  { name: "search_my_custom_fields", kind: "evidence", description: "Search custom-field definitions (id, name, name_key, field_type, value_type). Domain class: global_reference; not job-filtered. The schema dictionary naming what each org custom field is — pair with search_my_custom_field_options to decode option_id values on applications, openings, offers, users, and candidate history." },
  { name: "search_my_pay_inputs", kind: "evidence", description: "Search pay-input definitions (id, title, blurb, linked_custom_field_id). Domain class: global_reference; not job-filtered. The labels/structure of the org's pay inputs — definitions only, no compensation amounts." },
  { name: "search_my_approval_flows", kind: "evidence", description: "Search approval flows on permitted jobs (id, job_id, offer_id, approval_status, approval_type, sequential, requested_by_id, version). Domain class: job_scoped; rows are bounded to your permitted jobs. The spine of approval-bottleneck analysis; join approver groups via approval_flow_id." },
  { name: "search_my_approvers", kind: "evidence", description: "Search approver assignments bounded to permitted jobs through approver_group_id -> approval_flow_id -> job_id. Domain class: join_backed." },
  { name: "search_my_approver_groups", kind: "evidence", description: "Search approver groups bounded to permitted jobs through approval_flow_id -> job_id. Domain class: join_backed." },
  { name: "search_my_scorecard_questions", kind: "evidence", description: "Search rubric questions bounded to permitted jobs through interview_kit_id -> job_id. Domain class: join_backed." },
  { name: "search_my_scorecard_question_options", kind: "evidence", description: "Search rubric options bounded to permitted jobs through scorecard_question_id -> interview_kit_id -> job_id. Domain class: join_backed." },
  { name: "search_my_scorecard_question_answer_options", kind: "evidence", description: "Search answer-option links bounded through question answer -> scorecard -> application -> job. Domain class: join_backed." },
  { name: "search_my_interview_kits", kind: "evidence", description: "Search interview kits on permitted jobs (id, job_id, job_interview_id, exercises, anonymize flags). Domain class: job_scoped; rows are bounded to your permitted jobs. Connects rubric structure (scorecard_questions.interview_kit_id) to jobs and interview slots." },
  { name: "search_my_default_interviewers", kind: "evidence", description: "Search default interviewer assignments bounded through interview_kit_id -> job_id. Domain class: join_backed." },
  { name: "search_my_job_post_locations", kind: "evidence", description: "Search job-post locations bounded through job_post_id -> job_id. Domain class: join_backed." },
  { name: "search_my_pay_input_ranges", kind: "evidence", description: "Search advertised pay ranges bounded through job_post_id -> job_id. Domain class: join_backed." },
  { name: "search_my_interviewer_tags", kind: "evidence", description: "Search interviewer tag definitions (id, name). Domain class: global_reference; not job-filtered. Resolves interviewer tag ids to names for panel/staffing analysis." },
  { name: "search_my_candidate_tags", kind: "evidence", description: "Search candidate tag definitions (id, name). Domain class: global_reference; not job-filtered. Resolves candidate tag ids to names (candidates' tag_names come from these)." },
  { name: "search_my_prospect_pools", kind: "evidence", description: "Search prospect pools intersecting permitted jobs; mixed job_ids are redacted to the permitted intersection. Domain class: job_scoped." },
  { name: "search_my_prospect_pool_stages", kind: "evidence", description: "Search prospect-pool stages bounded through prospect_pool_id -> job_ids. Domain class: join_backed." },
  { name: "search_my_prospect_details", kind: "evidence", description: "Search prospect details for permitted applications (id, application_id, pool_id, pool_stage_id, prospect_owner_id, department_id, office_id). Domain class: application_backed; rows are bounded to applications on your permitted jobs. Where prospects sit in pools and who owns them." },
  { name: "search_my_job_boards", kind: "evidence", description: "Search job boards (id, company_name, status, internal, introduction/conclusion copy). Domain class: global_reference; not job-filtered. Which boards the org publishes to, for post-attribution analysis." },
  { name: "search_my_custom_field_departments", kind: "evidence", description: "Search custom-field department scoping rows (custom_field_id -> department_id). Domain class: global_reference; not job-filtered. Which custom fields apply to which departments." },
  { name: "search_my_custom_field_offices", kind: "evidence", description: "Search custom-field office scoping rows (custom_field_id -> office_id). Domain class: global_reference; not job-filtered. Which custom fields apply to which offices." },
  { name: "search_my_job_post_searchable_locations", kind: "evidence", description: "Search the structured locations a job post is searchable in — city, county, region, country, postal code and lat/long. Domain class: join_backed; each row is bounded through job_post_id -> the post's job. The finer location source behind this tenant's coarse country-level office tags: use it when a location question needs the city a req is actually posted to." },
  { name: "search_my_applied_candidate_tags", kind: "evidence", description: "Search which candidates carry which tags (candidate_id -> candidate_tag_id). Domain class: candidate_backed; scoped through the candidate's permitted applications, and private candidates pass the same gate as every other candidate read. The pool behind a tag name — pair with search_my_candidate_tags to turn tag ids into names." },
  { name: "search_my_user_roles", kind: "evidence", description: "Search the permission-role dictionary (id, name, role_type). Domain class: global_reference; not job-filtered and it names no user. Decodes the role_id on requisition-permission rows. role_type carries only two values — job_admin and site_admin — and is what actually determines access; the role NAME is a cosmetic label an org can rename freely, so read the type, not the name." },
  { name: "search_my_email_templates", kind: "evidence", description: "Search the org's email templates (id, name, subject, body, email_type, from_type, user_id). Domain class: global_reference; not job-filtered. The company copy a rejection, an availability request or a scorecard reminder sends, and the template id such a send needs. Colleague addresses in `recipients` are returned to site admins and operators only." },
];

export type EvidenceDomainClass = HarvestScopeClass | "unsafe_unavailable";

export interface EvidenceDomainClassification {
  domain_class: EvidenceDomainClass;
  bounding_rule: string;
}

export const EVIDENCE_DOMAIN_CLASSIFICATIONS: Record<string, EvidenceDomainClassification> = Object.fromEntries(
  [...SCOPED_ENDPOINT_ADAPTERS_BY_EVIDENCE_TOOL].map(([toolName, adapter]) => [
    toolName,
    {
      domain_class: adapter.scopeClass,
      bounding_rule: adapter.boundingRule,
    },
  ])
);

export interface RunEvidenceToolOptions {
  // Internal diagnostic callers (probe.ts, leakage-sample.ts) want a BOUNDED single-page sample for
  // reachability/shape/leak checks, not the complete scoped set. Without this they would full-scan
  // every permitted job per check (read-all returns the whole set), which for an all-scope actor is a
  // very heavy readiness probe. Model-facing reads never set this — they get the complete set.
  sample?: boolean;
}

export async function runEvidenceTool(
  runtime: RecruiterToolRuntime,
  exposedToolName: string,
  params: Record<string, unknown>,
  options: RunEvidenceToolOptions = {}
) {
  const adapter = getEvidenceEndpointAdapter(exposedToolName);
  if (!adapter) {
    const startedAt = runtime.now();
    const correlationId = newCorrelationId(runtime.now);
    const denied = deny(exposedToolName, "TOOL_NOT_AVAILABLE", "This tool is not available on the recruiter-scoped MCP surface.");
    const auditDenied = await emitRequiredToolAudit(runtime, exposedToolName, "evidence", startedAt, correlationId, denied, null, null, runtime.trustedActAsUser ?? null);
    return auditDenied ?? denied;
  }
  const allowedParamNames = EVIDENCE_TOOL_PARAM_NAMES.get(exposedToolName);
  // get_* single-record reads, and internal SAMPLE reads (probe/leakage diagnostics that want a
  // bounded page), use the single-read path. Model-facing list search_my_* reads return the COMPLETE
  // scoped set through the read-all engine (L2) so the model never hits the 100-row wall, with an
  // honest completeness/truncation envelope, and auto-bridge a confirmed scope (L1).
  const singleRead = exposedToolName.startsWith("get_") || options.sample === true;
  const result = singleRead
    ? await runScopedTool(runtime, exposedToolName, adapter.scopedToolName, params, "evidence", allowedParamNames)
    : await runEvidenceListRead(runtime, adapter, params, allowedParamNames);
  // Custom-field VALUES restricted by Greenhouse's "View Private" permission are withheld. If the
  // definitions cannot be read we cannot tell which are private, so `undefined` withholds all of
  // them for this projection rather than guessing — the fail-closed direction on a permission gate.
  const privateCustomFieldKeys = await resolvePrivateCustomFieldKeys(runtime).catch(() => undefined);
  return projectEvidenceResult(result, adapter, privateCustomFieldKeys);
}

/**
 * R2c: the per-parameter text is a POINTER, not a paragraph.
 *
 * Measured on the 66-tool catalog this replaces: 619 parameters cost 109,622 B of JSON Schema, and
 * three sentences accounted for 83,170 B of it — the date-range blurb on 117 params (41,780 B), the
 * pagination convention on 157 (32,490 B), and the scope-carrier convention on 71 (14,980 B). Every
 * recruiter paid for all three on every call, at initialize, before asking anything.
 *
 * Each of those conventions is now stated ONCE, in SERVER_INSTRUCTIONS, ahead of the ~2,048-character
 * boundary several clients truncate at (test/catalog-budget.test.ts asserts both the placement and
 * the total). What stays here is the field-specific part: which id, which enum, which date.
 *
 * The bar for a description below is ~60 characters. That is not terseness for its own sake — a
 * bare parameter is worse than a short one (the model guesses), and a paragraph is worse than a
 * sentence (it displaces the answer).
 */
const PARAM_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // Pagination and result shaping. The full convention is in SERVER_INSTRUCTIONS.
  cursor: "Resume an incomplete read with read.next_cursor.",
  per_page: "Result cap only; upstream reading is unaffected. Pair with offset.",
  ids: "Comma-separated ids of the rows this tool returns.",
  // Filters whose NAME does not say what they mean.
  active: "Only rows currently active.",
  current: "Only the row that is current now (not history).",
  open: "Only open rows.",
  live: "Only posts currently live on a board.",
  internal: "Only internal-only rows.",
  featured: "Only featured posts.",
  default: "Only the default row.",
  verified: "Only verified rows.",
  is_draft: "Only draft rows.",
  deactivated: "Only deactivated users (departed or disabled).",
  confidential: "Only confidential requisitions.",
  current_only: "Only the current version of each offer, not superseded ones.",
  show_service_accounts: "Include service accounts, which are excluded by default.",
  private: "Only private candidates.",
  email: "Exact email address to match.",
  tag: "Exact candidate tag name to match.",
  token: "Exact tracking-link slug to match.",
  primary_email: "Exact work email address to match.",
  value: "Exact value to match.",
  status: "Filter to one status.",
  external_event_id: "Exact calendar event id from the external system.",
  requisition_id: "Exact requisition id as your org writes it (e.g. REQ-1234).",
  external_office_id: "Exact office id in your HRIS, not Greenhouse's.",
  external_department_id: "Exact department id in your HRIS, not Greenhouse's.",
  bulk_action_uuid: "Exact bulk-request uuid.",
  related_post_type: "Kind of record the link points at.",
  source_type: "Kind of blocked source.",
  email_type: "Greenhouse email type; see the enum for the legal values.",
  from_type: "Which sender address the template uses.",
  stage_name: "Exact interview-stage name as configured on the job.",
  scheduling_type: "How the interview is scheduled.",
};

/** A last-resort description derived from the parameter's own name and type, so none is ever bare. */
function derivedParameterDescription(parameter: ParameterSpec): string {
  const subject = parameter.name.replace(/_ids?$/, "").replace(/_/g, " ");
  if (parameter.type === "array" || parameter.name.endsWith("_ids")) {
    return `Comma-separated ${subject} ids to filter by.`;
  }
  if (parameter.name.endsWith("_id")) {
    return `Exact ${subject} id to filter by.`;
  }
  if (parameter.type === "boolean") {
    return `Filter on ${parameter.name.replace(/_/g, " ")}.`;
  }
  return `Filter by ${parameter.name.replace(/_/g, " ")}.`;
}

function describeParameter(parameter: ParameterSpec): string {
  return PARAM_DESCRIPTIONS[parameter.name] ?? derivedParameterDescription(parameter);
}

function zodSchemaForParameter(parameter: ParameterSpec): z.ZodTypeAny {
  if (parameter.name === "per_page") {
    return z.number().int().positive().optional().describe(describeParameter(parameter));
  }
  // v3's date filters (created_at/updated_at/resolved_at/sent_on/...) accept bracket ranges upstream.
  //
  // The tool boundary takes ONE STRING: an exact ISO value, or the "START..END" shorthand, either
  // side of which may be empty ("2026-04-01.." is a floor, "..2026-06-30" a ceiling). The read layer
  // translates the shorthand into v3's bracket params (translateRangeParams, evidence-read.ts), which
  // is unchanged and still accepts a {gte,lte,gt,lt} OBJECT from the internal callers that build
  // params directly — recipes and the planner, which do not pass through this schema.
  //
  // What the MODEL loses by the collapse is the exclusive bounds (gt/lt), and the reason is measured
  // rather than hypothetical: advertising the object form to the model cost 357 bytes per date
  // parameter across 117 of them — 41,780 B, a quarter of the whole catalog — paid by every recruiter
  // at every initialize, to express "after but not including this instant" on a recruiting window
  // where the inclusive open-ended form already says what anyone means.
  if (/(_at|_on)$/.test(parameter.name)) {
    return z
      .string()
      .optional()
      .describe("ISO date-time, or a range 2026-04-01..2026-06-30 (either side may be empty).");
  }
  if (parameter.type === "boolean") {
    return z.boolean().optional().describe(describeParameter(parameter));
  }
  if (parameter.enumValues && parameter.enumValues.length > 0) {
    // The legal values live in the schema's own enum, where a client renders them. Repeating them in
    // the description would bill for the list twice.
    return z.enum(parameter.enumValues as [string, ...string[]]).optional().describe(describeParameter(parameter));
  }
  if (parameter.type === "integer" || parameter.type === "number") {
    return z.number().int().positive().optional().describe(describeParameter(parameter));
  }
  return z.string().optional().describe(describeParameter(parameter));
}
