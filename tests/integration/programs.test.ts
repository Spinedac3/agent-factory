import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Person } from "../../src/assistant/identity.js";
import type { AssistantSession } from "../../src/assistant/mcp.js";
import { RunTokenError, type RunTokenRequest } from "../../src/assistant/runTokens.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { Programs } from "../../src/programs/service.js";
import { fakeTools, lateOrders, ORDERS, TOOLS } from "../programs/fixtures.js";
import { freshDatabase } from "./support/database.js";

const PEOPLE: Record<string, Person> = {
  ana: { id: 1, email: "ana@example.com", scopes: [] },
  beto: { id: 2, email: "beto@example.com", scopes: [] },
};

let database: DatabaseHandle;
let app: FastifyInstance;
let programs: Programs;
// What each person may use in the assistant, as its ceiling decides
let usable: Record<number, string[]>;
const issued: RunTokenRequest[] = [];
const revoked: string[] = [];
// How the fake assistant misbehaves in a test
let unreachable = false;
let sessionFails = false;
// The code a failing query answers with, when a test wants it to fail
let failure: string | null = null;
const tools = fakeTools({
  pedidos_atrasados: () =>
    failure === null
      ? { ok: true, data: { filas: ORDERS, total_filas: ORDERS.length } }
      : { ok: false, error: failure, message: "la consulta falló" },
});

/**
 * Sends a request as a person
 *
 * @param   who      Person, or nobody
 * @param   method   HTTP method
 * @param   url      Route
 * @param   payload  Body
 *
 * @return  The response
 */
function as(who: string | null, method: "GET" | "PUT" | "POST", url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: who ? { authorization: `Bearer ${who}` } : {},
    ...(payload ? { payload } : {}),
  });
}

/**
 * Saves the demo program as a person
 *
 * @param   who      Person
 * @param   program  The program, the demo by default
 *
 * @return  The response
 */
function save(who: string, program: unknown = lateOrders()) {
  return as(who, "PUT", "/programs/atrasos", { name: "Pedidos atrasados", program });
}

