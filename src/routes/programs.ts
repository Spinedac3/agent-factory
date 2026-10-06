import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Person, VerifyPerson } from "../assistant/identity.js";
import { RunTokenError } from "../assistant/runTokens.js";
import type { Database } from "../db/client.js";
import { programs, programVersions, runCalls, runs } from "../db/schema.js";
import type { Programs } from "../programs/service.js";

export interface ProgramsRoutesOptions {
  db: Database;
  programs: Programs;
  verifyPerson: VerifyPerson;
}

const codeParams = z.object({ code: z.string().regex(/^[a-z][a-z0-9_-]{1,59}$/) });
const runParams = z.object({ id: z.string().uuid() });
const saveBody = z
  .object({
    name: z.string().trim().min(3, "El nombre es muy corto").max(120, "El nombre es muy largo"),
    description: z.string().trim().max(2_000, "La descripción es muy larga").default(""),
    program: z.unknown(),
  })
  .strict();
const NOT_FOUND = {
  ok: false,
  error: "program_not_found",
  message: "Ese programa no existe o no es tuyo",
};

/**
 * Registers the programs of each person: save, judge, publish and run on demand
 *
 * @param   app      Fastify instance
 * @param   options  Database, the service and how a session is checked
 */
export default async function programsRoutes(
  app: FastifyInstance,
  options: ProgramsRoutesOptions,
): Promise<void> {
  const { db, programs: service } = options;

  // Judging and running need the assistant: when it does not answer, the fault is upstream
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RunTokenError) {
      request.log.warn({ code: error.code }, "assistant refused or did not answer");
      return reply
        .code(502)
        .send({ ok: false, error: "assistant_unavailable", message: error.message });
    }
    throw error;
  });

  /**
   * Finds who calls, answering 401 when the session is not one the assistant signed
   *
   * @param   request  Incoming request
   * @param   reply    Reply, used to refuse
   *
   * @return  The person, or null once refused
   */
  const personOf = async (request: FastifyRequest, reply: FastifyReply): Promise<Person | null> => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const person = token ? await options.verifyPerson(token) : null;
    if (!person) {
      reply
        .code(401)
        .send({ ok: false, error: "unauthorized", message: "Entra con tu cuenta del asistente" });
    }

    return person;
  };

  /**
   * Reads the program code of a route, answering 404 when it is not one
   *
   * @param   request  Incoming request
   * @param   reply    Reply, used to refuse
   *
   * @return  The code, or null once refused
   */
  const codeOf = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const params = codeParams.safeParse(request.params);
    if (!params.success) {
      reply.code(404).send(NOT_FOUND);
      return null;
    }

    return params.data.code;
  };

  app.get("/programs", async (request, reply) => {
    const person = await personOf(request, reply);
    if (!person) {
      return reply;
    }
    const rows = await db
      .select({
        code: programs.code,
        name: programs.name,
        description: programs.description,
        updatedAt: programs.updatedAt,
      })
      .from(programs)
      .where(eq(programs.ownerId, person.id))
      .orderBy(asc(programs.code));

    return { ok: true, data: rows };
  });

  app.get("/programs/:code", async (request, reply) => {
    const person = await personOf(request, reply);
    const code = person ? codeOf(request, reply) : null;
    if (!person || !code) {
      return reply;
    }
    const program = await service.find(person.id, code);
    if (!program) {
      return reply.code(404).send(NOT_FOUND);
    }
    const versions = await db
      .select({ version: programVersions.version, publishedAt: programVersions.publishedAt })
      .from(programVersions)
      .where(eq(programVersions.programId, program.id))
      .orderBy(desc(programVersions.version));

    return {
      ok: true,
      data: {
        code: program.code,
        name: program.name,
        description: program.description,
        program: program.draft,
        versions,
      },
    };
  });

  // A draft is kept even with errors, so it can be fixed in pieces; it only publishes clean
  app.put("/programs/:code", async (request, reply) => {
    const person = await personOf(request, reply);
    const code = person ? codeOf(request, reply) : null;
    if (!person || !code) {
      return reply;
    }
    const body = saveBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: body.error.issues[0]?.message });
    }
    const saved = await service.save(
      person.id,
      code,
      body.data.name,
      body.data.description,
      body.data.program,
    );
    if (!saved) {
      return reply.code(404).send(NOT_FOUND);
    }
    if (!saved.verdict.program) {
      return reply
        .code(422)
        .send({ ok: false, error: "invalid_program", errors: saved.verdict.errors });
    }

    return { ok: true, data: { errors: saved.verdict.errors, warnings: saved.verdict.warnings } };
  });

  app.post("/programs/:code/publish", async (request, reply) => {
    const person = await personOf(request, reply);
    const code = person ? codeOf(request, reply) : null;
    if (!person || !code) {
      return reply;
    }
    const published = await service.publish(person.id, code);
    if (!published) {
      return reply.code(404).send(NOT_FOUND);
    }
    if (published.version === null) {
      return reply.code(422).send({
        ok: false,
        error: "program_has_errors",
        message: "El programa tiene errores: corrígelos antes de publicar",
        errors: published.verdict.errors,
      });
    }

    return reply.code(201).send({
      ok: true,
      data: { version: published.version, warnings: published.verdict.warnings },
    });
  });

  app.post("/programs/:code/runs", async (request, reply) => {
    const person = await personOf(request, reply);
    const code = person ? codeOf(request, reply) : null;
    if (!person || !code) {
      return reply;
    }
    const started = await service.start(person.id, code);
    if (started === null) {
      return reply.code(404).send(NOT_FOUND);
    }
    if (started === "unpublished") {
      return reply.code(409).send({
        ok: false,
        error: "program_unpublished",
        message: "El programa no tiene ninguna versión publicada",
      });
    }

    return reply.code(202).send({ ok: true, data: { run_id: started } });
  });

  app.get("/programs/:code/runs", async (request, reply) => {
    const person = await personOf(request, reply);
    const code = person ? codeOf(request, reply) : null;
    if (!person || !code) {
      return reply;
    }
    const program = await service.find(person.id, code);
    if (!program) {
      return reply.code(404).send(NOT_FOUND);
    }
    const rows = await db
      .select({
        id: runs.id,
        version: runs.version,
        status: runs.status,
        reason: runs.reason,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(eq(runs.programId, program.id))
      .orderBy(desc(runs.startedAt))
      .limit(50);

    return { ok: true, data: rows };
  });

  app.get("/runs/:id", async (request, reply) => {
    const person = await personOf(request, reply);
    if (!person) {
      return reply;
    }
    const params = runParams.safeParse(request.params);
    const [run] = params.success
      ? await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, params.data.id), eq(runs.ownerId, person.id)))
      : [];
    if (!run) {
      return reply
        .code(404)
        .send({ ok: false, error: "run_not_found", message: "Esa corrida no existe o no es tuya" });
    }
    const calls = await db
      .select({
        step: runCalls.step,
        tool: runCalls.tool,
        args: runCalls.args,
        ok: runCalls.ok,
        error: runCalls.error,
      })
      .from(runCalls)
      .where(eq(runCalls.runId, run.id))
      .orderBy(asc(runCalls.position));

    return { ok: true, data: { ...run, calls } };
  });
}
