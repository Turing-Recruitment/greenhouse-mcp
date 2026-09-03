# The recruiter side of the Greenhouse assistant: what is possible

Date: 2026-09-02. Audience: Sam Vangelos and the recruiting team's leads. Companion to the People Ops brief of the same date. This synthesizes two documents in this folder: the recruiter-side external research (what recruiters ask, what the market ships, how writes are governed) and the recruiter-side capability map (our six analyses, our withheld tools, our write surface against the full API, and twenty recruiter questions traced through the router).

## The short answer

The recruiter side is the reverse of People Ops. Recruiters gain almost nothing from new analysis and a great deal from four other things: answering the questions they ask every day, which the assistant today refuses; exposing twenty-two read tools the server already fetches and hides for no stated reason; letting them find a candidate by name; and finishing the write plane, which is well-gated but thin and, as deployed, records every change under the integration's name rather than the recruiter's.

Three facts from the research set the direction.

Recruiters lose their week to scheduling and status-chasing, not to analysis. The one time study that could be read puts interview coordination at 28 percent of the week, tracking-system data entry at 14 percent, and follow-up email at 10 percent, with recruiting itself under a third. The vendors' marketing prompts sell pre-debrief packets and compensation checks; their coordinator pages, where the Tuesday questions live, ask who owes a scorecard, which interviews have a silent interviewer, and what is stuck past its goal.

Of twenty realistic recruiter questions traced through our assistant, six are answered cleanly today, four are answerable by composing existing tools, two are answered with the wrong time window, seven need a named change, and one is not Greenhouse's to answer. The four daily-desk questions are among the seven refused.

Every write the market allows is small and internal, and the boundary is candidate-facing side effects. Greenhouse's own connector confirms five actions and blocks every delete; Ashby's ships four writes and none that emails, schedules, rejects, or touches offers. Our plane ships eleven kinds, more than either, and gates the right one hardest: Greenhouse's API reference confirms that a stage move through the API fires the same automated emails and links the app would send, and our stage move is already marked high-impact for exactly that reason.

## What to build, in order

### 1. Answer the daily-desk questions

One new analysis, "my desk," over reads the assistant already has: my candidates sitting past their stage goal, the scorecards I am owed, my interviews today and this week with any interviewer who has not responded, my unresolved offers. Plus three routing edits so "quiet reqs," "why is req 907 slow," and "this month" stop falling through. These are counts and aging, computed deterministically with the assistant narrating, which is also what Ashby tells its own users to insist on. Three to four days.

### 2. Expose the hidden reads

Twenty-two tools are built, tested, and hidden by a list that cites no reason; the history shows they were built with a note that none carry personal data and withdrawn in a hardening commit with no explanation. A recruiter can edit a job note but cannot list one, cannot see the approval chain holding an offer, cannot see interview kits or job-post locations. Flipping the list and binding four small readers, including one for locations that the assistant's own instructions currently apologize for lacking, closes six of the twenty questions. Two days. Demographic data stays out.

### 3. Find a candidate by name

Three of the twenty questions start from a person's name, and no Greenhouse endpoint filters on one. The requisition resolver already solves this shape for jobs; a permission-scoped candidate index keyed on names, with the same signed-scope contract, is its twin. This is also what makes "where is Jane Doe in process," restored to the data this morning, actually askable. Four to five days.

### 4. Finish the writes, honestly

Two findings need fixing before more kinds ship. As deployed, every write runs under the service account: the attribution mode defaults to the integration user and production does not set the per-recruiter mode, so a recruiter reading the Greenhouse activity feed sees "the integration" rejected their candidate. And the assignment action does not check that the proposed assignee can open the application.

Then six thin additions: rejection with the optional rejection email (high-impact when present, defaulting to none, with a delayed send that leaves a cancellation window), mark hired, convert a prospect, add to a second requisition, add or remove a tag, and correct a rejection reason without re-rejecting. Four days for six kinds. After that, recording and re-panelling interviews the coordinator already booked, and the approval chain that completes an offer. Five days.

The stage move should be applied once on a sandbox candidate marked Do Not Email, in a stage that carries a rule, before it is used in production; it has been previewed but never applied against the real tenant, and two details of the call are unverified.

### 5. Rename the six analyses to the market's words

Stage latency keeps its name and gains a median and a per-stage goal. Scorecard accountability becomes feedback completion. Interview feedback drag becomes feedback turnaround, in hours, with a warning tier and a missed tier. Pipeline quality keeps its status mix and pass-through and drops the stale-by-last-activity measure that matches no vendor's definition. Source quality becomes source of hire, anchored on the hire date. Rejection reason drift becomes rejection reasons, with drift as an explicit this-window-versus-last comparison. One of the six also ignores its own time window today, and two disagree with each other about theirs; those are bugs to fix in the same pass.

## What not to build

Autonomous scheduling and autonomous outreach, which is where every published incident lives, including two cases of an outreach bot obeying instructions hidden in a candidate's profile. Pre-debrief packets and compensation checks as dedicated recipes, because the reads they need already exist and the assistant can compose them. Auto-closing requisitions, which no vendor does; the assistant reminds, proposes, and drafts, and a person applies.

## Rules the write plane keeps

Reads run silently; writes preview and stop; the confirmation is a separate step bound to the exact arguments; a batch is previewed one candidate at a time and capped; rejections default to no email; nothing deletes; and every change carries the recruiter's name and the assistant's mark, because Greenhouse's own change log shows connector writes under the person's name with no indicator.

## Decisions for Sam

- Start with the daily-desk analysis and the hidden-tools flip together, since they share a week?
- Turn on per-recruiter attribution for writes, which needs a token probe to pass first, before shipping any new write kinds?
- Add rejection email as an option at all, or keep the assistant's rejections silent and leave the email to the app?
- Run the sandbox stage-move test now, or leave the stage move preview-only until it is needed?
