# Recruiter-side capability map for the Greenhouse MCP

Date: 2026-09-02. Scope: what a recruiter or coordinator can do through the Greenhouse MCP today (the recruiter read plane in `packages/recruiter-mcp`, the write plane in `packages/action-mcp`), what the Harvest v3 API would let them do, and the gap between the two. Every claim carries a file:line or a doc page. Section A is the input for a keep/rename/redefine verdict on the six analysis recipes; section C is the reference the write-plane build will be scoped from, so it is exhaustive.

Path shorthand used in citations:

| Key | Path |
|---|---|
| `S` | `/Users/sam.vangelos/Projects/recruiting-tools/greenhouse-mcp/packages/recruiter-mcp/src` |
| `A` | `/Users/sam.vangelos/Projects/recruiting-tools/greenhouse-mcp/packages/action-mcp/src` |
| `D` | `/Users/sam.vangelos/Projects/recruiting-tools/ta-ops-analytics-greenhouse-permission-gates/docs/harvest-v3-api/raw/reference` (vendored Harvest v3, 175 pages, retrieved 2026-06-27) |
| `G` | `/Users/sam.vangelos/Projects/recruiting-tools/ta-ops-analytics-greenhouse-permission-gates` (the pre-squash origin checkout; the only place the read-surface history survives) |
| `M` | `/Users/sam.vangelos/.claude/projects/-Users-sam-vangelos-Projects-recruiting-tools-ta-ops-analytics/memory` |

## 0. The shape of the gap in five sentences

The read plane binds 50 of the 72 Harvest v3 GET endpoints to 54 evidence tools and exposes 44 of the 66 registered tools to the model; the 22 hidden readers were built with an explicit "no PII on any contract" finding and then withdrawn inside a "harden" commit with an empty body (`G` commit `66cb2a6`). The six analysis recipes are sound on their own clocks but three of them apply the analysis window differently from what their summaries imply, and the keyword router that fronts them answers a narrow band of vocabulary and fails closed on the rest (`S/tools/question-answer.ts:326-374`). The write plane ships 11 action kinds over 13 of the 90 Harvest v3 write endpoints, every one of them stripped of the fields that would email a candidate, so today a recruiter can reject, move, note, re-attribute, re-assign, and draft an offer, but cannot schedule, cannot send a rejection email, cannot tag, cannot hire, and cannot touch a job post. The two most-asked operating questions on a recruiter's desk ("who do I follow up with today", "which of my reqs went quiet") route to `missing_domain`. The five gaps ranked in section E close in roughly two engineering weeks, and the cheapest of them (flipping the allowlist for the 22 hidden readers) unblocks three of the others.

## A. Recipe register

All six recipes share a frame: scope resolves through `resolveAnalysisContext` (`S/resolution/analysis-context.ts:78-145`), which accepts only the 18 keys at `:31-50` and fails closed on anything else; the analysis window comes from `resolveAnalysisWindow` (`S/limits.ts:501-520`) with `window_end` defaulting to now and `window_start` to `window_end` minus the recipe's default lookback; an explicit window runs free of the 365-day `maxLookbackDays` cap (`S/limits.ts:197`, `:481-483`) while a fuzzy default is asserted against it; rankings cap at `max_rankings`, default and ceiling 25 (`S/limits.ts:198`); evidence-id lists cap at 200 (`S/limits.ts:203`); every read goes through `readAllScopedRows` at `per_page` 500 (`S/limits.ts:193-194`), and a truncated read marks the analysis incomplete. Every recipe runs the L4 provenance detector (`S/resolution/provenance.ts`) and attaches a `completeness` block with named exclusion reasons.

| Recipe / tool | Clock (start → end) | Default window and how it is applied | Threshold (param, default) | Unit | Grouping | Disclosures | Completeness rule |
|---|---|---|---|---|---|---|---|
| **stage_latency** `analyze_stage_latency` (`S/tools/stage-latency.ts`) | `application_stages` row with `current=true`: `entered_at` → `window_end` (`:452-460`, `:595-601`); `days_in_stage` is preferred when Greenhouse supplies it (`:598-599`) | `min(90, maxLookbackDays)` days (`:103`). **The window start is not a filter**: a still-current stage entered before it is kept as the longest dweller (`:455-459`); only `entered_at > window_end` is dropped | `min_age_days`, 7 (`:110`) — an application is "aging" at dwell ≥ 7 days (`:195`, `:489`) | days (fractional, rounded to 0.1) | `job_interview_stage_id` (`:478`), so the same stage name on ten reqs is ten ranking rows; a job breakdown is emitted alongside (`:512-542`). Cohort is active-only unless `include_terminal` (`:111-112`, `:426`) | severity = mean + max(0, p90 − min_age) + 10·aging (`:544-550`); exclusion reasons `backend_scope_filtered`, `terminal_or_inactive_application`, `missing_current_application_stage_row`, `missing_stage_entry_timestamp`, `other_scope_or_shape_exclusions` (`:163-172`); `dataFreshnessOk` false when any stage row lacks timing (`:284`); `stage_conversion_rate` is declared as a required metric (`question-answer.ts:106`) but its compute returns not-implemented (`S/metrics.ts:132-148`) | Applications pagination and every application_stages batch complete (`:216`, `:282-283`); a later-batch timeout keeps the completed prefix and reports partial (`:365-374`) |
| **pipeline_quality** `analyze_pipeline_quality` (`S/tools/pipeline-quality.ts`) | Staleness: `last_activity_at` → `window_end` (`:296`, `:309`); current-stage age: `current_stage_at` → `window_end` (`:297`), which is ~0 % populated on v3 (`:253-255`) | `min(90, maxLookbackDays)` days (`:96`). **The window start is decorative**: `buildObservations(nonProspectRows, window.windowEnd, staleDays)` takes no start (`:126`, `:292`), no row is excluded by date, and the summary reports it as `freshness_window_start` (`:157`). The temporal view buckets `created_at` weekly on its own (`:225-228`) | `stale_days`, 14 (`:101`) — active and (`last_activity_at` missing or ≥ 14 days old) is stale (`:309`) | count and ratio; days for stage age | status (`status_mix`, `:388-396`), `job_interview_stage_id` or stage name (`:334-337`), `job_id` (`:336`); prospects excluded outright (`:124-125`) | severity = 12·stale + 2·active + max(0, mean stage age − stale_days) (`:409-414`); `data_quality` counts for missing job, stage, `last_activity_at`, stage timing (`:198-207`); `dataFreshnessOk` false when any active row lacks stage timing (`:256`), which on this tenant means always; `field_limitations` names the recipes that answer source and rejection-reason questions (`:173-180`) | Application pagination complete (`:251-252`) |
| **scorecard_accountability** `analyze_scorecard_accountability` (`S/tools/scorecard-accountability.ts`) | Owed age: `interviewed_at ?? submitted_at` → `window_end` (`:279`, `:353-359`) | 30 days (`:77`), applied twice and not identically: server-side as `created_at ≥ window_start` (`:86`), then in memory on `interviewed_at ?? submitted_at` (`:107`, `:303-308`); a row with neither timestamp passes the in-memory filter as in-window (`:305`). A scorecard created before the window but interviewed inside it is dropped server-side and never seen | None settable. Unsubmitted = no `submitted_at` and status not in {submitted, complete, completed} (`:310-316`). The fact-metric layer computes `scorecard_overdue_rate` at a fixed 2 days (`:146`; `S/metrics.ts:652-676`) | count, ratio, days | person: `interviewer_id ?? interviewer.id ?? submitter_id ?? submitted_by.id` (`:259-260`; `S/tools/application-shapes.ts:46-62`) keyed `greenhouse_user:<id>`; `affected_jobs` from application→job (`:273-274`) | severity = 100·rate + 8·unsubmitted + min(60, 2·mean age) (`:296-301`); exclusions `outside_analysis_window`, `unresolved_application_job_association`, `outside_requested_scope` (`:203-213`); `job_ids` is never forwarded to `/v3/scorecards` (422) and is bridged through application ids instead (`:71-76`, `:96-101`) | Scorecard pagination complete (`:214-215`); rows that cannot be joined to a permitted job are excluded and counted (`:115-116`) |
| **interview_feedback_drag** `analyze_interview_feedback_drag` (`S/tools/interview-feedback-drag.ts`) | `interviewed_at ?? submitted_at` → `submitted_at` when submitted, else → `window_end` (`:282-287`). When `interviewed_at` is null and `submitted_at` present the basis is `submitted_at`, so delay is 0 and the card can never be late (`:282-286`) | 30 days (`:87`), same double application as scorecard_accountability (`:97`, `:118`, `:354-359`) | `due_days`, 2 (`:92`) — late when delay > 2 days (`:295`); the metric layer receives the same value as `overdueDays` and `slaHours = 48` (`:167-168`) | days; the metric layer reports hours for `scheduled_interview_to_feedback_hours` (`S/metrics.ts:120-131`) | person, same resolution as above (`:293`, `:309`) | severity = 100·rate + 8·late-or-unsubmitted + 5·max(0, mean delay − due) (`:347-352`); rows without any basis timestamp are excluded silently, not counted (`:283`) | Scorecard pagination complete (`:242-243`) |
| **source_quality** `analyze_source_quality` (`S/tools/source-quality.ts`) | Cohort clock: `applied_at ?? created_at ?? updated_at ?? last_activity_at` (`:308`); staleness: `last_activity_at` → `window_end` (`:311`) | `min(90, maxLookbackDays)` days (`:96`), applied in memory on the cohort clock (`:330`); a row with no timestamp at all is kept and counted in `data_quality.missing_application_timestamp` (`:151`, `:190`) | `stale_days`, 14 (`:101`); success = `hired` only, converted is not a win (`:322`) | count, ratio; scores on a 0–100 scale | `source_id` and `referrer_id` separately (`:334-339`), each resolved to a name through `/v3/sources` and `/v3/referrers`, never from the application row (`:130-148`). Grouping is by id, not by Greenhouse source category, so the six LinkedIn source ids on this tenant rank as six rows (`M/greenhouse-source-taxonomy.md`) | quality = 100·(0.45·success + 0.35·terminal-success + 0.20·healthy-active) (`:412-415`); risk = 100·(0.40·rejected + 0.35·stale + 0.25·(1 − success))·min(1, n/3) (`:417-420`); sorted by risk desc then quality asc (`:397`); prospects excluded (`:124`) | Application pagination complete (`:261-262`) |
| **rejection_reason_drift** `analyze_rejection_reason_drift` (`S/tools/rejection-reason-drift.ts`) | `rejection_details.created_at ?? rejected_at` (`:262`) | `min(90, maxLookbackDays)` days (`:64`), applied server-side as `created_at ≥ window_start` (`:73`) and in memory (`:94`, `:261-266`); a row with neither timestamp passes (`:263`) | None. Share = count / in-scope rejections (`:119`) | count and share | `rejection_reason_id` (`:236-259`) resolved through `/v3/rejection_reasons`; an archived or global id is labeled "reason <id> (name unavailable)" (`:117`, `:158`) | `unknown_reason_count` for rows with no structured reason (`:127`, `:190`); `top_reason_share` (`:167`); `job_ids` bridged through application ids because `/v3/rejection_details` 422s on it (`:82-88`) | Rejection-detail pagination complete (`:192-193`); `recordsAnalyzed` excludes unknown-reason rows (`:186`) |

