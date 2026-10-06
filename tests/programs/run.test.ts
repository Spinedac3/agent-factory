import { describe, expect, it } from "vitest";
import type { Program, ProgramNode } from "../../src/programs/language.js";
import { type CallModel, type RunOptions, runProgram } from "../../src/programs/run.js";
import { CATALOG, fakeTools, lateOrders, ORDERS } from "./fixtures.js";

const ROWS = { ok: true as const, data: { filas: ORDERS, total_filas: ORDERS.length } };

/**
 * Runs a program with fake tools on a given day
 *
 * @param   program  The program
 * @param   extra    What to change of the run's options
 *
 * @return  The result
 */
function run(program: Program, extra: Partial<RunOptions> = {}) {
  return runProgram({
    program,
    catalog: CATALOG,
    day: "tuesday",
    date: "2026-10-06",
    time: "07:00",
    callTool: fakeTools({ pedidos_atrasados: ROWS }).callTool,
    pause: async () => undefined,
    ...extra,
  });
}

/**
 * Replaces one step of the demo program
 *
 * @param   id    Step id
 * @param   step  The new fields
 *
 * @return  The changed program
 */
function withStep(id: string, step: Partial<ProgramNode>): Program {
  const program = lateOrders();
  program.nodes = program.nodes.map((node) => (node.id === id ? { ...node, ...step } : node));
  return program;
}

/**
 * Turns the demo's per-row warning into an agentic one that writes per route
 *
 * @param   step  What to add or change on the agentic step
 *
 * @return  The program
 */
function agentic(step: Partial<ProgramNode>): Program {
  return withStep("avisar", {
    per_row: undefined,
    order_by: undefined,
    group_by: "ruta",
    agentic: { instruction: "Escribe un aviso breve para el responsable de la ruta" },
    per_group: {
      fields: {
        key: "ruta-${group}",
        to: "${recipient}",
        subject: "Atrasos de ${group}",
        message: "${message}",
      },
      recipients: { norte: "norte@example.com", sur: ["sur@example.com", "jefe@example.com"] },
    },
    ...step,
  });
}

