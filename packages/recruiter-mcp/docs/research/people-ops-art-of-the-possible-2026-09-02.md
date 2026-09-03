# A People Ops pack for the Greenhouse assistant: what is possible

Date: 2026-09-02. Audience: Sam Vangelos and People Leadership. This brief synthesizes two companion documents in this folder: the external research report (what People teams measure, what the market ships, and the rules for demographic data) and the Harvest v3 capability map (what our server can compute from Greenhouse, endpoint by endpoint). Everything numeric below is traceable to one of those two.

## The short answer

Yes. About two thirds of what People Leadership asks about hiring can be answered today from data the assistant already reads, without new access to Greenhouse. A further group needs one-line changes to expose data the server already fetches. The last group, everything that happens after a person starts, lives in the HR system and needs a small matching table before it can be promised.

Three facts about our own data decide how the pack has to be built, and they matter more than any endpoint gap.

Greenhouse has no field for the date someone was hired. The date on the accepted offer is the hire date, which is what every report the team already publishes uses, and three different counts of "hires" exist on this tenant depending on where you look: accepted offers, applications marked hired, and openings closed with a hire reason. They disagree. Every recipe should print those three counts on one line before it prints anything else.

Offers are stored as versions, not as one record per candidate. Each change to a start date or a compensation field creates a new row and marks the old one superseded. A rate whose denominator is "offers" has to say whether it counts candidates or rows; on the India desk last quarter there were 2.1 offer rows per hire, so the difference is not cosmetic.

Nine in ten hires on this tenant are private candidates. A recruiter without the private-candidate permission sees about one hire in ten, and nothing tells them the other nine exist. The pack has to run for people who hold that permission (Kelsey and Eduardo do) or disclose the exclusion on every hire-based number.

## Where our assistant adds value, and where it now competes

Greenhouse shipped its own assistant connector this summer. It lets any AI tool look up records and, when an admin allows, change them, under each person's own Greenhouse permissions. It does not compute a single metric; Greenhouse's reporting stays in the app, and its warehouse export runs nightly with a one-day lag. Our record lookup and write tools now overlap with Greenhouse's own, which has the vendor's audit log behind it. Our aggregate analysis on live data, scoped to the person asking, is what nobody else provides, and it is where the People Ops work belongs.

The market vocabulary is set by Ashby, whose report catalog publishes the clock and default window for each metric. The pack should do the same in every answer: the start event, the end event, the window, and the denominator, stated in words.

## The pack, in three tiers

### Tier one: buildable now from data the assistant already reads

1. Offer outcomes. Acceptance rate and time to decide, by department, office, source, and hiring manager, over any window. Counted on resolved offers, one per candidate, with rescinded and withdrawn offers separated from candidate declines by their recorded reason. Replaces the assistant's current approximate answer, which counts superseded offer versions.
2. Time to hire and time to fill. Two clocks, both stated: application created to offer accepted (the candidate clock), and opening opened to opening filled on closed openings only (the seat clock). Medians with the middle half, cohorted by the month the application started. Cloned requisitions carry migrated history and reopened jobs carry their closed gap; both are excluded, and the exclusion count is shown.
3. Hires by month with department, office, source type, and recruiter. The existing leadership report's definition, generalized, with the three-count reconciliation line on top.
4. Offer-to-start lag and upcoming starts. From acceptance to the latest offer version's start date, labeled as planned starts, because Greenhouse never learns about no-shows.
5. Open headcount and age of open jobs, by department and office. Counts openings rather than jobs, and treats openings closed without a hire as cancelled.
6. Hiring team load. Open requisitions and active applications per recruiter and per hiring manager, at a point in time, with departed staff excluded.
7. Rejection reasons by stage and department, and decline reasons on offers. Extends the existing rejection-drift recipe.
8. Interview load per interviewer, hours and seats, and feedback timeliness. Extends the existing scorecard recipes; few vendors ship this and Ashby is the only one that names it.

### Tier two: buildable after exposing data the server already fetches

9. Approval cycle time, from request to final approval, by department. The approval endpoints are fetched but hidden, and the hiding cites no constraint.
10. Compensation offered against the posted band. Offer compensation fields already pass through; the pay-band endpoints are hidden without a cited constraint. One measurement is owed first: whether this tenant's base-pay field is flagged private, in which case it stays withheld by the org's own rule.
11. Prospect pipeline and outbound channel attribution.
12. Aggregate demographic funnel by stage. Greenhouse's own app shows this only as totals to a Site Admin with a specific permission, and its API returns the answers per person. The pack must aggregate, suppress any cell under five people, suppress the complement so two answers cannot be subtracted, disclose the response rate on every figure, and never run on a pool the asking person is currently deciding on. Offered as an explicit mode, gated on the same permission the app uses.

### Tier three: needs the HR system

13. Retention at ninety days and one year, by source, department, and recruiter.
14. Actual start dates and no-shows.
15. Offer against compensation band, where the band lives in the HR system.
16. Headcount plan against fill.

All four wait on one thing: a table that links each Greenhouse hire to its HR-system employee record. No Greenhouse integration carries that link across; the join is email plus start date with manual fallbacks, the same class of problem the recruiter identity directory already solves. The HR system's API side is straightforward once that table exists.

## Two prerequisites before any recipe ships

The first is the scope fix already on the books. Today a company-wide question from a site admin gets a "confirm which jobs" prompt instead of an answer. People Leadership's questions are company-wide by nature, so this ships first.

The second is the reconciliation line. Because the same data yields four hire counts depending on who asks and how, the pack's first recipe should emit the counts for the window on one line, and every later recipe should inherit it. That single habit is what makes the numbers defensible in a leadership meeting.

## What the assistant should never do

The demographic rules are the only hard legal line, and they are consistent across the US, the UK, and the EU: individual answers never reach anyone in the hiring chain, aggregates carry a minimum cell size, and demographic cuts never inform a live decision about a named person. Beyond that, the pack labels every approximation as one, and it does not report compensation or private notes to anyone whose Greenhouse role cannot see them.

## Effort and order

Each tier-one recipe is one to two days including tests, the first one longest because it carries the reconciliation line and the offer de-versioning that the others reuse. The tier-two unhides are hours each. The demographic mode is a week, mostly governance and tests. The HR-system join table is its own project of roughly a week, after which each tier-three metric is a day.

Recommended order: the scope fix, then offer outcomes and time to hire (the two questions People Leadership asks most, and the two the audit found the assistant promising and not delivering), then hires by month, upcoming starts, and headcount. Interviewer load and approval cycle time follow as the differentiators.

## Decisions for Sam

- Confirm the starting pair: offer outcomes, then time to hire and fill.
- Whether the People Ops pack should run only for users holding the private-candidate permission, or for everyone with the exclusion disclosed.
- Whether to build the demographic mode at all in this pass, or defer it until a People Leadership request names the report.
- Whether to start the HR-system join table now, alongside tier one, or after tier one lands.