Three things in that table decide the keep/rename/redefine verdict more than the rest.

The first is that "window" means three different things across the six. For stage_latency it is an upper bound only, which is the right call for a dwell metric and is documented in the code (`stage-latency.ts:455-459`). For pipeline_quality it is a label on the summary and nothing else, so a caller who passes `window_start` gets identical rows to one who does not; the honest description of that recipe is "a snapshot as of `window_end` with weekly inflow buckets", not a windowed analysis. For the two scorecard recipes it is a server-side `created_at` floor stacked on an in-memory `interviewed_at` filter, and the two disagree whenever a scorecard was created (the interview was scheduled) before the window and interviewed inside it, which is the common shape for a loop scheduled two weeks out. A market definition of "feedback SLA" would key on the interview date alone.

The second is that neither scorecard recipe reads `/v3/interviews`. The capability catalog says so and defends it: `interview.organizer_id` is roughly 0 % populated and `scorecard.interviewed_at` is effectively always populated (`S/resolvers/job-scope/capabilities.ts:67`, `:98`). That makes "scorecard debt" here mean "scorecards Greenhouse created and nobody submitted", which is a scorecard-centred definition; an interview that happened but for which Greenhouse never created a scorecard row is invisible to both recipes. The catalog's `scorecard_debt` entry (`capabilities.ts:230-256`) is the interview-centred version and is `limited`, model-composed from `search_my_interviews` plus `search_my_scorecards`, with no executor.

The third is grouping granularity. stage_latency and pipeline_quality group on `job_interview_stage_id`, a per-job id, so a cross-req "where are candidates stuck" answer arrives as one row per (req, stage) pair rather than one per stage name; the ranking sorts by severity, so the top of the list is the single worst req-stage, not the worst stage class. A recruiter asking about "the onsite stage across my FDE reqs" has to sum rows by `stage_name` themselves. The stage-name fallback exists only when the id is null (`stage-latency.ts:478`).

The catalog at `S/resolvers/job-scope/capabilities.ts:53-367` declares five more recipes with no executor: `silent_reqs_projected_limited` (planned, `:203-228`), `scorecard_debt` (limited, `:230-256`), `stalled_and_strong_projected_limited` (limited, `:258-283`), `slow_vs_doomed_projected_limited` (limited, `:313-339`), `stage_skip_integrity_projected_limited` (limited, `:341-366`). `getRecruitingCapabilities` filters them out of the model-visible catalog whenever a visible-tool set is passed (`:371-375`), so a recruiter's model never sees them; they sit in the catalog as intent with no executor behind them. The same file still tells the model "No write/admin tools (no reject, move-stage, offer, assignment, or patch operations)" (`:417`), which has been false since the write plane went live on 2026-07-30 (`M/greenhouse-write-plane-shipped.md`).

## B. Read gap

### B.1 The 22 hidden tools

`RECRUITER_TOOL_DEFINITIONS` registers 66 tools (54 evidence readers from `S/tools/evidence.ts:74-127` plus 12 composed in `S/tools/register.ts:27-41`); `PILOT_TOOL_NAMES` lists 44 (`S/tools/register.ts:44-94`). The allowlist is not enforced inside `register.ts`; it becomes real through `GREENHOUSE_RECRUITER_ALLOWED_TOOLS`, which production sets to exactly those 44 (`packages/recruiter-mcp/deploy/production.env.example:84`, enforced at `S/limits.ts:330`). The comment at `register.ts:43` states the count and no reason. The only live-code sentence about the 22 is `S/limits.ts:31-32`: "the 22 withheld source readers stay withheld for an entitled recruiter exactly as they do for everyone else", which restates the rule without citing anything.

| # | Hidden tool (`S/tools/evidence.ts`) | Endpoint (`S/harvest-v3-registry.ts`) | Recruiter job it serves | Citation status of the hiding |
|---|---|---|---|---|
| 1 | `search_my_job_interviews` (`:79`) | `/v3/job_interviews` (`:98`) | See which interview slots a req's plan defines, so "what is configured" can be compared with "what got scheduled" | uncited |
| 2 | `search_my_tracking_links` (`:94`) | `/v3/tracking_links` (`:113`) | See which share links exist per post, so a req's promotion channels are visible | uncited (the `token` field note at `:94` is a projection statement) |
| 3 | `search_my_job_notes` (`:102`) | `/v3/job_notes` (`:121`) | Read the req-level notes the hiring team left, so an intake decision is not re-litigated | uncited; per-note visibility is already enforced in projection |
| 4 | `search_my_pay_inputs` (`:109`) | `/v3/pay_inputs` (`:128`) | See the pay fields the org defines on a req | uncited |
| 5 | `search_my_approval_flows` (`:110`) | `/v3/approval_flows` (`:129`) | See where a req or an offer is stuck in approval | uncited |
| 6 | `search_my_approvers` (`:111`) | `/v3/approvers` (`:130`) | See who specifically owes the approval, so the right person is chased | uncited |
| 7 | `search_my_approver_groups` (`:112`) | `/v3/approver_groups` (`:131`) | See which approval step a req sits on and who is in that group | uncited |
| 8 | `search_my_scorecard_questions` (`:113`) | `/v3/scorecard_questions` (`:132`) | See what the rubric actually asks, so a low score means something | uncited |
| 9 | `search_my_scorecard_question_options` (`:114`) | `/v3/scorecard_question_options` (`:133`) | See the answer choices behind a rubric question | uncited |
| 10 | `search_my_scorecard_question_answer_options` (`:115`) | `/v3/scorecard_question_answer_options` (`:134`) | See which option an interviewer picked | uncited |
| 11 | `search_my_interview_kits` (`:116`) | `/v3/interview_kits` (`:135`) | Check the panel is running the right interview for the stage | uncited |
| 12 | `search_my_default_interviewers` (`:117`) | `/v3/default_interviewers` (`:136`) | See who is meant to sit on a kit's panel, so a loop can be staffed | uncited |
| 13 | `search_my_job_post_locations` (`:118`) | `/v3/job_post_locations` (`:137`) | See the actual location(s) a req is posted in, not the country-level office tag | uncited; the job-scope resolver already reads it internally (`S/resolvers/job-scope/inventory.ts:212`) |
| 14 | `search_my_pay_input_ranges` (`:119`) | `/v3/pay_input_ranges` (`:138`) | See the advertised band on a post, so an offer can be compared against it | uncited |
| 15 | `search_my_interviewer_tags` (`:120`) | `/v3/interviewer_tags` (`:139`) | Resolve interviewer tag ids to names, so qualified panelists can be found | uncited |
| 16 | `search_my_candidate_tags` (`:121`) | `/v3/candidate_tags` (`:140`) | See which tags exist, so the referral or silver-medalist pool can be found by name | uncited |
| 17 | `search_my_prospect_pools` (`:122`) | `/v3/prospect_pools` (`:141`) | See the sourcing pools attached to a req | uncited |
| 18 | `search_my_prospect_pool_stages` (`:123`) | `/v3/prospect_pool_stages` (`:142`) | See the stages inside a sourcing pool | uncited |
| 19 | `search_my_prospect_details` (`:124`) | `/v3/prospect_details` (`:143`) | See which prospects sit in which pool and who owns the outreach | uncited |
| 20 | `search_my_job_boards` (`:125`) | `/v3/job_boards` (`:144`) | See which boards the org publishes to | uncited |
| 21 | `search_my_custom_field_departments` (`:126`) | `/v3/custom_field_departments` (`:145`) | See which custom fields apply to a department | uncited |
| 22 | `search_my_custom_field_offices` (`:127`) | `/v3/custom_field_offices` (`:146`) | See which custom fields apply to an office | uncited |