describe("running a program", () => {
  it("classifies, filters, orders and fills each row's item, then delivers", async () => {
    // Performs the test.
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    const result = await run(lateOrders(), { callTool: tools.callTool });

    // Performs assertions.
    expect(result.status).toBe("delivered");
    expect(result.steps).toEqual(["inicio", "leer", "clasificar", "hay", "avisar", "listo"]);
    expect(result.counts).toEqual({
      "clasificar.grave": 2,
      "clasificar.leve": 1,
      "clasificar.al_dia": 1,
    });
    expect(tools.seen.map((call) => call.args)).toEqual([
      { dias: 1 },
      {
        notices: [
          {
            key: "atraso-P-4",
            to: "bodega@example.com",
            subject: "Pedido P-4 atrasado",
            message: "Mini Mar: 12 días (grave)",
          },
          {
            key: "atraso-P-1",
            to: "bodega@example.com",
            subject: "Pedido P-1 atrasado",
            message: "Abarrotes Luna: 9 días (grave)",
          },
        ],
      },
      {
        notices: [
          {
            key: "atraso-P-3",
            to: "bodega@example.com",
            subject: "Pedido P-3 atrasado",
            message: "Super Rey: 5 días (leve)",
          },
        ],
      },
    ]);
  });

  it("degrades a class on the day its exception names, as data", async () => {
    // Performs the test.
    const result = await run(lateOrders(), { day: "monday" });

    // Performs assertions.
    expect(result.counts).toEqual({
      "clasificar.grave": 0,
      "clasificar.leve": 3,
      "clasificar.al_dia": 1,
    });
  });

  it("takes the otherwise when nothing is late and ends with the text it declares", async () => {
    // Performs the test.
    const quiet = { ok: true as const, data: { filas: [ORDERS[1]], total_filas: 1 } };
    const result = await run(lateOrders(), {
      callTool: fakeTools({ pedidos_atrasados: quiet }).callTool,
    });

    // Performs assertions.
    expect([result.status, result.endId, result.text]).toEqual([
      "no_findings",
      "nada",
      "Hoy no hay pedidos atrasados",
    ]);
  });

  it("keeps the worst rows when the limit cuts", async () => {
    // Performs the test.
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    await run(withStep("avisar", { limit: 1 }), { callTool: tools.callTool });

    // Performs assertions.
    expect(tools.seen[1]?.args).toEqual({
      notices: [expect.objectContaining({ key: "atraso-P-4" })],
    });
  });

  it("follows on_failure when a tool fails, and the reason travels with the text", async () => {
    // Performs the test.
    const down = { ok: false as const, error: "tool_failed", message: "la base no responde" };
    const result = await run(lateOrders(), {
      callTool: fakeTools({ pedidos_atrasados: down }).callTool,
    });

    // Performs assertions.
    expect([result.status, result.endId]).toEqual(["delivered", "sin_datos"]);
    expect(result.text).toBe(
      "No se pudieron leer los pedidos atrasados\nPor el camino de error: pedidos_atrasados falló en 'leer': la base no responde",
    );
  });

  it("fails without taking on_failure when the tool would reject the step on every run", async () => {
    // Performs the test.
    const rejected = {
      ok: false as const,
      error: "invalid_arguments",
      message: "dias: debe ser número",
    };
    const result = await run(lateOrders(), {
      callTool: fakeTools({ pedidos_atrasados: rejected }).callTool,
    });

    // Performs assertions.
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("lo va a rechazar en toda corrida (invalid_arguments)");
  });

  it("fails naming the field when the tool stops bringing one the program reads", async () => {
    // Performs the test.
    const drifted = {
      ok: true as const,
      data: { filas: [{ pedido: "P-1", dias: 9 }], total_filas: 1 },
    };
    const result = await run(lateOrders(), {
      callTool: fakeTools({ pedidos_atrasados: drifted }).callTool,
    });

    // Performs assertions.
    expect([result.status, result.endId]).toEqual(["failed", null]);
    expect(result.reason).toBe(
      "falló en 'leer': las filas de 'leer' ya no traen 'atraso_dias': la herramienta cambió debajo del programa",
    );
  });

  it("fails on a null it was not told what to do with, and drops it when told to", async () => {
    // Performs the test.
    const withNull = {
      ok: true as const,
      data: { filas: [{ ...ORDERS[0], atraso_dias: null }], total_filas: 1 },
    };
    const callTool = fakeTools({ pedidos_atrasados: withNull }).callTool;
    const failing = await run(lateOrders(), { callTool });
    const dropping = await run(withStep("clasificar", { if_null: "drop" }), { callTool });

    // Performs assertions.
    expect(failing.reason).toBe(
      "falló en 'clasificar': 'clasificar' recibió un 'atraso_dias' vacío y no dice qué hacer con él",
    );
    expect([dropping.status, dropping.counts["clasificar.grave"]]).toEqual(["no_findings", 0]);
  });

  it("fails when no condition holds and there is no otherwise", async () => {
    // Performs the test.
    const program = lateOrders();
    program.edges = program.edges.filter((edge) => edge.otherwise !== true);
    const quiet = { ok: true as const, data: { filas: [ORDERS[1]], total_filas: 1 } };
    const result = await run(program, {
      callTool: fakeTools({ pedidos_atrasados: quiet }).callTool,
    });

    // Performs assertions.
    expect(result.status).toBe("failed");
    expect(result.reason).toContain(
      "ninguna condición de 'hay' se cumplió y no hay salida 'otherwise'",
    );
  });

  it("fails instead of comparing a text as a number", async () => {
    // Performs the test.
    const text = {
      ok: true as const,
      data: { filas: [{ ...ORDERS[0], atraso_dias: "nueve" }], total_filas: 1 },
    };
    const result = await run(lateOrders(), {
      callTool: fakeTools({ pedidos_atrasados: text }).callTool,
    });

    // Performs assertions.
    expect(result.reason).toContain(
      "'atraso_dias' trajo \"nueve\" y 'clasificar' lo compara con un número",
    );
  });

  it("calls nothing when no row is left after the filter", async () => {
    // Performs the test.
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    const result = await run(
      withStep("avisar", { only: ["leve"], limit: 10, order_by: undefined }),
      {
        callTool: tools.callTool,
        day: "tuesday",
      },
    );
    const none = await run(withStep("avisar", { only: ["al_dia"] }), {
      callTool: fakeTools({
        pedidos_atrasados: { ok: true, data: { filas: [ORDERS[0]], total_filas: 1 } },
      }).callTool,
    });

    // Performs assertions.
    expect(tools.seen).toHaveLength(2);
    expect(result.status).toBe("delivered");
    expect([none.status, none.calls.map((call) => call.tool)]).toEqual([
      "delivered",
      ["pedidos_atrasados"],
    ]);
  });

  it("fails when the decision reads a value the query did not bring", async () => {
    // Performs the test.
    const program = lateOrders();
    program.edges = program.edges.map((edge) =>
      edge.condition
        ? { ...edge, condition: { field: "leer.total_filas", op: ">", value: 0 } }
        : edge,
    );
    const missing = { ok: true as const, data: { filas: ORDERS } };
    const result = await run(program, {
      callTool: fakeTools({ pedidos_atrasados: missing }).callTool,
    });

    // Performs assertions.
    expect(result.reason).toBe(
      "falló en 'hay': la condición de 'hay' no se pudo evaluar: 'leer.total_filas' no vino en el resultado",
    );
  });
});

