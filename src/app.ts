import Fastify, { type FastifyInstance } from "fastify";
import type { VerifyPerson } from "./assistant/identity.js";

export interface AppDependencies {
  // Checks a session the assistant signed; without it nobody can enter
  verifyPerson?: VerifyPerson;
}

/**
 * Builds the HTTP application without binding a port
 *
 * @param   deps  How a person's session is checked
 *
 * @return  The configured Fastify instance
 */
export function buildApp(deps: AppDependencies = {}): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ status: "ok" }));

  // Who the assistant says the caller is; the factory keeps no accounts of its own
  app.get("/me", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const person = token && deps.verifyPerson ? await deps.verifyPerson(token) : null;
    if (!person) {
      return reply
        .code(401)
        .send({ ok: false, error: "unauthorized", message: "Entra con tu cuenta del asistente" });
    }

    return { ok: true, data: person };
  });

  return app;
}