The history in the origin checkout runs against the hiding. Commit `G 609f31e` ("T3.4 — expose 18 withheld domains (47 → 65 tools)") built 18 of these and exposed them, recording "No PII fields on any of the 18 contracts (verified from responseFields)" and calling the prior role-gated excuse one "the charter rejects"; `PILOT_TOOL_NAMES` did not exist at that commit. Commit `G 66cb2a6` ("fix(greenhouse-mcp): harden pilot authorization and rollout", 2026-07-15) introduced the allowlist at 19 tools with the comment "The deliberately small model-facing pilot catalog" and an empty body. Commit `G ceee5e4` ("Release exact 41-tool recruiter read catalog") restored 22, empty body. Commit `G 2d4bc18` exposed three more (41 → 44) and is the only commit in the chain that reasons about visibility at all, for exposure: "hiding them left the model holding undecodable numbers" (`register.ts:86-90`). This is the pattern recorded in `M/hardening-commits-withdraw-capability.md`.

### B.2 Hidden parameters and the classification constants

Two maps merged by `hiddenModelParameterMap()` (`S/harvest-v3-registry.ts:405-410`) remove parameters both from the tool schema (`S/tools/evidence.ts:36`) and from the read-time allowlist (`S/runtime.ts:133`, `S/tools/evidence-read.ts:114`).

| Endpoint | Hidden param | Stated reason (`S/harvest-v3-registry.ts`) | External constraint cited? |
|---|---|---|---|
| all 72 | `fields` | "Projection fields are governed by registry projection profiles" (`:307-309`) | no; architecture choice |
| `/v3/candidates` | `private` | "Private-candidate visibility is a role gate, not a default model filter" (`:313`) | partly: the row filter is a real Greenhouse per-user permission and is already enforced upstream; hiding the filter only stops a recruiter from counting the exclusion |
| `/v3/candidates` | `custom_field_option_id` | "deferred to role-aware projection profiles" (`:314`) | no; the profile at `:525-530` is declared not to exist |
| `/v3/offers` | `custom_field_option_id` | "compensation-sensitive facts and require a role profile" (`:322`) | no; the offer row's `custom_fields` already pass the projector on the same surface (`S/tools/evidence-projection.ts:689-696`) |
| `/v3/tracking_links` | `token` | "intentionally omitted" (`:325`) | no; moot, tool hidden |
| `/v3/users` | `primary_email` | "contact data" (`:328`) | weak; contact-PII category, no named rule |
| `/v3/users` | `show_service_accounts` | "admin diagnostic control" (`:329`) | no; excluding service accounts is what a per-recruiter denominator needs |
| `/v3/user_emails` | `email`, `verification_token_sent_at` | "sensitive personal data" (`:332-333`) | weak; moot, endpoint unbound |

The same file un-hid `custom_field_option_id` on openings, rejection_details and users because "the former 'role-aware projection decision' reason cited no external constraint" (`:316-320`), and left the identical reason standing on candidates and offers two lines below.

The twelve classification constants (`S/harvest-v3-registry.ts:158-305`) set `scopeClass` and `sensitivityClass` on each endpoint. None gates a read and none excludes an endpoint from tool generation: `exposureForEndpoint()` (`S/tools/scoped-endpoint-adapters.ts:172-179`) decides exposure purely on whether an evidence tool exists, and `nonExposureReason()` (`:181-196`) narrates a class-derived reason afterwards into a string nothing consumes. `defaultProjectionProfile` is dead as a control by its own comment: "Advisory classification metadata only… there is NO profile-selection argument that restores a fuller view" (`:525-530`). The `role_gated` reason text, "kept off the default recruiter evidence surface until a named projection profile is implemented" (`adapters.ts:192-194`), is the not-yet-built-profile excuse `609f31e` rejected, and it is inert anyway: 26 of the 29 role-gated endpoints are bound and 15 of those are in the exposed 44. The one class with a real external constraint behind it, `COMPLIANCE_SENSITIVE_ENDPOINTS` (EEOC and demographics, `:294-300`), does not name it in code; the only place it is named is the `609f31e` commit message.

### B.3 The 22 unbound endpoints

72 GET endpoints in `S/harvest-v3-registry.generated.ts` (header, line 2); `EVIDENCE_TOOL_ENDPOINT_PAIRS` (`S/harvest-v3-registry.ts:92-147`) binds 54 tools to 50 unique paths. None of the 22 below appears in `evidence.ts`, `evidence-read.ts`, `evidence-projection.ts`, `scoped-endpoint-adapters.ts`, or `application-job-lookup.ts`.

| # | Endpoint | Recruiter job it would serve | Stated reason (`S/tools/scoped-endpoint-adapters.ts`) | Cited? |
|---|---|---|---|---|
| 1 | `/v3/applied_candidate_tags` | Find every candidate actually carrying "Referral" or "Silver Medalist": the pool, not the dictionary | catch-all `:195` "available for future scoped facts or metrics" | uncited |
| 2 | `/v3/blocked_spam_sources` | Exclude blocked sources from source-quality denominators | admin_diagnostic `:189-191` | uncited |
| 3 | `/v3/bulk_requests` | Check whether a bulk operation on my reqs finished | admin_diagnostic | uncited |
| 4 | `/v3/bulk_requests/{bulk_action_uuid}` | Same, one request | admin_diagnostic | uncited |
| 5 | `/v3/candidate_attribute_types` | See what competency attribute types a req defines | catch-all | uncited |
| 6–9 | `/v3/demographic_answer_options`, `/v3/demographic_answers`, `/v3/demographic_question_sets`, `/v3/demographic_questions` | Aggregate DEI funnel | compliance `:186-188`, internal wording | real constraint, named only in commit `609f31e` |
| 10 | `/v3/eeoc` | Aggregate EEO reporting | compliance | same |
| 11 | `/v3/email_templates` | See the approved candidate-email copy, and the `email_template_id` a rejection email needs | role_gated `:192-194` | uncited |
| 12 | `/v3/focus_candidate_attributes` | See which attributes an interview kit is meant to probe | catch-all | uncited |
| 13 | `/v3/future_job_permissions` | See which upcoming reqs a teammate will get access to | admin_diagnostic | uncited |
| 14 | `/v3/job_board_custom_locations` | See the custom location labels a board publishes under | catch-all | uncited |
| 15 | `/v3/job_candidate_attributes` | See the competency attributes on my req, so scorecard attribute ratings mean something | catch-all | uncited |
| 16 | `/v3/job_post_searchable_locations` | Get the real city, region, and lat-long a req is posted to | catch-all | uncited; see below |
| 17 | `/v3/rejection_reasons/{id}` | Look up one reason by id (list form is exposed) | catch-all | uncited, low value |
| 18 | `/v3/scorecard_candidate_attributes` | See how an interviewer rated each competency, with their note | role_gated | uncited |
| 19 | `/v3/scorecard_question_candidate_attributes` | Link a rubric question to the competency it scores | role_gated | uncited |
| 20 | `/v3/user_emails` | Roster contact inventory | sensitive_personal plus param reasons | cited weakly (contact PII) |
| 21 | `/v3/user_job_permissions` | Not a recruiter tool: the permission spine | `:177`, `:183-185` "Internal permission infrastructure" | cited and true (`packages/scoped-core/src/index.ts:447`; `A/actions/shared.ts:84`, `:114`) |
| 22 | `/v3/user_roles` | Decode the `role_id` that `search_my_users` returns | admin_diagnostic | uncited; `scoped-core/src/index.ts:489` names it as the dictionary that decodes `role_id` |

