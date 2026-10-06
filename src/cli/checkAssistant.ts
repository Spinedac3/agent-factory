import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { RunTokenError, RunTokens } from "../assistant/runTokens.js";
import { loadEnv } from "../config/env.js";

// Proves the link with the assistant end to end: a token for one short run, then ended
const [owner, ...tools] = process.argv.slice(2);
const ownerId = Number(owner);
if (!Number.isInteger(ownerId) || ownerId <= 0 || tools.length === 0) {
  throw new Error("Uso: pnpm assistant:check <id de la persona> <herramienta> [herramienta...]");
}

const env = loadEnv();
const runTokens = new RunTokens({
  assistantUrl: env.ASSISTANT_URL,
  clientId: env.ASSISTANT_CLIENT_ID,
  secret: readFileSync(env.ASSISTANT_CLIENT_SECRET_FILE, "utf8").trim(),
});

try {
  const run = await runTokens.issue({ ownerId, tools, minutes: 1, runId: `check-${randomUUID()}` });
  await runTokens.revoke(run.token);
  console.info(`Puede usar: ${run.tools.join(", ")}`);
  if (run.denied.length > 0) {
    console.info(`No puede usar: ${run.denied.join(", ")}`);
  }
} catch (error) {
  if (error instanceof RunTokenError) {
    console.error(
      `${error.message}${error.denied.length > 0 ? ` (${error.denied.join(", ")})` : ""}`,
    );
    process.exit(1);
  }
  throw error;
}
