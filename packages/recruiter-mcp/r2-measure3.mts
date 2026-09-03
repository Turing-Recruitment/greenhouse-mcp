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
const byName = new Map<string, { n: number; bytes: number }>();
for (const t of tools as any[]) {
  for (const [name, spec] of Object.entries(t.inputSchema?.properties ?? {}) as [string, any][]) {
    const bytes = Buffer.byteLength(JSON.stringify({ [name]: spec }), "utf8");
    const e = byName.get(name) ?? { n: 0, bytes: 0 };
    e.n++; e.bytes += bytes; byName.set(name, e);
  }
}
const rows = [...byName.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
let cum = 0;
for (const [name, e] of rows.slice(0, 30)) { cum += e.bytes; console.log(`${name}: n=${e.n} bytes=${e.bytes} avg=${Math.round(e.bytes/e.n)}`); }
console.log("top30 cum:", cum, "of", rows.reduce((s,[,e])=>s+e.bytes,0));
await client.close(); await server.close();
