import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRecruiterMcpServer } from "./src/server.js";

const { server } = createRecruiterMcpServer({
  session: { subject: "s", surface: "test", client: "claude_desktop_chat", tokenId: "t" } as never,
  env: { GREENHOUSE_RECRUITER_ALLOW_TEST_SURFACE: "true" },
  configureGreenhouse: false,
  scopedReader: { async scopedRead() { throw new Error("no"); } } as never,
});
const client = new Client({ name: "m", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);
const { tools } = await client.listTools();

let anyOfCount = 0, anyOfBytes = 0, scopeParamCount = 0, scopeParamBytes = 0, undescribed = 0, totalParams = 0;
const undescribedNames = new Map<string, number>();
for (const t of tools as any[]) {
  const props = t.inputSchema?.properties ?? {};
  for (const [name, spec] of Object.entries(props) as [string, any][]) {
    totalParams++;
    const bytes = Buffer.byteLength(JSON.stringify({ [name]: spec }), "utf8");
    if (spec.anyOf) { anyOfCount++; anyOfBytes += bytes; }
    if (name === "scope_handle" || name === "job_ids") { scopeParamCount++; scopeParamBytes += bytes; }
    if (!spec.description) { undescribed++; undescribedNames.set(name, (undescribedNames.get(name) ?? 0) + 1); }
  }
}
console.log("tools:", tools.length, "totalParams:", totalParams);
console.log("anyOf date params:", anyOfCount, "bytes:", anyOfBytes);
console.log("scope_handle/job_ids params:", scopeParamCount, "bytes:", scopeParamBytes);
console.log("undescribed params:", undescribed);
console.log("undescribed by name:", [...undescribedNames.entries()].sort((a,b)=>b[1]-a[1]).slice(0,40));
// sample anyOf serialization
const sample = (tools as any[]).find(t => t.name === "search_my_applications");
console.log("\nsample created_at:", JSON.stringify(sample.inputSchema.properties.created_at));
console.log("\nsample scope_handle bytes:", Buffer.byteLength(JSON.stringify((tools as any[]).find(t=>t.name==="search_my_scorecards").inputSchema.properties.scope_handle)));
await client.close(); await server.close();