Three of these pair with hidden tools to close a recruiter question at both ends. Location: `/v3/job_post_searchable_locations` (city, region, lat-long per post; `S/harvest-v3-registry.generated.ts` entry for that path) is unbound and `search_my_job_post_locations` is hidden, while the server's own instructions tell the model "Geo/office tags are COARSE: a job posted to a specific city often carries only a country-level tag ('USA')" (`S/server.ts:50`). Referral pool: `/v3/applied_candidate_tags` is unbound and `search_my_candidate_tags` is hidden. Roles: `/v3/user_roles` is unbound while `search_my_users` is exposed and returns an undecodable `role_id`, the same defect `2d4bc18` fixed for departments, offices and close reasons.

### B.4 Measured facts behind the Linear findings

The findings recorded in Linear were re-measured by driving the registrar with a stub runtime (`tsx` script reproduced in the agent transcript; run from the repo root against `S/tools/register.ts`). Registrations with no MCP `title`: 66 of 66 (44 of 44 in production), structural rather than data: the registrar signature `tool(name, description, paramsSchema, annotations, handler)` (`S/tools/register.ts:108-116`) has no title slot, and the variable named `title` at `register.ts:466` is bound to `previewDescription`/`applyDescription` and passed as the description. Undescribed params: 136 of 410 across the exposed 44 (213 of 619 across all 66), not the 128 of 311 Linear records; the misses are systematic in `zodSchemaForParameter` (`S/tools/evidence.ts:185-222`), which describes `cursor`, `per_page`, date params and the injected scope params and lets every plain id filter, enum and boolean fall through bare, so `search_my_jobs.status` is an enum whose legal values the model cannot see. Instructions: `SERVER_INSTRUCTIONS` is a static 3,894-character, 32-line join (`S/server.ts:22-55`, passed at `:83`); no code truncates it (the only `2048` in the package is `MAX_READ_PARAM_STRING_LENGTH`, `S/limits.ts:66`). The truncation is the client's: the copy delivered into a session's system prompt ends mid-sentence at "Source-quality… [truncated]", about the 2 KB mark, which drops the EVIDENCE READ CONVENTIONS block (`server.ts:42-47`) and the DATA IS UNHYGIENIC block (`:49-54`) entirely. Tool descriptions for users, referrers and offers are at `S/tools/evidence.ts:89`, `:92`, `:95`; the Linear finding that they contradict the code is taken as recorded and was not re-verified here.

## C. Write gap

### C.1 What ships: 11 action kinds over 13 endpoints

Every kind is a preview/apply pair; the preview mints a five-minute HMAC intent (`A/crypto.ts:44`, `:92-113`) bound to session, tool, binding, and three state fingerprints; apply re-runs `prepare()` against live Greenhouse (`A/service.ts:157`), re-fences, re-checks entitlement, claims a lock, and refuses on `STATE_CHANGED` (`A/service.ts:327-339`). Two gates run on every kind: `assertJobAccess` (site admin on a non-confidential job, or an explicit `user_job_permissions` row; `A/actions/shared.ts:76-100`) and the visibility fence, which runs the recruiter's own read-plane read on each target and denies `TARGET_NOT_VISIBLE` on a hidden or redacted row (`A/service.ts:284-306`; `S/action-visibility.ts:109-155`). Entitlement is three booleans per (identity, client): `can_preview`, `can_apply`, `can_apply_high_impact` (`packages/action-mcp/supabase/action-state.sql:8-45`); there is no per-kind and no per-job column, and both capability env vars default to all eleven kinds (`A/env.ts:138-141`; `A/action-plane.ts:166-168`).

| Kind (`A/actions/index.ts:15-27`) | Endpoint | Inputs | Preconditions in code | High impact | Notification-controlling field passed? |
|---|---|---|---|---|---|
| `application_assignment_change` | `PATCH /applications/{id}` (`application-assignment.ts:130-135`) | `application_id`, `assignment_role` recruiter\|coordinator, `proposed_user_id` (`:17-21`) | application visible; proposed user active (`:53-54`). Proposed user's job access is not checked (contrast `job_owner_change`) | never | none; body is exactly `{recruiter_id}` or `{coordinator_id}` (`:132-134`) |
| `job_owner_change` | `POST /job_owners`, `DELETE /job_owners/{row}` (`job-owner.ts:126-129`) | `verb` add\|remove, `job_id`, `user_id`, `owner_type` sourcer\|recruiter\|coordinator (`:19`) | job access; tuple unique; remove requires existence; candidate-responsible owners cannot be removed (`:46-66`); add requires the user to already hold job access (`shared.ts:111-121`) | never | none; `candidate_responsibility` never sent |
| `application_stage_move` | `POST /applications/{id}/move` (`application-stage-move.ts:94-97`) | `application_id`, `to_stage_id` (`:15`) | status `in_process`; application and stage rows agree; destination active on this job (`:25-40`) | always (`:66`) | none, but the move fires configured stage-transition rules "including automated emails" (`D/0019-post_v3-applications-id-move.md:8`); the approval text discloses it (`:50`) |
| `application_rejection` | `POST /applications/{id}/reject` (`application-rejection.ts:163-170`) | `application_id`, `rejection_reason_id`, `notes?` (`:17-21`, strict) | status `in_process`; no existing rejection details; reason resolves uniquely (`:85-94`) | never | **`rejection_email` is never constructed**; body is `{rejection_reason_id, notes?}` (`:163-170`); effect text "Rejects the application without sending a candidate email" (`:116`) |
| `application_unreject` | `POST /applications/{id}/unreject`, body `{}` (`application-unreject.ts:99`) | `application_id` | status `rejected`; details unique; pre-rejection stage resolvable from `entered_at ≤ rejected_at` (`:28-46`; live shape in `M/greenhouse-unreject-not-dead.md`) | never | endpoint has no body properties |
| `candidate_note_create` | `POST /notes` (`candidate-note-create.ts:136-147`) | `application_id`, `body`, `visibility` admin_only\|private\|public, `note_type` NOTE\|ACTIVITY (`:16-21`) | application visible; identical notes surfaced, not blocked (`:82-86`) | never | `EMAIL` note type excluded by the enum, so the log-an-email path is closed |
| `job_note_change` | `POST`/`PATCH`/`DELETE /job_notes` (`job-note-change.ts:205-215`) | discriminated on `verb` (`:18-26`) | job access; note belongs to the job; update/delete fence requires the note body be unredacted (`:162-164`) | never | none |
| `application_attribution_change` | `PATCH /applications/{id}` (`application-attribution.ts:147-154`) | `application_id`, `source_id?`, `referrer_id?`, at least one (`:13-21`) | source/referrer resolve uniquely (`:50-67`) | never | none |
| `candidate_record_update` | `PATCH /candidates/{id}` (`candidate-record-update.ts:450`) | `context_application_id` plus `changes` over 14 fields (`:195-212`); collections patched as add/remove | anti-swap check on candidate/job (`:315-317`); linked users active; custom fields validated | never | `is_private` and `can_email` are not exposed (`:435`) |
| `offer_create` | `POST /offers` (`offer-create.ts:106-114`) | `application_id`, `starts_on?`, `custom_fields?` | refuses if any offer chain exists (`:25-34`), narrower than the endpoint, which folds into the chain | when any field is currency-typed (`:73`) | none; creating does not send (`D/0132-post_v3-offers.md`) |
| `offer_update` | `PATCH /offers/{id}` (`offer-update.ts:147-154`) | `application_id`, `offer_id`, `starts_on?`, `custom_fields?` | offer current and unique; status `Created` (`:40-46`) | when currency-typed (`:109`) | `sent_on`, `resolved_at`, `created_at` never sent |

Two facts about the shipped set matter for the build. Writes go out under the service token unless `GREENHOUSE_ACTION_ATTRIBUTION_MODE=per_human` and the probe flag are both set (`A/greenhouse.ts:218-227`), so Greenhouse's activity feed records the service account, not the recruiter the whole entitlement apparatus identified. And "high impact" gates exactly two things, every stage move and any currency-bearing offer, so rejection sits at the same tier as changing a source id.

