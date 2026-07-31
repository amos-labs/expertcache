import { createHash } from "node:crypto";

export function canonicalizeQualificationMessage(message) {
  const canonical = structuredClone(message || null);
  for (const call of canonical?.tool_calls || []) {
    if (Object.hasOwn(call, "id")) call.id = "<opaque-tool-call-id>";
  }
  return canonical;
}

export function canonicalQualificationMessageSha256(message) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeQualificationMessage(message)))
    .digest("hex");
}
