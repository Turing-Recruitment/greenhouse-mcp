import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ACTION_DEFINITIONS } from "../../action-mcp/dist/index.js";
import { createActionToolGrant } from "../src/action-tools.js";
import { createRecruiterMcpServer, createRecruiterRuntimeForServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { EVIDENCE_TOOL_DEFINITIONS, evidenceToolParamsSchema, runEvidenceTool } from "../src/tools/evidence.js";
import { RECRUITER_TOOL_DEFINITIONS, registerRecruiterTools } from "../src/tools/register.js";
import { PLANNER_RECIPE_IDS, runRecruitingQuestionAnswer } from "../src/tools/question-answer.js";
import { runGetRecruitingCapabilities } from "../src/tools/job-scope/tools.js";
import { getRecruitingCapabilities } from "../src/resolvers/job-scope/capabilities.js";
import { generateDesktopConfig } from "../src/desktop-config.js";
import { fakeScopedReader, scopedSuccess, testRuntime } from "./test-helpers.js";
import type { ActionPlaneMount } from "../src/action-plane.js";
import type { AuthenticatedSession } from "../src/types.js";

/**
 * Lane D / P5 — the model-facing text says what the code does.
 *
 * Every assertion here is against a string the MODEL reads (a registered tool description, a
 * capabilities field, the server instructions, the desktop copy), checked against what the projector
 * and the registrar actually do.
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  GREENHOUSE_RECRUITER_ALLOWED_TOOLS: RECRUITER_TOOL_DEFINITIONS.map((tool) => tool.name).join(","),
  GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true",
};

function session(): AuthenticatedSession {
  return { subject: "google-subject-sam", surface: "test", client: "claude_desktop_chat", tokenId: "recruiter-token-abc123" };
}

function grantMount(names: string[]): ActionPlaneMount {
  return {
    grantedTools: createActionToolGrant(names),
    buildService: () => ({ preview: async () => ({}), apply: async () => ({}) }) as never,
  };
}

function noReadScopedReader() {
  return { async scopedRead() { throw new Error("no scoped read in a catalog test"); } };
}

function capabilitiesRuntime(actionPlane?: ActionPlaneMount) {
  // The same runtime assembly the live server uses, including the allowlist and the granted-tool
  // wiring — which is exactly what the capabilities tool reads.
  return createRecruiterRuntimeForServer({
    session: session(),
    env: BASE_ENV,
    configureGreenhouse: false,
    scopedReader: noReadScopedReader() as never,
    ...(actionPlane ? { actionPlane } : {}),
  });
}

describe("lane D P5 — capabilities tells the truth about the write plane", () => {
  it("D5 keeps the read-only sentence for a no-argument call and for a session with no grant", async () => {
    const noArgument = getRecruitingCapabilities();
    assert.equal(noArgument.read_only, true, "a no-argument call must never fail open into claiming writes");
    assert.ok(
      noArgument.excluded.some((line) => /No write\/admin tools/.test(line)),
      "the read-only session's excluded list keeps the write sentence"
    );

    const withVisibleTools = getRecruitingCapabilities(new Set(["search_my_jobs"]));
    assert.equal(withVisibleTools.read_only, true);
    assert.ok(withVisibleTools.excluded.some((line) => /No write\/admin tools/.test(line)));
  });

  it("D5 names the granted write actions instead of denying they exist", async () => {
    const granted = getRecruitingCapabilities(
      new Set(["search_my_jobs"]),
      new Set(["apply_candidate_note_create"])
    );
    assert.equal(granted.read_only, false, "a session that can write is not a read-only surface");
    assert.equal(
      granted.excluded.some((line) => /No write\/admin tools/.test(line)),
      false,
      "the write sentence is false for an entitled session and must be replaced, not kept"
    );
    const writeLine = granted.excluded.find((line) => /Write actions are available to this session/.test(line));
    assert.ok(writeLine, "an entitled session must be told which write actions it holds");
    assert.match(writeLine!, /apply_candidate_note_create/);
    assert.ok(granted.model_visible_tools?.includes("apply_candidate_note_create"));
    assert.ok(granted.model_visible_tools?.includes("search_my_jobs"));
  });

  it("D5 reaches the same answer through the registered tool on an entitled runtime", async () => {
    const entitled = grantMount(["preview_candidate_note_create", "apply_candidate_note_create"]);
    const result = await runGetRecruitingCapabilities(capabilitiesRuntime(entitled), {});
    assert.equal(result.ok, true);
    const caps = result.ok ? (result.data as any) : null;
    assert.equal(caps.read_only, false);
    const writeLine = caps.excluded.find((line: string) => /Write actions are available to this session/.test(line));
    assert.ok(writeLine, "the entitled session's capabilities must name its write plane");
    assert.match(writeLine, /1 preview\/apply pair/);
    assert.match(writeLine, /preview_candidate_note_create/);
    assert.match(writeLine, /apply_candidate_note_create/);

    const readOnly = await runGetRecruitingCapabilities(capabilitiesRuntime(), {});
    const readOnlyCaps = readOnly.ok ? (readOnly.data as any) : null;
    assert.equal(readOnlyCaps.read_only, true);
    assert.ok(readOnlyCaps.excluded.some((line: string) => /No write\/admin tools/.test(line)));
  });

  it("D5 no longer claims offer compensation, candidate contact, private scorecards or id-only candidate reads are unavailable", () => {
    const serialized = JSON.stringify(getRecruitingCapabilities());
    assert.doesNotMatch(serialized, /Offer\/compensation signals remain unavailable on the recruiter surface/);
    assert.doesNotMatch(serialized, /No offer compensation, candidate contact, private notes, or admin\/write endpoints are exposed/);
    assert.doesNotMatch(serialized, /Private scorecards and private notes remain unavailable/);
    assert.doesNotMatch(serialized, /Candidate reads are projected to ids and scoped application references only/);
    assert.doesNotMatch(serialized, /Candidate contact, raw profiles, private notes, and write disposition tools remain unavailable/);
    // The stalled/strong recipe REQUIRES search_my_candidates, which returns contact fields.
    const stalled = getRecruitingCapabilities().recipes.find((r) => r.id === "stalled_and_strong_projected_limited");
    assert.ok(stalled);
    assert.ok(stalled.required_tools.includes("search_my_candidates"));
    assert.equal(
      stalled.safety_notes.some((note) => /does not read candidate contact/.test(note)),
      false,
      "a recipe whose required_tools include search_my_candidates cannot claim it reads no candidate contact"
    );
  });
});

describe("lane D P5 — evidence descriptions match the projector", () => {
  function description(name: string): string {
    return EVIDENCE_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.description ?? "";
  }

  it("D6 says colleague emails reach site admins and operators, and the projector agrees", async () => {
    for (const name of ["search_my_users", "get_my_user"]) {
      assert.doesNotMatch(description(name), /excludes email\/contact fields/, `${name} description is false for an operator`);
      assert.match(description(name), /email addresses are returned to site admins and operators only/i, name);
    }
    const userRow = { id: 900, name: "Ops Admin", primary_email: "admin@example.com" };
    const operatorReader = fakeScopedReader((toolName) =>
      scopedSuccess(toolName, [userRow], null, { permissionScope: { kind: "operator", permittedJobCount: null } })
    );
    const result = await runEvidenceTool(testRuntime(operatorReader).runtime, "search_my_users", {});
    assert.equal(result.ok, true);
    assert.equal((result.ok ? (result.data as any[])[0] : {}).primary_email, "admin@example.com");
  });

  it("D6 says the referrer user_id passes, and the projector agrees", async () => {
    assert.doesNotMatch(description("search_my_referrers"), /the linking user_id is excluded/);
    assert.match(description("search_my_referrers"), /user_id/);
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [{ id: 4, name: "Ada", user_id: 77 }]));
    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_referrers", {});
    assert.equal(result.ok, true);
    assert.equal((result.ok ? (result.data as any[])[0] : {}).user_id, 77);
  });

  it("D6 says offer compensation custom fields pass unless flagged private, and the projector agrees", async () => {
    assert.doesNotMatch(description("search_my_offers"), /compensation and custom fields are not exposed on the default profile/);
    assert.match(description("search_my_offers"), /custom fields/i);
    assert.match(description("search_my_offers"), /private/i);
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_custom_fields") return scopedSuccess(toolName, []);
      return scopedSuccess(toolName, [{ id: 3, job_id: 100, status: "sent", custom_fields: { base_salary: "200000" } }]);
    });
    const result = await runEvidenceTool(testRuntime(reader).runtime, "search_my_offers", {});
    assert.equal(result.ok, true);
    assert.deepStrictEqual((result.ok ? (result.data as any[])[0] : {}).custom_fields, { base_salary: "200000" });
  });
});

describe("lane D P5 — the recipes parameter is generated from what the planner can run", () => {
  function registeredSchemas() {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const schemas = new Map<string, Record<string, any>>();
    registerRecruiterTools(
      { tool(name: string, _d: string, paramsSchema: Record<string, any>) { schemas.set(name, paramsSchema); } } as any,
      runtime
    );
    return schemas;
  }

  it("D7 advertises every executable recipe id", () => {
    const description = registeredSchemas().get("answer_my_recruiting_question")?.recipes?.description ?? "";
    assert.ok(PLANNER_RECIPE_IDS.length > 0);
    for (const id of PLANNER_RECIPE_IDS) {
      assert.ok(description.includes(id), `recipes description omits the executable recipe "${id}"`);
    }
  });

  it("D7 round-trips every advertised id through the planner's alias parser", async () => {
    for (const id of PLANNER_RECIPE_IDS) {
      const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
      const { runtime } = testRuntime(reader);
      const result = await runRecruitingQuestionAnswer(runtime, {
        question: "How is the pipeline doing?",
        recipes: id,
      });
      assert.equal(result.ok, true, `${id} failed to run`);
      const data = result.ok ? (result.data as any) : null;
      assert.deepStrictEqual(
        data.summary.selected_recipes,
        [id],
        `the advertised id "${id}" must select that recipe, not be silently dropped`
      );
    }
  });
});

describe("lane D P5 — cursor stays, and says what it is for", () => {
  it("D8 keeps cursor on every search schema with a resume-a-truncated-read description", () => {
    let checked = 0;
    for (const definition of EVIDENCE_TOOL_DEFINITIONS) {
      if (!definition.name.startsWith("search_")) continue;
      const schema = evidenceToolParamsSchema(definition.name);
      if (!("cursor" in schema)) continue;
      checked += 1;
      const described = (schema.cursor as any)?.description ?? "";
      assert.match(described, /read\.next_cursor/, `${definition.name} cursor description must name read.next_cursor`);
      assert.doesNotMatch(described, /Cursor returned from a prior paginated response\./, definition.name);
    }
    assert.ok(checked > 0, "expected at least one search schema to carry cursor");
  });

  it("D8 stops telling the model there is no cursor to follow", () => {
    assert.doesNotMatch(SERVER_INSTRUCTIONS, /there is no cursor to follow(?!\s+on a complete read)/);
    assert.match(SERVER_INSTRUCTIONS, /read\.next_cursor/);
  });
});

describe("lane D P5 — every registered tool carries a title", () => {
  async function listedTools(actionPlane?: ActionPlaneMount) {
    const { server } = createRecruiterMcpServer({
      session: session(),
      env: BASE_ENV,
      configureGreenhouse: false,
      scopedReader: noReadScopedReader() as never,
      ...(actionPlane ? { actionPlane } : {}),
    });
    const client = new Client({ name: "lane-d-title-check", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return (await client.listTools()).tools;
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  it("D9 lists a non-empty annotations.title for every tool, through a real client", async () => {
    const tools = await listedTools();
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      const title = (tool.annotations as { title?: unknown } | undefined)?.title;
      assert.equal(typeof title, "string", `${tool.name} has no annotations.title`);
      assert.ok(String(title).length > 0, `${tool.name} has an empty annotations.title`);
      // The safety triple the container self-check and distribution validation read must survive.
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    }
    const jobs = tools.find((tool) => tool.name === "search_my_jobs");
    assert.equal((jobs?.annotations as { title?: string } | undefined)?.title, "Search my jobs");
  });

  it("D9 gives each action tool the title its own definition declares", async () => {
    const definition = ACTION_DEFINITIONS[0]!;
    const tools = await listedTools(grantMount([definition.previewTool, definition.applyTool]));
    const preview = tools.find((tool) => tool.name === definition.previewTool);
    const apply = tools.find((tool) => tool.name === definition.applyTool);
    assert.ok(preview && apply, "the entitled catalog must carry the granted pair");
    assert.equal((preview!.annotations as { title?: string }).title, definition.previewTitle);
    assert.equal((apply!.annotations as { title?: string }).title, definition.applyTitle);
    assert.equal(apply!.annotations?.destructiveHint, true, "apply stays honestly destructive");
  });
});

describe("lane D P5 — desktop copy stops promising read-only", () => {
  it("D10 says write actions appear only for entitled sessions", () => {
    const report = generateDesktopConfig({
      surface: "chatgpt_desktop",
      mcpUrl: "https://greenhouse-recruiter.example.com/mcp",
      token: "durable-user-token",
    });
    const serialized = JSON.stringify(report.config);
    assert.doesNotMatch(serialized, /Recruiter-scoped Greenhouse read and analysis tools\./);
    assert.match(serialized, /write actions appear only for entitled sessions/i);
  });
});