describe("an agentic step", () => {
  it("writes one message per group, each seeing only its own rows and totals", async () => {
    // Performs the test.
    const turns: Array<{ group: string; data: string }> = [];
    const callModel: CallModel = async ({ group, data }) => {
      turns.push({ group, data });
      return `Aviso para ${group}`;
    };
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    const result = await run(agentic({}), { callTool: tools.callTool, callModel });
    const north = turns.find((turn) => turn.group === "norte")?.data ?? "";

    // Performs assertions.
    expect(result.status).toBe("delivered");
    expect(north).toContain("P-1");
    expect(north).toContain("P-3");
    expect(north).not.toContain("P-4");
    expect(north).toContain("monto (suma): 420");
    expect(north).toContain("día: tuesday 2026-10-06 · hora de inicio de la corrida: 07:00");
    expect(tools.seen.slice(1).map((call) => call.args)).toEqual([
      {
        notices: [
          {
            key: "ruta-norte",
            to: "norte@example.com",
            subject: "Atrasos de norte",
            message: "Aviso para norte",
          },
          {
            key: "ruta-sur",
            to: "sur@example.com",
            subject: "Atrasos de sur",
            message: "Aviso para sur",
          },
        ],
      },
      {
        notices: [
          {
            key: "ruta-sur",
            to: "jefe@example.com",
            subject: "Atrasos de sur",
            message: "Aviso para sur",
          },
        ],
      },
    ]);
  });

  it("leaves out a group with no recipient, and counts it", async () => {
    // Performs the test.
    const result = await run(
      agentic({
        per_group: {
          fields: { key: "k-${group}", to: "${recipient}", subject: "s", message: "${message}" },
          recipients: { norte: "norte@example.com" },
        },
      }),
      { callModel: async ({ group }) => `Aviso ${group}` },
    );

    // Performs assertions.
    expect(result.counts["avisar.without_recipient"]).toBe(1);
  });

  it("retries once only when the answer is empty", async () => {
    // Performs the test.
    let calls = 0;
    const result = await run(agentic({}), {
      callModel: async ({ attempt }) => {
        calls += 1;
        return attempt === 1 ? "   " : "Segundo intento";
      },
    });

    // Performs assertions.
    expect(result.status).toBe("delivered");
    expect(calls).toBe(4);
  });

  it("delivers the groups that were written and still fails naming the one that was not", async () => {
    // Performs the test.
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    const result = await run(agentic({}), {
      callTool: tools.callTool,
      callModel: async ({ group }) => {
        if (group === "sur") {
          throw new Error("sin cupo");
        }
        return "Aviso norte";
      },
    });

    // Performs assertions.
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("se redactaron 1 de 2 en 'avisar'; sin mensaje: sur");
    expect(tools.seen[1]?.args).toEqual({
      notices: [expect.objectContaining({ to: "norte@example.com", message: "Aviso norte" })],
    });
  });

  it("fails rather than skipping when there is no model", async () => {
    // Performs the test.
    const result = await run(agentic({}));

    // Performs assertions.
    expect(result.reason).toBe(
      "falló en 'avisar': 'avisar' redacta y esta corrida no tiene modelo",
    );
  });

  it("writes the groups in alphabetical order and cuts by the limit", async () => {
    // Performs the test.
    const groups: string[] = [];
    const southFirst = {
      ok: true as const,
      data: {
        filas: [...ORDERS].sort((a) => (a.ruta === "sur" ? -1 : 1)),
        total_filas: ORDERS.length,
      },
    };
    await run(
      agentic({
        limit: 1,
        per_group: {
          fields: { key: "k", to: "x@example.com", subject: "s", message: "${message}" },
        },
      }),
      {
        callTool: fakeTools({ pedidos_atrasados: southFirst }).callTool,
        callModel: async ({ group }) => {
          groups.push(group);
          return "ok";
        },
      },
    );

    // Performs assertions.
    expect(groups).toEqual(["norte"]);
  });

  it("writes the run's own text when it has no tool, as a single group of everything", async () => {
    // Performs the test.
    const turns: string[] = [];
    const result = await run(
      agentic({
        tool: undefined,
        per_group: undefined,
        group_by: undefined,
        limit: undefined,
        from: "leer.filas",
        only: undefined,
      }),
      {
        callModel: async ({ group, data }) => {
          turns.push(group);
          return data.includes("ya calculado por la consulta → total_filas: 4")
            ? "Resumen del día"
            : "";
        },
      },
    );

    // Performs assertions.
    expect(turns).toEqual(["all"]);
    expect([result.status, result.delivery, result.text]).toEqual([
      "delivered",
      "Resumen del día",
      "Resumen del día",
    ]);
  });

  it("refuses to hand the model more than its budget", async () => {
    // Performs the test.
    const many = Array.from({ length: 6_000 }, (_, index) => ({
      ...ORDERS[0],
      pedido: `P-${index}`,
      cliente: "Cliente con un nombre largo para llenar los datos que lee el modelo",
    }));
    const result = await run(
      agentic({ tool: undefined, per_group: undefined, group_by: undefined }),
      {
        callTool: fakeTools({
          pedidos_atrasados: { ok: true, data: { filas: many, total_filas: many.length } },
        }).callTool,
        callModel: async () => "nunca",
      },
    );

    // Performs assertions.
    expect(result.reason).toContain(
      "agrega 'summarize' para que el programa cuente y el modelo solo redacte",
    );
  });
});