### C.2 The full Harvest v3 write surface against what ships

90 write pages (POST/PATCH/PUT/DELETE) under `D`; `POST /auth/token` (`D/0012`) is the OAuth endpoint and is excluded. Every page declares exactly one scope. "Shipped" means an action kind calls it. "Candidate-notifying" is what the doc text says; "doc silent" means the page says nothing about notifications, so a send can be neither assumed nor ruled out from the docs. Per the vendor pages, only two endpoints in the whole surface send anything to a candidate: reject with a `rejection_email` object, and move through tenant-configured transition rules.

**Scheduling**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/interviews` | `harvest:interviews:create` | no | no; "records an already-scheduled calendar event rather than creating one" | Record the loop I scheduled; requires `external_event_id`, so the calendar is the system of record | `D/0101` |
| `PATCH /v3/interviews/{id}` | `harvest:interviews:update` | no | no; "updates the Greenhouse interview record only" | Reschedule or re-panel; `interviewers` replaces wholesale | `D/0100` |
| `DELETE /v3/interviews/{id}` | `harvest:interviews:destroy` | no | no; calendar event not deleted | Cancel a loop; only `scheduled`/`awaiting_feedback` | `D/0098` |

**Candidate and application lifecycle**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/applications` | `harvest:applications:create` | no | doc silent | Add a candidate to a second req, or create a prospect | `D/0022` |
| `POST /v3/applications/{id}/move` | `harvest:applications:move` | **yes** (stage move) | **yes**: transition rules fire "including automated emails sent from `email_from_user_id`"; no opt-out field | Advance or transfer (`to_job_id` lands on first stage; not exposed by the action) | `D/0019` |
| `POST /v3/applications/{id}/reject` | `harvest:applications:reject` | **yes**, without email | **yes when `rejection_email` passed** (`email_template_id`, `send_email_at`, `email_from_user_id`) | Reject and tell the candidate | `D/0020` |
| `POST /v3/applications/{id}/unreject` | `harvest:applications:unreject` | **yes** | doc silent | Reinstate; clears reason and notes | `D/0021` |
| `POST /v3/applications/{id}/hire` | `harvest:applications:hire` | no | doc silent | Mark hired, close the opening; `opening_id` required when >1 open | `D/0018` |
| `POST /v3/applications/{id}/convert_to_candidate` | `harvest:applications:convert_to_candidate` | no | doc silent | Promote a prospect onto a req | `D/0017` |
| `PATCH /v3/applications/{id}` | `harvest:applications:update` | **yes** (assignment; attribution) | doc silent | Fix source, referrer, recruiter, coordinator; also `prospect_pool_id`, `rejected_at`, `created_at`, `custom_fields` (not exposed) | `D/0016` |
| `DELETE /v3/applications/{id}` | `harvest:applications:destroy` | no | doc silent | "cannot be undone" | `D/0014` |
| `POST /v3/candidates` | `harvest:candidates:create` | no | doc silent (`can_email` is a consent flag) | Create a sourced candidate with first application | `D/0061` |
| `PATCH /v3/candidates/{id}` | `harvest:candidates:update` | **yes** (14 of 16 fields) | doc silent | Fix the profile; `is_private`, `can_email` withheld | `D/0059` |
| `POST /v3/candidates/{id}/merge` | `harvest:candidates:merge` | no | doc silent | Dedupe; secondary deleted | `D/0060` |
| `PATCH /v3/candidates/{id}/anonymize` | `harvest:candidates:anonymize` | no | doc silent; "irreversible" | GDPR request; compliance job, not recruiter | `D/0058` |
| `DELETE /v3/candidates/{id}` | `harvest:candidates:destroy` | no | doc silent; "cannot be undone" | none for a recruiter | `D/0056` |
| `POST /v3/candidate_educations` | `harvest:candidate_educations:create` | no | doc silent | Fill in education from a resume | `D/0049` |
| `DELETE /v3/candidate_educations/{id}` | `harvest:candidate_educations:destroy` | no | doc silent | Correct (no update endpoint; delete and recreate) | `D/0047` |
| `POST /v3/candidate_employments` | `harvest:candidate_employments:create` | no | doc silent | Fill in work history | `D/0052` |
| `DELETE /v3/candidate_employments/{id}` | `harvest:candidate_employments:destroy` | no | doc silent | Correct | `D/0050` |
| `POST /v3/attachments` | `harvest:attachments:create` | no | doc silent | Attach a resume, take-home, or offer packet; replaces prior resume | `D/0036` |
| `DELETE /v3/attachments/{id}` | `harvest:attachments:destroy` | no | doc silent; "cannot be undone" | Remove a wrong upload | `D/0034` |

**Notes and tags**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/notes` | `harvest:notes:create` | **yes** (NOTE, ACTIVITY) | no; `EMAIL` type logs, does not send | Record a call; log an email sent elsewhere (withheld) | `D/0129` |
| `POST /v3/job_notes` | `harvest:job_notes:create` | **yes** | doc silent | Intake notes on a req | `D/0113` |
| `PATCH /v3/job_notes/{id}` | `harvest:job_notes:update` | **yes** | doc silent | Edit | `D/0112` |
| `DELETE /v3/job_notes/{id}` | `harvest:job_notes:destroy` | **yes** | doc silent; "cannot be reversed" | Delete | `D/0110` |
| `POST /v3/candidate_tags` | `harvest:candidate_tags:create` | no | doc silent | Create a tag ("Silver Medalist") | `D/0055` |
| `DELETE /v3/candidate_tags/{id}` | `harvest:candidate_tags:destroy` | no | doc silent; removes from every candidate | Retire a tag | `D/0053` |
| `POST /v3/applied_candidate_tags` | `harvest:applied_candidate_tags:create` | no | doc silent | Tag a candidate | `D/0025` |
| `DELETE /v3/applied_candidate_tags/{id}` | `harvest:applied_candidate_tags:destroy` | no | doc silent | Untag | `D/0023` |

**Offers and approvals**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/offers` | `harvest:offers:create` | **yes** (new chain only) | no; approvals "must drive… before the offer can be sent to the candidate" | Draft an offer | `D/0132` |
| `PATCH /v3/offers/{id}` | `harvest:offers:update` | **yes** (`starts_on`, `custom_fields`) | no; `sent_on` backfills, does not send | Revise start date or comp | `D/0131` |
| `POST /v3/approval_flows` | `harvest:approval_flows:create` | no | no; "created in `pending` status with no emails sent" | Set up offer approval | `D/0029` |
| `POST /v3/approval_flows/{id}/request_approvals` | `harvest:approval_flows:request_approvals` | no | **emails approvers** ("by emailing its initial approver(s)"); the page's `requested_by_user_id` is absent from its schema | Kick off approval | `D/0028` |
| `PATCH /v3/approval_flows/{id}` | `harvest:approval_flows:update` | no | doc silent on the call | Toggle sequential | `D/0027` |
| `PUT /v3/approval_flows/{id}/replace_approver_groups` | `harvest:approval_flows:replace_approver_groups` | no | doc silent on the call | Re-tier approvers | `D/0030` |
| `PUT /v3/approver_groups/{id}/replace_approver` | `harvest:approver_groups:replace_approver` | no | doc silent | Swap an absent approver | `D/0032` |

