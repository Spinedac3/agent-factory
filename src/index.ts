import { buildApp } from "./app.js";
import { assistantKeys, personVerifier } from "./assistant/identity.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = buildApp({
  verifyPerson: personVerifier(assistantKeys(env.ASSISTANT_URL), env.ASSISTANT_ISSUER),
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
