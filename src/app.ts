import Fastify, { type FastifyInstance } from "fastify";
import type { VerifyPerson } from "./assistant/identity.js";
import type { Database } from "./db/client.js";
import type { Programs } from "./programs/service.js";
import programsRoutes from "./routes/programs.js";

export interface AppDependencies {
  // Checks a session the assistant signed; without it nobody can enter
  verifyPerson?: VerifyPerson;
  // Without them the programs are not mounted, which keeps identity tests light
  db?: Database;
  programs?: Programs;
}

/**
 * Builds the HTTP application without binding a port
 *
 * @param   deps  How a person's session is checked, and the programs
 *
 * @return  The configured Fastify instance
 */
export async function buildApp(deps: AppDependencies = {}): Promise<FastifyInstance> {
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

  if (deps.db && deps.programs && deps.verifyPerson) {
    await app.register(programsRoutes, {
      db: deps.db,
      programs: deps.programs,
      verifyPerson: deps.verifyPerson,
    });
  }

  return app;
}
