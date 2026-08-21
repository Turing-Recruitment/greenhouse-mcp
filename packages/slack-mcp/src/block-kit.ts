interface SlackBlock {
  type: string
  [key: string]: unknown
}

interface SnapshotPanel {
  id?: string
  label: string
  value: string
  detail?: string
  comparison?: string
}

interface Finding {
  id?: string
  title: string
  summary: string
}

interface ActionItem {
  id?: string
  summary: string
}

interface CoverageNote {
  detail: string
}

interface SlackBrief {
  headline?: string
  intro_label?: string
  summary?: string
  finding_label?: string
  action_label?: string
  finding_ids?: string[]
  action_ids?: string[]
  visual_ids?: string[]
  cta_label?: string
  cta_route?: string
}

interface RecruiterDigestData {
  date: string
  recruiterName: string
  recruiterSlug: string
  portfolioRoleCount?: number
  ownedCandidateCount?: number
  ownedStaleCandidates?: number
  overdueScorecardsCount: number
  topActions: Array<{ priority: number; summary: string }>
  portfolioActions?: Array<{ summary: string }>
  brightSpot?: string
  stages: Array<{ name: string; count: number }>
  trend: number[]
  allowLive?: boolean
  snapshotPanels?: SnapshotPanel[]
  findings?: Finding[]
  actions?: ActionItem[]
  coverageNotes?: CoverageNote[]
  slackBrief?: SlackBrief | null
}

interface CoordinatorDigestData {
  date: string
  availabilityPending: number
  toBeScheduled: number
  watchlist: Array<{
    candidateName: string
    roleName: string
    hoursSinceRequest: number
  }>
  allowLive?: boolean
  snapshotPanels?: SnapshotPanel[]
  findings?: Finding[]
  actions?: ActionItem[]
  coverageNotes?: CoverageNote[]
  slackBrief?: SlackBrief | null
}

interface ObserverDigestData {
  date: string
  title: string
  persona: "recruitment_manager" | "head_of_ta"
  summaryCards?: Array<{ label: string; value: string }>
  topRoleAdditions?: Array<{
    roleName: string
    current: number
    delta: number
  }>
  followUpByRole?: Array<{
    roleName: string
    current: number
    delta: number
  }>
  allowLive?: boolean
  blockingReasons?: string[]
  reportVariant?: "daily_exception_pulse" | "weekly_executive_review" | "weekly_operating_review"
  snapshotPanels?: SnapshotPanel[]
  findings?: Finding[]
  actions?: ActionItem[]
  coverageNotes?: CoverageNote[]
  slackBrief?: SlackBrief | null
  /** Recruitment-manager scheduling-friction digest (deterministic); optional for HoTA */
  schedulingFrictionMarkdown?: string | null
}

interface DigestRenderOptions {
  dashboardUrl: string
  assetUrls?: {
    funnel?: string | null
    trend?: string | null
    backlog?: string | null
    additions?: string | null
    followUp?: string | null
  }
}

function formatNumber(value: string | number | null | undefined): string {
  return new Intl.NumberFormat("en-US").format(Number(value || 0))
}

function formatDelta(delta: number | null | undefined): string {
  const numeric = Number(delta || 0)
  if (numeric > 0) {
    return `up ${formatNumber(numeric)} vs last week`
  }
  if (numeric < 0) {
    return `down ${formatNumber(Math.abs(numeric))} vs last week`
  }
  return "flat vs last week"
}

function sentence(text: string | null | undefined): string | null {
  const value = String(text || "").trim()
  if (!value) return null
  return /[.!?]$/.test(value) ? value : `${value}.`
}

function polishCoverageNote(note: string | null | undefined): string | null {
  const value = String(note || "").trim()
  if (!value) return null
  if (value.includes("Slack email lookup scope")) {
    return "Direct live delivery still requires a confirmed Slack recipient mapping."
  }
  if (value.includes("missing a coordinator assignment")) {
    return "Some open scheduling items are not yet tied to a coordinator owner and are excluded from live delivery."
  }
  if (value.includes("Backfilled role-level recruiter attribution")) {
    return "Some role ownership assignments remain under validation and are excluded from personalized reporting."
  }
  if (value.includes("Stage transition history")) {
    return "Stage-to-stage movement is still being validated and is intentionally excluded from this report."
  }
  if (value.includes("Weekly observer metrics stay deterministic")) {
    return "Narrative overlays remain in review and are intentionally excluded from live reporting."
  }
  if (value.includes("Weekly conversion rates require")) {
    return "Conversion-rate views remain in validation and are intentionally excluded from this report."
  }
  if (value.includes("Scorecard quality scoring")) {
    return "Scorecard quality scoring remains experimental and is excluded from live reporting."
  }
  if (value.includes("Alignment analysis")) {
    return "Alignment analysis remains in validation and is excluded from live reporting."
  }
  if (value.includes("Generative talent rediscovery suggestions")) {
    return "Talent rediscovery suggestions remain experimental and are excluded from live reporting."
  }
  return value
}