**Jobs, openings, posts, req hygiene**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/jobs` | `harvest:jobs:create` | no | doc silent | Open a req from a template | `D/0127` |
| `POST /v3/jobs/bulk` | `harvest:jobs:create` | no | doc silent | Bulk open | `D/0126` |
| `PATCH /v3/jobs/{id}` | `harvest:jobs:update` | no | doc silent | Rename, fix office/department, edit notes | `D/0125` |
| `POST /v3/openings` | `harvest:openings:create` | no | doc silent | Add headcount (100 open per job max) | `D/0143` |
| `POST /v3/openings/bulk` | `harvest:openings:create` | no | doc silent | Bulk headcount | `D/0142` |
| `PATCH /v3/openings/{id}` | `harvest:openings:update` | no | doc silent | Close an opening (closing the last one closes the job); set `target_start_on` | `D/0141` |
| `PATCH /v3/openings/bulk` | `harvest:openings:update` | no | doc silent | Bulk close | `D/0140` |
| `DELETE /v3/openings/{id}` | `harvest:openings:destroy` | no | doc silent | Remove a closed, unfilled opening | `D/0138` |
| `DELETE /v3/openings/bulk` | `harvest:openings:destroy` | no | doc silent | Bulk remove | `D/0137` |
| `POST /v3/job_posts` | `harvest:job_posts:create` | no | doc silent on the call | Duplicate a post onto a board | `D/0123` |
| `PATCH /v3/job_posts/{id}` | `harvest:job_posts:update` | no | doc silent on the call; `job_application_status` draft\|live **is the publish control** | Publish or unpublish; edit copy | `D/0122` |
| `POST /v3/job_post_locations` | `harvest:job_post_locations:create` | no | doc silent | Post to a city | `D/0119` |
| `DELETE /v3/job_post_locations/{id}` | `harvest:job_post_locations:destroy` | no | doc silent | Remove a location | `D/0117` |
| `POST /v3/job_owners` | `harvest:job_owners:create` | **yes** | doc silent | Add recruiter/sourcer/coordinator | `D/0116` |
| `DELETE /v3/job_owners/{id}` | `harvest:job_owners:destroy` | **yes** | doc silent | Remove | `D/0114` |
| `POST /v3/job_hiring_managers` | `harvest:job_hiring_managers:create` | no | doc silent | Assign HM | `D/0107` |
| `DELETE /v3/job_hiring_managers/{id}` | `harvest:job_hiring_managers:destroy` | no | doc silent | Unassign HM | `D/0105` |
| `POST /v3/departments` | `harvest:departments:create` | no | doc silent | Org structure; admin | `D/0088` |
| `PATCH /v3/departments/{id}` | `harvest:departments:update` | no | doc silent | admin | `D/0087` |
| `PATCH /v3/departments/bulk` | `harvest:departments:update` | no | doc silent | admin | `D/0086` |
| `POST /v3/offices` | `harvest:offices:create` | no | doc silent | admin | `D/0136` |
| `PATCH /v3/offices/{id}` | `harvest:offices:update` | no | doc silent | admin | `D/0135` |
| `PATCH /v3/offices/bulk` | `harvest:offices:update` | no | doc silent | admin | `D/0134` |
| `POST /v3/custom_fields` | `harvest:custom_fields:create` | no | doc silent | admin | `D/0079` |
| `PATCH /v3/custom_fields/{id}` | `harvest:custom_fields:update` | no | doc silent | admin | `D/0078` |
| `DELETE /v3/custom_fields/{id}` | `harvest:custom_fields:destroy` | no | doc silent; "cannot be undone", drops stored values everywhere | admin | `D/0076` |
| `POST /v3/custom_field_options` | `harvest:custom_field_options:create` | no | doc silent | Add a dropdown value | `D/0075` |
| `POST /v3/custom_field_options/bulk` | `harvest:custom_field_options:create` | no | doc silent | admin | `D/0074` |
| `PATCH /v3/custom_field_options/{id}` | `harvest:custom_field_options:update` | no | doc silent | Rename a value | `D/0073` |
| `PATCH /v3/custom_field_options/bulk` | `harvest:custom_field_options:update` | no | doc silent | admin | `D/0072` |
| `DELETE /v3/custom_field_options/{id}` | `harvest:custom_field_options:destroy` | no | doc silent; soft archive | Retire a value | `D/0070` |
| `DELETE /v3/custom_field_options/bulk` | `harvest:custom_field_options:destroy` | no | doc silent; soft | admin | `D/0069` |
| `POST /v3/custom_field_departments` | `harvest:custom_field_departments:create` | no | doc silent | admin | `D/0065` |
| `DELETE /v3/custom_field_departments/{id}` | `harvest:custom_field_departments:destroy` | no | doc silent | admin | `D/0063` |
| `POST /v3/custom_field_offices` | `harvest:custom_field_offices:create` | no | doc silent | admin | `D/0068` |
| `DELETE /v3/custom_field_offices/{id}` | `harvest:custom_field_offices:destroy` | no | doc silent | admin | `D/0066` |
| `PATCH /v3/rejection_details/{id}` | `harvest:rejection_details:update` | no | doc silent; no email | Correct a rejection reason after the fact, without re-rejecting | `D/0151` |

**Users and permissions**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/users/bulk` | `harvest:users:create` | no | emails the **user** when `send_email_invite=true` (default false) | admin | `D/0173` |
| `PATCH /v3/users/{id}` | `harvest:users:update` | no | doc silent | admin | `D/0171` |
| `PATCH /v3/users/bulk` | `harvest:users:update` | no | doc silent | admin | `D/0170` |
| `POST /v3/users/activate/bulk` | `harvest:users:activate` | no | doc silent | admin | `D/0172` |
| `POST /v3/users/deactivate/bulk` | `harvest:users:deactivate` | no | doc silent | admin (offboarding) | `D/0174` |
| `POST /v3/user_emails` | `harvest:user_emails:create` | no | emails the **user** when `send_verification=true` (default false) | admin | `D/0164` |
| `POST /v3/user_job_permissions` | `harvest:user_job_permissions:create` | no | doc silent | Give a teammate access to my req (Job Admin roles only) | `D/0167` |
| `DELETE /v3/user_job_permissions/{id}` | `harvest:user_job_permissions:destroy` | no | doc silent | Revoke | `D/0165` |
| `POST /v3/future_job_permissions` | `harvest:future_job_permissions:create` | no | doc silent; omitting all scope fields grants every future job | admin | `D/0094` |
| `DELETE /v3/future_job_permissions/{id}` | `harvest:future_job_permissions:destroy` | no | doc silent | admin | `D/0092` |

**Delete class and spam**

| Endpoint | Scope | Shipped? | Candidate-notifying (doc) | Recruiter job | Page |
|---|---|---|---|---|---|
| `POST /v3/blocked_spam_sources` | `harvest:blocked_spam_sources:create` | no | no; matching applications "rejected at intake" | Block a spam domain | `D/0043` |
| `POST /v3/blocked_spam_sources/bulk` | `harvest:blocked_spam_sources:create` | no | same | admin | `D/0042` |
| `PATCH /v3/blocked_spam_sources/{id}` | `harvest:blocked_spam_sources:update` | no | doc silent | note only | `D/0041` |
| `PATCH /v3/blocked_spam_sources/bulk` | `harvest:blocked_spam_sources:update` | no | doc silent | admin | `D/0040` |
| `DELETE /v3/blocked_spam_sources/{id}` | `harvest:blocked_spam_sources:destroy` | no | doc silent; prior rejections persist | Unblock | `D/0038` |
| `DELETE /v3/blocked_spam_sources/bulk` | `harvest:blocked_spam_sources:destroy` | no | doc silent | admin | `D/0037` |

The 23 DELETE endpoints across the groups above split into five the vendor marks irreversible (`applications`, `attachments`, `candidates`, `custom_fields`, `job_notes`: `D/0014`, `0034`, `0056`, `0076`, `0110`), two that are soft archives (`custom_field_options` single and bulk: `D/0070`, `0069`), and sixteen join-row or reversible removals. One of the five irreversible deletes is already shipped (`job_note_change` delete, `A/actions/job-note-change.ts:114`).

Three scope strings are declared in every page's security block with no endpoint behind them in this reference set: `harvest:users:revoke_permissions` (referenced by `D/0171` as a "dedicated endpoint"), `harvest:scorecards:create|update`, and `harvest:webhooks:*`. There is no Harvest v3 endpoint that sends a free-form email to a candidate; the only candidate mail the API can trigger is the templated rejection email and whatever transition rules the tenant configured on a stage move. Scheduling is likewise not something the API does: `POST /v3/interviews` records an event the calendar already holds.

Set against the shipped eleven, the recruiter-facing endpoints with no action are: the three interview endpoints; `hire`, `convert_to_candidate`, `POST /applications`; candidate create, merge, educations, employments, attachments; the four tag endpoints; the five approval endpoints; `PATCH /rejection_details`; `PATCH /job_posts` and the two location endpoints; openings create/close; `job_hiring_managers`; and `user_job_permissions`. That is 33 endpoints a recruiter or coordinator would plausibly use in a week, against 13 shipped.

## D. Router audit

### D.1 The routing order

`runRecruitingQuestionAnswer` (`S/tools/question-answer.ts:170-537`) resolves scope first, then routes in this order:

