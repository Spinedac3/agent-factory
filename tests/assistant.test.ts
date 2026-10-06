import Fastify, { type FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { assistantKeys, personVerifier } from "../src/assistant/identity.js";
import { RunTokenError, RunTokens } from "../src/assistant/runTokens.js";

let assistant: FastifyInstance;
let assistantUrl: string;
let sign: (claims: Record<string, unknown>, issuer?: string) => Promise<string>;
let forge: (claims: Record<string, unknown>) => Promise<string>;
const asked: unknown[] = [];

/**
 * Waits for an attempt that must be refused
 *
 * @param   attempt  The call
 *
 * @return  Its refusal
 */
function refusal(attempt: Promise<unknown>): Promise<RunTokenError> {
  return attempt.then(
    () => {
      throw new Error("El pedido no fue rechazado");
    },
    (error: RunTokenError) => error,
  );
}

describe("the assistant, seen from the factory", () => {
  beforeAll(async () => {
    const real = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(real.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const signer =
      (key: Parameters<SignJWT["sign"]>[0]) =>
      (claims: Record<string, unknown>, issuer = "ai-assistant") =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setSubject(String(claims.sub ?? "7"))
          .setIssuer(issuer)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(key);
    sign = signer(real.privateKey);
    forge = signer(other.privateKey);

    assistant = Fastify();
    assistant.get("/.well-known/jwks.json", async () => ({ keys: [jwk] }));
    assistant.post("/runs/tokens", async (request, reply) => {
      asked.push({ authorization: request.headers.authorization, body: request.body });
      const body = request.body as { tools: string[] };
      if (body.tools.every((tool) => tool === "payroll_totals")) {
        return reply.code(403).send({
          ok: false,
          error: "no_tools",
          message: "La persona dueña ya no puede usar ninguna de las herramientas del agente",
          data: { denied: ["payroll_totals"] },
        });
      }
      return reply.code(201).send({
        ok: true,
        data: {
          token: "ast_run",
          tools: ["calculate"],
          denied: ["payroll_totals"],
          expires_in: 60,
        },
      });
    });
    assistant.post("/runs/tokens/revoke", async (request) => {
      asked.push({ revoked: request.body });
      return { ok: true };
    });
    assistantUrl = await assistant.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await assistant.close();
  });

  it("knows a person by a session the assistant signed, and nobody by any other", async () => {
    // Performs the test.
    const app = await buildApp({
      verifyPerson: personVerifier(assistantKeys(assistantUrl), "ai-assistant"),
    });
    const me = (token: string) =>
      app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
    const valid = await me(
      await sign({ sub: "7", email: "ana@example.com", scopes: ["chat.use"] }),
    );
    const forged = await me(await forge({ sub: "7", email: "ana@example.com" }));
    const otherIssuer = await me(await sign({ sub: "7" }, "someone-else"));
    const noSubject = await me(await sign({ sub: "nadie" }));
    const none = await app.inject({ method: "GET", url: "/me" });

    // Performs assertions.
    expect(valid.json()).toEqual({
      ok: true,
      data: { id: 7, email: "ana@example.com", scopes: ["chat.use"] },
    });
    expect([forged, otherIssuer, noSubject, none].map((answer) => answer.statusCode)).toEqual([
      401, 401, 401, 401,
    ]);
    expect(none.json().message).toBe("Entra con tu cuenta del asistente");
  });

  it("asks for a run token as its machine client, and ends it", async () => {
    // Performs the test.
    asked.length = 0;
    const tokens = new RunTokens({ assistantUrl, clientId: "agent-factory", secret: "s3cret" });
    const run = await tokens.issue({
      ownerId: 7,
      tools: ["calculate", "payroll_totals"],
      minutes: 30,
      runId: "run-1",
    });
    await tokens.revoke(run.token);

    // Performs assertions.
    expect(run).toEqual({
      token: "ast_run",
      tools: ["calculate"],
      denied: ["payroll_totals"],
      expiresIn: 60,
    });
    expect(asked).toEqual([
      {
        authorization: `Basic ${Buffer.from("agent-factory:s3cret").toString("base64")}`,
        body: { owner_id: 7, tools: ["calculate", "payroll_totals"], minutes: 30, run_id: "run-1" },
      },
      { revoked: { token: "ast_run" } },
    ]);
  });

  it("passes on the assistant's refusal, and says so when it cannot reach it", async () => {
    // Performs the test.
    const refused = await refusal(
      new RunTokens({ assistantUrl, clientId: "agent-factory", secret: "s" }).issue({
        ownerId: 7,
        tools: ["payroll_totals"],
        minutes: 5,
        runId: "run-2",
      }),
    );
    const unreachable = await refusal(
      new RunTokens({
        assistantUrl: "http://127.0.0.1:1",
        clientId: "agent-factory",
        secret: "s",
      }).issue({ ownerId: 7, tools: ["calculate"], minutes: 5, runId: "run-3" }),
    );

    const shapeless = await refusal(
      new RunTokens({
        assistantUrl,
        clientId: "agent-factory",
        secret: "s",
        fetch: async () => Response.json({ ok: true }, { status: 201 }),
      }).issue({ ownerId: 7, tools: ["calculate"], minutes: 5, runId: "run-4" }),
    );

    // Performs assertions.
    expect(refused).toBeInstanceOf(RunTokenError);
    expect([refused.code, refused.denied]).toEqual(["no_tools", ["payroll_totals"]]);
    expect([shapeless.code, shapeless.message]).toEqual([
      "invalid_answer",
      "El asistente respondió algo que no es un token",
    ]);
    expect([unreachable.code, unreachable.message]).toEqual([
      "assistant_unreachable",
      "No se pudo contactar al asistente",
    ]);
  });
});