function blockFieldsFromPanels(snapshotPanels: SnapshotPanel[] = []): SlackBlock[] {
  return snapshotPanels.slice(0, 4).map((panel) => ({
    type: "mrkdwn",
    text: `*${panel.label}*\n${panel.value}`,
  }))
}

function firstCoverageNote(data: { coverageNotes?: CoverageNote[] }): string | null {
  return (data.coverageNotes || []).map((note) => note.detail).find(Boolean) || null
}

function renderBullets<T>(
  label: string,
  items: T[],
  mapper: (item: T, index: number) => string,
  limit = 3,
): SlackBlock | null {
  const lines = items.slice(0, limit).map(mapper).filter(Boolean)
  if (lines.length === 0) return null
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${label}*\n${lines.join("\n")}`,
    },
  }
}

function selectItemsByIds<T extends { id?: string }>(
  items: T[] = [],
  ids: string[] | undefined,
  fallbackLimit = 3,
): T[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    return items.slice(0, fallbackLimit)
  }

  const index = new Map(items.map((item) => [item.id, item]))
  return ids.map((id) => index.get(id)).filter(Boolean) as T[]
}

function buildObserverNarrative(data: ObserverDigestData): string {
  if ((data.findings || []).length > 0) {
    return (data.findings || [])
      .slice(0, 2)
      .map((finding) => finding.summary)
      .join(" ")
  }

  const snapshotPanels = data.snapshotPanels || []
  const actions = data.actions || []
  const narrative = [
    sentence(snapshotPanels[0]?.detail),
    sentence((snapshotPanels[0] as { comparison?: string } | undefined)?.comparison),
    sentence(snapshotPanels[1]?.detail),
    actions[0]?.summary ? sentence(`Next move: ${actions[0].summary}`) : null,
  ].filter(Boolean) as string[]

  if (narrative.length > 0) {
    return narrative.slice(0, 3).join(" ")
  }

  return "Reviewed operating evidence is ready for drilldown."
}

export function buildRecruiterDigestBlocks(
  data: RecruiterDigestData,
  { dashboardUrl, assetUrls = {} }: DigestRenderOptions,
): SlackBlock[] {
  const blocks: SlackBlock[] = []
  const slackBrief = data.slackBrief || null
  const snapshotPanels = (data.snapshotPanels || []).slice(0, 4)
  const actionSource =
    data.actions && data.actions.length > 0
      ? data.actions
      : (data.topActions || []).map((action, index) => ({
          id: `recruiter-top-action-${index + 1}`,
          title: `Priority ${index + 1}`,
          summary: action.summary,
          priority: action.priority,
        }))
  const actions = selectItemsByIds(
    actionSource,
    slackBrief?.action_ids,
    5,
  ).slice(0, 5)
  const findings = selectItemsByIds(data.findings || [], slackBrief?.finding_ids, 3).slice(
    0,
    3,
  )
  const coverageNote = firstCoverageNote(data)

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `Recruiter Daily — ${data.recruiterName} — ${data.date}`,
    },
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${slackBrief?.headline || "Today’s Top 5"} · operator-reviewed daily recruiting guidance`,
      },
    ],
  })
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${slackBrief?.intro_label || "Snapshot"}*\n${slackBrief?.summary || `${snapshotPanels[0]?.detail || `${formatNumber(data.ownedCandidateCount)} owned candidates are currently in motion.`} ${snapshotPanels[1]?.detail || `${formatNumber(data.ownedStaleCandidates)} are out of SLA.`}`}`,
    },
  })

  if (snapshotPanels.length > 0) {
    blocks.push({
      type: "section",
      fields: blockFieldsFromPanels(snapshotPanels),
    })
  }

  const actionBlock = renderBullets(
    slackBrief?.action_label || "Today’s Top 5",
    actions,
    (action, index) => `*${index + 1}.* ${(action as ActionItem).summary}`,
    5,
  )
  if (actionBlock) blocks.push(actionBlock)

  const findingsBlock = renderBullets(
    slackBrief?.finding_label || "Why These Matter Today",
    findings,
    (finding) => `• *${(finding as Finding).title}* — ${(finding as Finding).summary}`,
    3,
  )
  if (findingsBlock) blocks.push(findingsBlock)

  if (coverageNote && data.allowLive === false) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Coverage Note*\n${polishCoverageNote(coverageNote) || coverageNote}`,
      },
    })
  }

  const funnelImageUrl =
    assetUrls.funnel ||
    (data.stages.length > 0
      ? `${dashboardUrl}/api/chart/funnel?data=${encodeURIComponent(JSON.stringify(data.stages))}`
      : null)
  if (funnelImageUrl) {
    blocks.push({
      type: "image",
      image_url: funnelImageUrl,
      alt_text: "Recruiter funnel snapshot",
    })
  }

  const trendImageUrl =
    assetUrls.trend ||
    (data.trend.length > 1
      ? `${dashboardUrl}/api/chart/sparkline?data=${encodeURIComponent(JSON.stringify(data.trend))}`
      : null)
  if (trendImageUrl) {
    blocks.push({
      type: "image",
      image_url: trendImageUrl,
      alt_text: "Recruiter owned-candidate trend",
    })
  }

  if ((data.portfolioActions || []).length > 0) {
    const portfolioBlock = renderBullets(
      "Portfolio Context",
      data.portfolioActions || [],
      (action) => `• ${action.summary}`,
      2,
    )
    if (portfolioBlock) blocks.push(portfolioBlock)
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: slackBrief?.cta_label || "Open Recruiter Dashboard",
        },
        url: `${dashboardUrl}${slackBrief?.cta_route || `/recruiter/${data.recruiterSlug}`}`,
      },
    ],
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Magellan · Recruiter Daily · ${formatNumber(data.portfolioRoleCount)} portfolio roles · ${data.date}`,
      },
    ],
  })

  return blocks
}

export function buildCoordinatorDigestBlocks(
  data: CoordinatorDigestData,
  { dashboardUrl, assetUrls = {} }: DigestRenderOptions,
): SlackBlock[] {
  const blocks: SlackBlock[] = []
  const slackBrief = data.slackBrief || null
  const snapshotPanels = (data.snapshotPanels || []).slice(0, 3)
  const actions = selectItemsByIds(data.actions || [], slackBrief?.action_ids, 5).slice(
    0,
    5,
  )
  const findings = selectItemsByIds(data.findings || [], slackBrief?.finding_ids, 1).slice(
    0,
    1,
  )
  const coverageNote = firstCoverageNote(data)

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Coordinator Daily — ${data.date}` },
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${slackBrief?.headline || "Top 5 Queue Items"} · operator-reviewed scheduling operations`,
      },
    ],
  })
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${slackBrief?.intro_label || "Queue Snapshot"}*\n${slackBrief?.summary || findings[0]?.summary || `${formatNumber(data.availabilityPending)} availability requests are older than 24 hours and ${formatNumber(data.toBeScheduled)} interviews remain to be scheduled.`}`,
    },
  })

  if (snapshotPanels.length > 0) {
    blocks.push({
      type: "section",
      fields: blockFieldsFromPanels(snapshotPanels),
    })
  }

  const actionBlock = renderBullets(
    slackBrief?.action_label || "Top 5 Queue Items",
    actions,
    (action, index) => `*${index + 1}.* ${(action as ActionItem).summary}`,
    5,
  )
  if (actionBlock) blocks.push(actionBlock)

  if (coverageNote && data.allowLive === false) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Coverage Note*\n${polishCoverageNote(coverageNote) || coverageNote}`,
      },
    })
  }

  const backlogBars = data.watchlist.map((item) => ({
    name: item.candidateName.split(" ")[0],
    count: item.hoursSinceRequest,
  }))
  const backlogImageUrl =
    assetUrls.backlog ||
    (backlogBars.length > 0
      ? `${dashboardUrl}/api/chart/bar?data=${encodeURIComponent(JSON.stringify(backlogBars))}`
      : null)
  if (backlogImageUrl) {
    blocks.push({
      type: "image",
      image_url: backlogImageUrl,
      alt_text: "Coordinator queue backlog",
    })
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: slackBrief?.cta_label || "Open Coordinator Dashboard",
        },
        url: `${dashboardUrl}${slackBrief?.cta_route || "/coordinator"}`,
      },
    ],
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Magellan · Coordinator Daily · ${data.date}`,
      },
    ],
  })

  return blocks
}