describe("a join", () => {
  /**
   * Builds a program that joins late orders with the person in charge of each route
   *
   * @param   ifMissing  What happens to an order whose route has no person
   *
   * @return  The program
   */
  function joined(ifMissing: "blank" | "drop"): Program {
    return {
      nodes: [
        { id: "inicio", type: "start", title: "Cada mañana" },
        {
          id: "leer",
          type: "query",
          title: "Leer pedidos",
          tool: "pedidos_atrasados",
          params: { dias: 1 },
        },
        { id: "leer_rutas", type: "query", title: "Leer rutas", tool: "rutas" },
        {
          id: "cruzar",
          type: "join",
          title: "Agregar el responsable",
          from: "leer.filas",
          with: "leer_rutas.filas",
          by: "ruta",
          adds: { responsable: "responsable" },
          if_missing: ifMissing,
        },
        { id: "fin", type: "end", title: "Listo", status: "no_findings" },
      ],
      edges: [
        { from: "inicio", to: "leer" },
        { from: "leer", to: "leer_rutas" },
        { from: "leer_rutas", to: "cruzar" },
        { from: "cruzar", to: "fin" },
      ],
    };
  }

  it("joins one to one, and counts the rows with and without a pair", async () => {
    // Performs the test.
    const routes = { ok: true as const, data: { filas: [{ ruta: "norte", responsable: "Ana" }] } };
    const callTool = fakeTools({ pedidos_atrasados: ROWS, rutas: routes }).callTool;
    const blank = await run(joined("blank"), { callTool });
    const drop = await run(joined("drop"), { callTool });

    // Performs assertions.
    expect(blank.counts).toEqual({ "cruzar.joined": 2, "cruzar.unpaired": 2 });
    expect(drop.counts).toEqual({ "cruzar.joined": 2, "cruzar.unpaired": 2 });
  });

  it("fails rather than multiplying rows when a key repeats on the right", async () => {
    // Performs the test.
    const routes = {
      ok: true as const,
      data: {
        filas: [
          { ruta: "norte", responsable: "Ana" },
          { ruta: "norte", responsable: "Beto" },
        ],
      },
    };
    const result = await run(joined("blank"), {
      callTool: fakeTools({ pedidos_atrasados: ROWS, rutas: routes }).callTool,
    });

    // Performs assertions.
    expect(result.reason).toContain("'leer_rutas' trae más de una fila para 'norte'");
  });
});

