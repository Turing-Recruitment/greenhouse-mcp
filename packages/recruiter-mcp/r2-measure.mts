import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRecruiterMcpServer, SERVER_INSTRUCTIONS } from "./src/server.js";
import { RECRUITER_TOOL_DEFINITIONS, PILOT_TOOL_NAMES } from "./src/tools/register.js";
import { ACTION_DEFINITIONS } from "../action-mcp/dist/index.js";
import { createActionToolGrant } from "./src/action-tools.js";

function session() {
  return { subject: "s", surface: "test" as const, client: "claude_desktop_chat" as const, tokenId: "t" };
}
function noReadScopedReader() {
  return { async scopedRead() { throw new Error("no"); } };
}

async function measure(label: string, env: NodeJS.ProcessEnv, grantAll = false) {
  const actionPlane = grantAll
    ? {
        grantedTools: createActionToolGrant(
          ACTION_DEFINITIONS.flatMap((d: any) => [d.previewTool, d.applyTool])
        ),
        buildService: () => ({ preview: async () => ({}), apply: async () => ({}) }) as never,
      }
    : undefined;
  const { server } = createRecruiterMcpServer({
    session: session() as never,
    env,
    configureGreenhouse: false,
    scopedReader: noReadScopedReader() as never,
    ...(actionPlane ? { actionPlane } : {}),
  });
  const client = new Client({ name: "m", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const listed = await client.listTools();
  const instructions = client.getInstructions() ?? "";
  const toolsBytes = Buffer.byteLength(JSON.stringify(listed.tools), "utf8");
  const instructionsBytes = Buffer.byteLength(instructions, "utf8");
  console.log(`${label}: tools=${listed.tools.length} toolsBytes=${toolsBytes} instructionsBytes=${instructionsBytes} total=${toolsBytes + instructionsBytes} ~tokens=${Math.round((toolsBytes + instructionsBytes) / 4)}`);
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  return { count: listed.tools.length, toolsBytes, instructionsBytes, tools: listed.tools };
}

const allowlisted = await measure("44 allowlisted", { GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","), GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" });
const full = await measure("full (no allowlist)", { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" });
const withWrites = await measure("full + writes", { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" }, true);
console.log("SERVER_INSTRUCTIONS chars:", SERVER_INSTRUCTIONS.length, "bytes:", Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8"));
console.log("RECRUITER_TOOL_DEFINITIONS:", RECRUITER_TOOL_DEFINITIONS.length, "PILOT_TOOL_NAMES:", PILOT_TOOL_NAMES.length);

// Per-tool byte breakdown on the full catalog
const rows = full.tools.map((t: any) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t), "utf8"), descBytes: Buffer.byteLength(t.description ?? "", "utf8") }));
rows.sort((a, b) => b.bytes - a.bytes);
console.log("\nTop 15 tools by bytes:");
for (const r of rows.slice(0, 15)) console.log(`  ${r.name}: ${r.bytes} (desc ${r.descBytes})`);
const totalDesc = rows.reduce((s, r) => s + r.descBytes, 0);
console.log("total description bytes:", totalDesc, "schema+name bytes:", full.toolsBytes - totalDesc);