export function buildObserverDigestBlocks(
  data: ObserverDigestData,
  { dashboardUrl, assetUrls = {} }: DigestRenderOptions,
): SlackBlock[] {
  const blocks: SlackBlock[] = []
  const slackBrief = data.slackBrief || null
  const snapshotPanels = data.snapshotPanels || []
  const findings = selectItemsByIds(
    data.findings || [],
    slackBrief?.finding_ids,
    data.reportVariant === "daily_exception_pulse" ? 3 : 4,
  )
  const actions = selectItemsByIds(
    data.actions || [],
    slackBrief?.action_ids,
    data.reportVariant === "daily_exception_pulse" ? 1 : 3,
  )
  const coverageNote = firstCoverageNote(data)
  const introLabel =
    slackBrief?.intro_label ||
    (data.reportVariant === "daily_exception_pulse"
      ? "Today’s Exception Pulse"
      : "This Week’s Story")
  const findingsLabel =
    slackBrief?.finding_label ||
    (data.reportVariant === "daily_exception_pulse" ? "Top Risks" : "What Matters")
  const actionsLabel =
    slackBrief?.action_label ||
    (data.reportVariant === "daily_exception_pulse"
      ? "Leadership Ask"
      : "Recommended Action")

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `${data.title} — ${data.date}` },
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          data.reportVariant === "daily_exception_pulse"
            ? "Operator-reviewed daily leadership exception pulse"
            : "Operator-reviewed weekly recruiting operating review",
      },
    ],
  })
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${introLabel}*\n${slackBrief?.summary || findings[0]?.summary || buildObserverNarrative(data)}`,
    },
  })

  if (snapshotPanels.length > 0) {
    blocks.push({
      type: "section",
      fields: blockFieldsFromPanels(snapshotPanels),
    })
  }

  const schedulingMd = data.schedulingFrictionMarkdown
  if (schedulingMd && String(schedulingMd).trim()) {
    const maxLen = 2800
    const text =
      schedulingMd.length > maxLen
        ? `${schedulingMd.slice(0, maxLen - 24)}…\n_Omitted remainder (Slack limit)._`
        : schedulingMd
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    })
  }

  const findingsBlock = renderBullets(
    findingsLabel,
    findings,
    (finding) => `• *${(finding as Finding).title}* — ${(finding as Finding).summary}`,
    data.reportVariant === "daily_exception_pulse" ? 3 : 4,
  )
  if (findingsBlock) blocks.push(findingsBlock)

  const actionsBlock = renderBullets(
    actionsLabel,
    actions,
    (action, index) => `*${index + 1}.* ${(action as ActionItem).summary}`,
    data.reportVariant === "daily_exception_pulse" ? 1 : 3,
  )
  if (actionsBlock) blocks.push(actionsBlock)

  if (coverageNote) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Coverage Note*\n${polishCoverageNote(coverageNote) || coverageNote}`,
      },
    })
  }

  if (data.allowLive === false && data.blockingReasons?.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Preview mode: only deterministic, reviewed metrics are shown below.",
        },
      ],
    })
  }

  if (assetUrls.additions) {
    blocks.push({
      type: "image",
      image_url: assetUrls.additions,
      alt_text: "Weekly candidate additions",
    })
  }
  if (assetUrls.followUp) {
    blocks.push({
      type: "image",
      image_url: assetUrls.followUp,
      alt_text: "Post-interview follow-up concentration",
    })
  }

  const route =
    data.persona === "head_of_ta" ? "/head-of-ta" : "/recruitment-manager"
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text:
            slackBrief?.cta_label ||
            (data.persona === "head_of_ta"
              ? "Open Head of TA Dashboard"
              : "Open Manager Dashboard"),
        },
        url: `${dashboardUrl}${slackBrief?.cta_route || route}`,
      },
    ],
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          data.reportVariant === "daily_exception_pulse"
            ? `Magellan · Head of TA Daily Exception Pulse · ${data.date}`
            : `Magellan · ${data.title} · Week ending ${data.date}`,
      },
    ],
  })

  return blocks
}

export function buildRecruitmentManagerDigestBlocks(
  data: ObserverDigestData,
  options: DigestRenderOptions,
): SlackBlock[] {
  return buildObserverDigestBlocks(data, options)
}

export function buildHeadOfTADigestBlocks(
  data: ObserverDigestData,
  options: DigestRenderOptions,
): SlackBlock[] {
  return buildObserverDigestBlocks(data, options)
}