describe("the rest of the language", () => {
  it("calls a tool once with fixed arguments", async () => {
    // Performs the test.
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    await run(
      withStep("avisar", {
        from: undefined,
        only: undefined,
        order_by: undefined,
        limit: undefined,
        per_row: undefined,
        tool: "pedidos_atrasados",
        once: { dias: 3 },
      }),
      { callTool: tools.callTool },
    );

    // Performs assertions.
    expect(tools.seen.map((call) => call.args)).toEqual([{ dias: 1 }, { dias: 3 }]);
  });

  it("decides by the day, and keeps a class by a list of texts", async () => {
    // Performs the test.
    const program = withStep("clasificar", {
      by: "ruta",
      classes: [
        { name: "grave", op: "in", value: ["norte"] },
        { name: "leve", op: "not in", value: ["sur", "norte"] },
        { name: "al_dia", rest: true },
      ],
      exceptions: undefined,
    });
    program.edges = program.edges.map((edge) =>
      edge.condition ? { ...edge, condition: { day: true, op: "in", value: ["tuesday"] } } : edge,
    );
    const tuesday = await run(program);
    const wednesday = await run(program, { day: "wednesday" });

    // Performs assertions.
    expect(tuesday.counts).toEqual({
      "clasificar.grave": 2,
      "clasificar.leve": 0,
      "clasificar.al_dia": 2,
    });
    expect([tuesday.endId, wednesday.endId]).toEqual(["listo", "nada"]);
  });

  it("classifies the groups a summary makes, not the rows", async () => {
    // Performs the test.
    const result = await run(
      withStep("clasificar", {
        summarize: { by: ["ruta"], sum: ["monto"] },
        by: "monto",
        classes: [
          { name: "grave", op: ">=", value: 400 },
          { name: "leve", op: ">=", value: 1000 },
          { name: "al_dia", rest: true },
        ],
        exceptions: undefined,
      }),
      { callModel: undefined },
    );

    // Performs assertions.
    expect(result.counts).toEqual({
      "clasificar.grave": 1,
      "clasificar.leve": 0,
      "clasificar.al_dia": 1,
    });
  });

  it("fills a template one level deep inside an item", async () => {
    // Performs the test.
    const tools = fakeTools({ pedidos_atrasados: ROWS });
    await run(
      withStep("avisar", {
        only: ["grave"],
        limit: 1,
        per_row: {
          key: "k-${pedido}",
          to: "a@example.com",
          subject: "s",
          message: { cliente: "${cliente}", dias: "${atraso_dias}" } as unknown as string,
        },
      }),
      { callTool: tools.callTool },
    );

    // Performs assertions.
    expect(tools.seen[1]?.args).toEqual({
      notices: [
        {
          key: "k-P-4",
          to: "a@example.com",
          subject: "s",
          message: { cliente: "Mini Mar", dias: "12" },
        },
      ],
    });
  });

  it("takes on_failure when a list it promised does not come", async () => {
    // Performs the test.
    const result = await run(lateOrders(), {
      callTool: fakeTools({ pedidos_atrasados: { ok: true, data: { total_filas: 0 } } }).callTool,
    });

    // Performs assertions.
    expect([result.status, result.endId]).toEqual(["delivered", "sin_datos"]);
    expect(result.text).toContain("'leer' no trajo la lista 'filas'");
  });

  it("refuses to count a classify that did not run, instead of taking zero", async () => {
    // Performs the test.
    const program = withStep("clasificar", { on_failure: "hay" });
    const withNull = {
      ok: true as const,
      data: { filas: [{ ...ORDERS[0], atraso_dias: null }], total_filas: 1 },
    };
    const result = await run(program, {
      callTool: fakeTools({ pedidos_atrasados: withNull }).callTool,
    });

    // Performs assertions.
    expect(result.reason).toContain(
      "no hay conteo de clasificar.grave, clasificar.leve: ese paso no corrió",
    );
  });

  it("keeps what it wrote when a step without a tool loses a group, for its owner to read", async () => {
    // Performs the test.
    const result = await run(agentic({ tool: undefined, per_group: undefined }), {
      callModel: async ({ group }) => {
        if (group === "sur") {
          throw new Error("sin cupo");
        }
        return "Resumen del norte";
      },
    });

    // Performs assertions.
    expect([result.status, result.delivery]).toEqual(["failed", null]);
    expect(result.text).toContain("Lo que sí se redactó:\nResumen del norte");
  });

  it("names the lost groups in the same order however their turns end", async () => {
    // Performs the test.
    const result = await run(agentic({ tool: undefined, per_group: undefined }), {
      callModel: async ({ group }) => {
        await new Promise((done) => setTimeout(done, group === "norte" ? 20 : 0));
        throw new Error(`sin cupo en ${group}`);
      },
    });

    // Performs assertions.
    expect(result.reason).toMatch(/norte: .*sin cupo en norte.*, sur: .*sin cupo en sur/);
  });

  it("drops a group named like a property every object has, unless the owner listed it", async () => {
    // Performs the test.
    const odd = {
      ok: true as const,
      data: { filas: [{ ...ORDERS[0], ruta: "constructor" }, ORDERS[2]], total_filas: 2 },
    };
    const tools = fakeTools({ pedidos_atrasados: odd });
    const result = await run(agentic({}), {
      callTool: tools.callTool,
      callModel: async ({ group }) => `Aviso ${group}`,
    });

    // Performs assertions.
    expect(result.counts["avisar.without_recipient"]).toBe(1);
    expect(tools.seen[1]?.args).toEqual({
      notices: [expect.objectContaining({ to: "norte@example.com" })],
    });
  });
});