1. `resolvePlannerScope` (`:1150-1229`). An explicit `scope_handle` or `job_ids` is validated (`:1156-1170`). Otherwise the permission inventory is loaded and `isAdmin = scopeKind !== "jobs"` (`:1180`). Possessive intent, `/\b(my|our)\s+(open\s+|active\s+|current\s+)?(reqs?|requisitions?|roles?|jobs?|positions?|openings?|pipelines?|portfolio)\b/i` (`:1267`), resolves the actor's recruiter/sourcer assignments through `/v3/job_owners` (`S/tools/job-scope/tools.ts:536-558`); coordinator and hiring-manager assignments do not count. A narrow recruiter with no owner intent, no resolver params, and no org-broad phrase skips the resolver entirely (`:1199-1201`). Org-broad phrases are `org wide|company wide|organization wide|every recruiter|all recruiters|across the (org|organization|company)` and `(all|every|each|entire) (open|active|current)? (jobs|reqs|requisitions|roles|positions|openings|pipelines)` unless followed by `my|our` (`:1282-1288`). A site admin always lands in `needs_confirmation` unless the path was exact ids: `(isAdmin && !exactPath)` at `S/resolvers/job-scope/resolver.ts:437`, with `admin_scope` added to the reason codes (`:427`, `:443`).
2. `detectMissingDomain` (`:611-693`), six phrase sets checked before any recipe keyword so a confident wrong recipe cannot grab them. Each maps to one metric, and every one of the six now has an executable binding in `PLANNED_DOMAIN_BINDINGS` (`:708-715`), so the "recognized but unimplemented" branch at `:277-324` is reachable only if a binding is removed.
3. `selectRecipes` (`:569-599`). A rejection-reason phrase (`/\b(rejection reasons?|reject reasons?|reasons? for rejection|reason drift)\b/i`, `:574`) routes only to `rejection_reason_drift`. Otherwise every recipe whose regex matches is selected, up to `max_recipes` (default 6, `:75`, `:587`). No match falls to the broad panel only on explicit intent (`:583-585`).
4. Unrecognized: `missing_domain` with `domain_recognized: false` and the message "No approved scoped-analysis recipe matches this question. Ask about scorecard accountability, interview feedback drag, stage latency, pipeline quality, or source quality" (`:326-374`, message at `:357`; it omits rejection_reason_drift).

### D.2 Exact keyword lists

| Recipe | Regex (`S/tools/question-answer.ts`) | Params forwarded (`pickParams`) |
|---|---|---|
| scorecard_accountability | `/\b(scorecard\|scorecards\|unsubmitted\|submitted\|submitter\|perpetrator\|culpab\|offender\|accountab\|repeat offender)\b/i` (`:81`) | window_start, window_end, job_ids, max_rankings, per_page, evidence_pack, evidence_pack_limit (`:87`) |
| interview_feedback_drag | `/\b(feedback\|interview\|late\|overdue\|missing scorecard\|delay\|delayed\|sla)\b/i` (`:93`) | plus `due_days` (`:99`) |
| stage_latency | `/\b(stage\|stages\|stuck\|aging\|aged\|latency\|bottleneck\|bottlenecks\|dwell\|slow\|slower\|slowness\|stall\|stalls\|stalling\|stalled\|stale)\b/i` (`:105`) | plus `status`, `min_age_days`, `include_terminal` (`:111`) |
| pipeline_quality | `/\b(pipeline\|quality\|health\|conversion\|converted\|hired\|rejected\|rejection\|fallout\|status mix\|stale active\|terminal\|weekly\|volume\|movement\|throughput)\b/i` (`:117`) | plus `status`, `stale_days` (`:123`) |
| source_quality | `/\b(source\|sources\|sourcing\|referrer\|referrers\|referral\|referrals\|agency\|agencies\|channel\|channels\|yield\|source quality\|attribution)\b/i` (`:129`) | plus `source_ids`, `referrer_ids`, `status`, `stale_days` (`:135`) |
| rejection_reason_drift | `/\b(rejection reason\|rejection reasons\|reject reason\|reject reasons\|reason for rejection\|reasons for rejection\|rejection reason drift\|overusing)\b/i` (`:141`) | window, job_ids, max_rankings, per_page, evidence_pack (`:147`) |

Explicit `recipes:` aliases (`:1005-1034`): scorecards, scorecard, feedback, interview_feedback, stage, pipeline, source, sources, referrals, rejection, rejections, rejection_reason, rejection_reasons, reason_drift, plus each recipe id. Broad-diagnostic phrases (`:902-908`): `params.broad === true`, `recipes: "all"`, or `overall|health check|full diagnostic|full picture|everything|comprehensive|end to end|across all|across my`.

Two phrase-level defects sit inside those lists. "interview" alone routes to interview_feedback_drag (`:93`), so "how many interviews did we run last week" runs a feedback-delay ranking. And "stale" appears in both stage_latency and pipeline_quality's `stale active` (`:105`, `:117`), so any question with "stale" runs two recipes, which is acceptable, while "quiet", "silent", "no activity", "follow up", "today", "this week", "time to fill", "why" appear in none.

### D.3 The missing-domain phrases and what executes

| Phrase set (`detectMissingDomain`) | Metric and binding | Reads | Window applied? | Live status |
|---|---|---|---|---|
| `approval\|approvals\|approver\|approval flow(s)\|approval latency` (`:613`) | `approval_latency` over `list_approval_flows` (`:709`) | `/v3/approval_flows`, a **hidden** tool | on `created_at` | pending-age only; v3 has no resolution timestamp (`S/metrics.ts:222-235`). Internal read of a hidden endpoint; not live-verified |
| `prospect(s)\|prospect pool\|pool movement\|talent pool` (`:624`) | `prospect_pool_movement` over `list_prospect_details` (`:710`) | hidden tool | none; point-in-time, disclosed (`:830-833`) | distribution only, no movement (`metrics.ts:236-250`) |
| `(scheduling\|scheduled\|schedule\|availability\|coordinator)` and `interview(s)` (`:635`) | `availability_to_scheduled_interview_hours` over `list_interviews` (`:711`) | `/v3/interviews`, exposed | on `scheduled_at` | requires `availability_received_at`, which v3 interviews do not carry (`metrics.ts:108-119`); expect an empty metric with an omission |
| `job post(s)\|job posting(s)\|tracking link(s)\|post exposure\|posting exposure\|exposure by post` (`:646`) | `job_post_exposure_by_post` over `list_tracking_links` (`:712`) | hidden tool | none | counts tracking links per post, "NOT applicants-per-post" (`metrics.ts:207-220`) |
| `opening(s)\|headcount\|head count\|target start\|opening aging\|aging openings` (`:667`) | `opening_fill_status` over `list_openings` (`:713`) | exposed | none; point-in-time | open/closed counts (`metrics.ts:263-273`) |
| `offer(s)\|offer acceptance\|offer accept\|offer decline\|accepted offer\|declined offer\|offer letter\|offer rate` (`:678`) | `offer_resolution` over `list_offers` (`:714`) | exposed | on `sent_on` | live-verified 2026-07-02 (`M/mcp-tool-surface-routing.md`) |

`parseQuestionTimeWindow` (`:720-751`) understands `this quarter`, `last quarter`, `this month`, `last month`, `this year`, and `last|past N day|week|month(s)`, and is applied only on the planned-domain path (`:805-836`). The six recipes receive a window only if the caller passes `window_start`/`window_end` (`:87-147`); a recipe question carrying "this month" runs on the recipe's default lookback with no disclosure that the phrase was ignored.

### D.4 Twenty recruiter questions traced

Tags: **today** = the router or the exposed tools answer it now; **after** = answerable after the named change; **not GH** = Greenhouse does not hold the answer. "Composition" means the model chains `search_my_*` reads under the server instructions (`S/server.ts:22-55`), which is legitimate but unrouted.

