import { HARVEST_V3_ENDPOINT_DOC_FACTS } from "./src/harvest-v3-registry.generated.js";
for (const p of ["/v3/tracking_links", "/v3/users", "/v3/interviews", "/v3/jobs", "/v3/candidates", "/v3/offers"]) {
  const f = (HARVEST_V3_ENDPOINT_DOC_FACTS as any[]).find(e => e.path === p);
  if (!f) { console.log(p, "MISSING"); continue; }
  console.log(`\n=== ${p} list=${f.list} cursor=${f.cursorPaginated}`);
  console.log("  params:", f.parameters.map((x: any) => `${x.name}:${x.type}${x.enumValues ? "[" + x.enumValues.join("|") + "]" : ""}`).join(", "));
  console.log("  fields:", f.responseFields.map((x: any) => x.name).join(", "));
}
