import { readFileSync } from "node:fs";
import { buildApp } from "./app.js";
import { assistantKeys, personVerifier } from "./assistant/identity.js";
import { openSession } from "./assistant/mcp.js";
import { RunTokens } from "./assistant/runTokens.js";
import { loadEnv } from "./config/env.js";
import { connectDatabase } from "./db/client.js";
import { modelCaller } from "./llm/model.js";
import { Programs } from "./programs/service.js";

const env = loadEnv();
const database = connectDatabase(env.DATABASE_URL);
const runTokens = new RunTokens({
  assistantUrl: env.ASSISTANT_URL,
  clientId: env.ASSISTANT_CLIENT_ID,
  secret: readFileSync(env.ASSISTANT_CLIENT_SECRET_FILE, "utf8").trim(),
});
const app = await buildApp({
  verifyPerson: personVerifier(assistantKeys(env.ASSISTANT_URL), env.ASSISTANT_ISSUER),
  db: database.db,
  programs: new Programs({
    db: database.db,
    runTokens,
    openSession: (token) => openSession(env.ASSISTANT_URL, token),
    callModel: modelCaller({
      bin: env.CLAUDE_BIN,
      model: env.AGENT_MODEL,
      workspacesDir: env.WORKSPACES_DIR,
    }),
    timeZone: env.APP_TIMEZONE,
  }),
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