| # | Question | Path through the router and tools | Tag |
|---|---|---|---|
| 1 | "Who do I need to follow up with today?" | No recipe keyword; no missing-domain phrase; falls to unrecognized `missing_domain` (`:326-374`). Composable from `search_my_applications` (`last_activity_at`), `search_my_scorecards` (`status`), `search_my_interviews` (`starts_at`), `search_my_offers` (`status`), but nothing unifies them | **after**: a "my desk" recipe joining stale actives, owed scorecards, today's interviews, and unresolved offers under owner scope |
| 2 | "Which of my reqs have no activity this week?" | Owner intent resolves (`:1267`). "activity", "week", "no" match nothing (`weekly` needs the literal word). Unrecognized `missing_domain`. The catalog's `silent_reqs_projected_limited` is exactly this and is `planned` (`capabilities.ts:203-228`) | **after**: add `quiet\|silent\|no activity\|inactive` to pipeline_quality's regex and emit a per-job `last_activity_at` max, or ship the silent-reqs executor |
| 3 | "Prep me for the 2pm debrief on Jane." | Individual, so the instructions route to evidence tools. `/v3/candidates` has no name filter (params: `email`, `tag`, `last_activity_at`, `private`, `custom_field_option_id`; `S/harvest-v3-registry.generated.ts` entry for `/v3/candidates`), nor does `/v3/applications`. Given an id or email: `get_my_application`, `search_my_scorecards(application_ids)`, `search_my_scorecard_question_answers`, `search_my_notes`, `search_my_interviews` | **today** with an id or email; **after** a scoped candidate name index for a bare name |
| 4 | "Schedule the onsite for app 123." | No write action exists; `POST /v3/interviews` requires `external_event_id` of an event already on the calendar (`D/0101`) | **not GH** for the scheduling itself; **after** an `interview_record_create` action for recording it once the calendar holds it |
| 5 | "What did the panel say about the last three candidates for req 907?" | `search_my_applications(job_ids=907, created_at)` → `search_my_scorecards(application_ids)` → `search_my_scorecard_question_answers`; rubric question text needs `search_my_scorecard_questions`, which is hidden | **today** by composition; ratings and answers come back as ids where the question dictionary is hidden |
| 6 | "What's our offer acceptance rate last quarter?" | `offer` phrase (`:678`) → planned `offer_resolution`, window `last quarter` on `sent_on` (`:732`, `:714`) | **today**, live-verified |
| 7 | "Where are candidates stuck in my FDE reqs?" | Owner intent; "stuck" → stage_latency (`:105`); resolver may return `needs_confirmation` on the FDE role family (`resolver.ts:429-445`) | **today**; answer is one row per (req, stage) |
| 8 | "Which interviewers are late on feedback?" | "feedback", "late" → interview_feedback_drag; person ids only, names via `get_my_user` | **today** |
| 9 | "How many candidates did we source from LinkedIn this month?" | "source" → source_quality; "this month" is ignored on the recipe path (`:87-147` vs `:805`), so the answer spans 90 days; LinkedIn is six source ids across three categories on this tenant (`M/greenhouse-source-taxonomy.md`) | **today** with the wrong window and six rows; **after**: apply `parseQuestionTimeWindow` to recipe params and add a `source.type.name` grouping |
| 10 | "Why is req 907 taking so long?" | No keyword ("long", "taking" absent; "slow" would have matched). Unrecognized `missing_domain`; the broad panel needs `overall\|full picture\|…` (`:907`) | **after**: treat a "why" question with an exact req id as broad-diagnostic intent |
| 11 | "How many open reqs do I have and how many openings are unfilled?" | "openings" → planned `opening_fill_status` over `list_openings` (`:667`, `:713`); "do I have" is not owner intent (needs `my`/`our`), so it spans permitted jobs | **today**, over permitted rather than owned reqs |
| 12 | "Reject app 456 and send the standard rejection email." | `apply_application_rejection` rejects without email (`A/actions/application-rejection.ts:163-170`); `rejection_email.email_template_id` needs `/v3/email_templates`, unbound | **after**: add an optional `rejection_email` input to the action and bind `email_templates` |
| 13 | "Move Jane to onsite." | `apply_application_stage_move`, high-impact, needs `can_apply_high_impact`; name lookup as in #3; the move fires tenant transition rules including candidate email (`D/0019`) | **today** with an application id and the high-impact grant |
| 14 | "Add a note that I spoke with the candidate." | `apply_candidate_note_create` (`A/actions/candidate-note-create.ts`) | **today** |
| 15 | "Who owns the approval on req 907's offer?" | "approval" → planned `approval_latency` over a hidden read; approver names need `search_my_approvers`, hidden | **after**: expose `search_my_approval_flows`, `search_my_approvers`, `search_my_approver_groups` |
| 16 | "Which of my candidates are tagged Referral?" | "referral" → source_quality, which ranks referrer ids, not tags: a misroute. `search_my_candidates(tag=…)` works if the exact tag name is known; the dictionary (`search_my_candidate_tags`) is hidden and `/v3/applied_candidate_tags` is unbound | **today** by composition with the exact tag name; **after** unhiding the dictionary |
| 17 | "What's the pay range on req 907's posting?" | `search_my_job_posts` carries no pay; `search_my_pay_input_ranges` is hidden | **after**: unhide `search_my_pay_inputs`, `search_my_pay_input_ranges` |
| 18 | "How many people applied to the NY posting last week?" | "posting" → planned `job_post_exposure_by_post`, which counts tracking links, not applicants (`metrics.ts:207-220`): a misroute. Correct path is `search_my_applications(job_post_ids, created_at)`, both exposed params | **today** by composition; the router answers a different question |
| 19 | "Who hasn't submitted their scorecard for yesterday's interviews?" | "submitted", "scorecard" → scorecard_accountability. A one-day `window_start`/`window_end` keys on `interviewed_at` in memory, but the server-side `created_at ≥ window_start` floor (`scorecard-accountability.ts:86`) first drops every scorecard Greenhouse created when the interview was scheduled, which is most of them | **today** only as the default 30-day ranking with no per-day cut; **after** removing the `created_at` floor for an exact day |
| 20 | "What's the time-to-fill on my closed reqs this year?" | Owner intent resolves open assignments; closed reqs trigger confirmation (`resolver.ts:432`). No keyword ("fill", "closed" absent). Unrecognized. The data exists: `/v3/openings` `opened_at`/`closed_at` are exposed params, but `opening_fill_status` computes counts, not durations | **after**: a `time_to_fill_days` metric over `opening_headcount_fact` |

Of the twenty, six are answerable cleanly through the router or the shipped actions today, four more by unrouted composition, two with a wrong or approximate window, seven need a named change, and one (scheduling) is not Greenhouse's to answer. Nothing in the twenty is blocked by an external constraint.

## E. The five highest-value gaps, ranked

1. Route the operating questions. Questions 1, 2, 10 and 20 are the daily ones and all four fall to `missing_domain`. The change is one recipe and three regex edits: a "my desk" recipe over exposed reads (stale actives from `search_my_applications`, owed scorecards from `search_my_scorecards`, today's interviews from `search_my_interviews`, unresolved offers from `search_my_offers`, all under owner scope); `quiet|silent|no activity|inactive` into pipeline_quality; exact-req "why" questions treated as broad-diagnostic intent; and `parseQuestionTimeWindow` applied to recipe params so "this month" stops being ignored. Effort: 3 to 4 days, all in `S/tools/question-answer.ts` and one new recipe file.

2. Flip the read allowlist and bind the four missing readers. Unhiding the 22 (`GREENHOUSE_RECRUITER_ALLOWED_TOOLS`, `deploy/production.env.example:84`) is a config change plus the container self-check and `/readyz` catalog count (`M/greenhouse-write-plane-shipped.md`); binding `job_post_searchable_locations`, `applied_candidate_tags`, `user_roles`, and `email_templates` is four registry pairs plus projection allowlists. It closes questions 5, 15, 16, 17, half of 12, and the location defect the server instructions apologize for. Effort: 2 days. No external constraint is cited anywhere against any of the 22; EEOC and demographics stay unbound.

3. Candidate by name. Three of the twenty questions start from a name and neither `/v3/candidates` nor `/v3/applications` filters on one. The job-scope inventory already solves this shape for reqs (`S/resolvers/job-scope/inventory.ts`); a permission-scoped candidate index keyed on `first_name`/`last_name`/`preferred_name` with the same signed-handle contract is the recruiter-side twin. Effort: 4 to 5 days including the resolver tests.

4. Rejection with email, and the other five lifecycle writes. `rejection_email` is an optional object on an endpoint the action already calls (`D/0020`); adding it as an optional input, high-impact when present, is a one-file change once `email_templates` is bound. The same wave should add `hire`, `convert_to_candidate`, `POST /applications` (second req), `applied_candidate_tags` create/delete, and `PATCH /rejection_details` (fix a reason without re-rejecting), each a thin clone of an existing kind. Effort: 4 days for six kinds.

5. Interview records and the approval chain. `POST/PATCH/DELETE /v3/interviews` cannot schedule (the calendar must hold the event first), but recording, re-panelling, and cancelling a loop the coordinator already booked is a coordinator's daily write, and it is what makes the interview-centred `scorecard_debt` catalog entry buildable. The approval endpoints (`request_approvals` emails approvers; the rest are silent) complete the offer flow the shipped `offer_create` explicitly stops short of. Effort: 5 days; the interview kinds need a fence target for `interview` (`S/action-visibility.ts:45-53` routes five kinds today).

Two things outside the ask belong on the same list. The write plane attributes every mutation to the service account unless two env flags are set (`A/greenhouse.ts:218-227`); whether production sets them is not knowable from source and should be checked before more kinds ship, because a recruiter reading Greenhouse's activity feed will otherwise see "the integration" rejected their candidate. And `assertJobAccess` accepts a proposed assignee for `application_assignment_change` without checking the assignee's own job access (`A/actions/application-assignment.ts:54` versus `job-owner.ts` calling `shared.ts:111-121`), so an application can be assigned to someone who cannot open it.