describe("programs", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    programs = new Programs({
      db: database.db,
      runTokens: {
        issue: async (request) => {
          issued.push(request);
          if (unreachable) {
            throw new RunTokenError("assistant_unreachable", "No se pudo contactar al asistente");
          }
          const granted = request.tools.filter((tool) => usable[request.ownerId]?.includes(tool));
          if (granted.length === 0) {
            throw new RunTokenError(
              "no_tools",
              "La persona dueña ya no puede usar ninguna",
              request.tools,
            );
          }
          return {
            token: `token:${request.ownerId}:${granted.join(",")}`,
            tools: granted,
            denied: request.tools.filter((tool) => !granted.includes(tool)),
            expiresIn: request.minutes * 60,
          };
        },
        revoke: async (token) => {
          revoked.push(token);
        },
      },
      openSession: async (token): Promise<AssistantSession> => {
        if (sessionFails) {
          throw new Error("la sesión no abrió");
        }
        const granted = token.split(":")[2]?.split(",") ?? [];
        return {
          tools: async () => TOOLS.filter((tool) => granted.includes(tool.name)),
          call: tools.callTool,
          close: async () => undefined,
        };
      },
      timeZone: "America/Guatemala",
      now: () => new Date("2026-10-06T13:00:00Z"),
    });
    app = await buildApp({
      db: database.db,
      programs,
      verifyPerson: async (token) => PEOPLE[token] ?? null,
    });
  });

  beforeEach(() => {
    usable = { 1: ["pedidos_atrasados", "send_notice"], 2: ["pedidos_atrasados"] };
    issued.length = 0;
    revoked.length = 0;
    tools.seen.length = 0;
    unreachable = false;
    sessionFails = false;
    failure = null;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("saves a draft judged against the owner's tools, and keeps it from everyone else", async () => {
    // Performs the test.
    const saved = await save("ana");
    const mine = await as("ana", "GET", "/programs/atrasos");
    const theirs = await as("beto", "GET", "/programs/atrasos");
    const overwrite = await save("beto");
    const anonymous = await as(null, "GET", "/programs");

    // Performs assertions.
    expect(saved.json()).toEqual({ ok: true, data: { errors: [], warnings: [] } });
    expect(mine.json().data).toMatchObject({
      code: "atrasos",
      name: "Pedidos atrasados",
      versions: [],
    });
    expect([theirs.statusCode, overwrite.statusCode, anonymous.statusCode]).toEqual([
      404, 404, 401,
    ]);
    expect(issued.map((request) => request.minutes)).toEqual([1]);
    expect(revoked).toEqual(["token:1:pedidos_atrasados,send_notice"]);
  });

  it("keeps a draft with errors, and refuses to publish it", async () => {
    // Performs the test.
    usable[1] = ["pedidos_atrasados"];
    const saved = await save("ana");
    const published = await as("ana", "POST", "/programs/atrasos/publish");

    // Performs assertions.
    expect(saved.json().data.errors).toEqual([
      "'avisar' usa 'send_notice', que la persona dueña no puede usar",
    ]);
    expect(published.statusCode).toBe(422);
    expect(published.json().errors).toEqual([
      "'avisar' usa 'send_notice', que la persona dueña no puede usar",
    ]);
  });

  it("does not keep what does not parse as a program", async () => {
    // Performs the test.
    const saved = await as("ana", "PUT", "/programs/otro", {
      name: "Otro",
      program: { nodes: [] },
    });
    const after = await as("ana", "GET", "/programs/otro");

    // Performs assertions.
    expect(saved.statusCode).toBe(422);
    expect(after.statusCode).toBe(404);
  });

  it("publishes numbered versions and refuses to run before the first", async () => {
    // Performs the test.
    await as("ana", "PUT", "/programs/nuevo", { name: "Nuevo programa", program: lateOrders() });
    const early = await as("ana", "POST", "/programs/nuevo/runs");
    const first = await as("ana", "POST", "/programs/nuevo/publish");
    const second = await as("ana", "POST", "/programs/nuevo/publish");

    // Performs assertions.
    expect(early.statusCode).toBe(409);
    expect([first.json().data.version, second.json().data.version]).toEqual([1, 2]);
  });

  it("runs the last version with its own token, keeps every call, and ends the token", async () => {
    // Performs the test.
    await save("ana");
    await as("ana", "POST", "/programs/atrasos/publish");
    issued.length = 0;
    revoked.length = 0;
    const started = await as("ana", "POST", "/programs/atrasos/runs");
    const runId = started.json().data.run_id as string;
    await programs.idle();
    const run = await as("ana", "GET", `/runs/${runId}`);
    const listed = await as("ana", "GET", "/programs/atrasos/runs");
    const foreign = await as("beto", "GET", `/runs/${runId}`);

    // Performs assertions.
    expect(started.statusCode).toBe(202);
    expect(run.json().data).toMatchObject({
      status: "delivered",
      steps: ["inicio", "leer", "clasificar", "hay", "avisar", "listo"],
      counts: { "clasificar.grave": 2, "clasificar.leve": 1, "clasificar.al_dia": 1 },
    });
    expect(run.json().data.calls.map((call: { tool: string }) => call.tool)).toEqual([
      "pedidos_atrasados",
      "send_notice",
      "send_notice",
    ]);
    expect(issued).toEqual([
      { ownerId: 1, tools: ["pedidos_atrasados", "send_notice"], minutes: 30, runId },
    ]);
    expect(revoked).toEqual(["token:1:pedidos_atrasados,send_notice"]);
    expect(listed.json().data[0]).toMatchObject({ id: runId, status: "delivered" });
    expect(foreign.statusCode).toBe(404);
  });

  it("fails the run, saying why, when the assistant no longer grants its tools", async () => {
    // Performs the test.
    await save("ana");
    await as("ana", "POST", "/programs/atrasos/publish");
    usable[1] = [];
    const runId = (await as("ana", "POST", "/programs/atrasos/runs")).json().data.run_id as string;
    await programs.idle();
    const run = await as("ana", "GET", `/runs/${runId}`);

    // Performs assertions.
    expect(run.json().data).toMatchObject({
      status: "failed",
      reason:
        "el asistente no dio el token de la corrida: La persona dueña ya no puede usar ninguna",
      calls: [],
    });
  });

  it("gives two publishes at the same time two numbers", async () => {
    // Performs the test.
    await as("ana", "PUT", "/programs/doble", { name: "Doble publicación", program: lateOrders() });
    const both = await Promise.all([
      as("ana", "POST", "/programs/doble/publish"),
      as("ana", "POST", "/programs/doble/publish"),
    ]);

    // Performs assertions.
    expect(both.map((response) => response.json().data.version).sort()).toEqual([1, 2]);
  });

  it("ends the token even when the session cannot open, and answers 502 when the assistant is away", async () => {
    // Performs the test.
    sessionFails = true;
    const failing = await save("ana");
    const revokedAfterFailure = [...revoked];
    sessionFails = false;
    unreachable = true;
    const away = await save("ana");

    // Performs assertions.
    expect(failing.statusCode).toBe(500);
    expect(revokedAfterFailure).toEqual(["token:1:pedidos_atrasados,send_notice"]);
    expect(away.statusCode).toBe(502);
    expect(away.json()).toMatchObject({ error: "assistant_unavailable" });
  });

  it("keeps a long error code within its column, and ends the runs a stopped process left", async () => {
    // Performs the test.
    await save("ana");
    await as("ana", "POST", "/programs/atrasos/publish");
    failure = "x".repeat(200);
    const runId = (await as("ana", "POST", "/programs/atrasos/runs")).json().data.run_id as string;
    await programs.idle();
    const failed = await as("ana", "GET", `/runs/${runId}`);
    failure = null;
    const stuck = (await as("ana", "POST", "/programs/atrasos/runs")).json().data.run_id as string;
    await programs.idle();
    await database.db.execute(
      sql`update runs set status = 'running', finished_at = null where id = ${stuck}`,
    );
    const ended = await programs.recover();
    const after = await as("ana", "GET", `/runs/${stuck}`);

    // Performs assertions.
    expect(failed.json().data.calls).toEqual([
      expect.objectContaining({ tool: "pedidos_atrasados", ok: false, error: "x".repeat(64) }),
    ]);
    expect(ended).toBe(1);
    expect(after.json().data).toMatchObject({
      status: "failed",
      reason: "la corrida se interrumpió: la fábrica se detuvo mientras corría",
    });
  });
});
