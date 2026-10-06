import { describe, expect, it } from "vitest";
import { contractOf } from "../../src/programs/contracts.js";
import type { Program, ProgramNode } from "../../src/programs/language.js";
import { judgeProgram } from "../../src/programs/validate.js";
import { CATALOG, lateOrders, TOOLS } from "./fixtures.js";

/**
 * Judges the demo program with one step changed
 *
 * @param   id    Step id
 * @param   step  The new fields
 *
 * @return  The errors
 */
function errorsWith(id: string, step: Partial<ProgramNode>): string[] {
  const program = lateOrders();
  program.nodes = program.nodes.map((node) => (node.id === id ? { ...node, ...step } : node));

  return judgeProgram(program, CATALOG).errors;
}

/**
 * Judges the demo program with its edges changed
 *
 * @param   change  What to do to the edges
 *
 * @return  The errors
 */
function errorsWithEdges(change: (program: Program) => Program["edges"]): string[] {
  const program = lateOrders();
  program.edges = change(program);

  return judgeProgram(program, CATALOG).errors;
}

describe("judging a program", () => {
  it("passes the demo program clean", () => {
    // Performs the test.
    const verdict = judgeProgram(lateOrders(), CATALOG);

    // Performs assertions.
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toEqual([]);
  });

  it("reads the contract of a tool from the schemas the assistant publishes", () => {
    // Performs the test.
    const orders = contractOf(TOOLS[0] as (typeof TOOLS)[number]);
    const notice = contractOf(TOOLS[2] as (typeof TOOLS)[number]);

    // Performs assertions.
    expect(orders).toEqual({
      lists: [{ name: "filas", fields: ["pedido", "cliente", "ruta", "atraso_dias", "monto"] }],
      aggregates: ["total_filas"],
      params: ["dias"],
      required: ["dias"],
      batch: null,
    });
    expect(notice.batch).toEqual({
      name: "notices",
      fields: ["key", "to", "subject", "message"],
      required: ["key", "to", "subject", "message"],
      nonText: [],
      max: 2,
    });
  });

  it("refuses a shape that does not parse, saying where", () => {
    // Performs the test.
    const verdict = judgeProgram({ nodes: [{ id: "Inicio", type: "begin" }], edges: [] }, CATALOG);

    // Performs assertions.
    expect(verdict.program).toBeNull();
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        "nodes.0.id: El id de un paso va en minúsculas, sin espacios",
        expect.stringContaining("nodes.0.type"),
      ]),
    );
  });

  it("names a graph that loops, has a step nobody reaches, or an end without a status", () => {
    // Performs the test.
    const looping = errorsWithEdges((program) => [
      ...program.edges,
      { from: "avisar", to: "leer" },
    ]);
    const island = (() => {
      const program = lateOrders();
      program.nodes.push({
        id: "suelto",
        type: "end",
        title: "Nadie llega",
        status: "no_findings",
      });
      return judgeProgram(program, CATALOG).errors;
    })();
    const noStatus = errorsWith("listo", { status: undefined });

    // Performs assertions.
    expect(looping).toEqual(
      expect.arrayContaining([
        "El paso 'avisar' tiene que llevar a exactamente un paso siguiente",
        "El programa vuelve sobre sí mismo: un programa no tiene ciclos",
      ]),
    );
    expect(island).toEqual(["El paso 'suelto' no se alcanza desde el inicio"]);
    expect(noStatus).toEqual([
      "El final 'listo' no dice cómo termina (delivered, no_findings o failed)",
    ]);
  });

  it("refuses a tool its owner cannot use", () => {
    // Performs the test.
    const errors = errorsWith("leer", { tool: "nomina" });

    // Performs assertions.
    expect(errors).toEqual(["'leer' usa 'nomina', que la persona dueña no puede usar"]);
  });

  it("names a decision way out with neither condition nor otherwise, and a second otherwise", () => {
    // Performs the test.
    const neither = errorsWithEdges((program) =>
      program.edges.map((edge) =>
        edge.otherwise ? { from: edge.from, to: edge.to, label: "no" } : edge,
      ),
    );
    const twice = errorsWithEdges((program) =>
      program.edges.map((edge) =>
        edge.condition ? { from: edge.from, to: edge.to, label: "sí", otherwise: true } : edge,
      ),
    );

    // Performs assertions.
    expect(neither).toEqual([
      "'hay' → 'nada' necesita una condición o ser 'otherwise', y no las dos",
    ]);
    expect(twice).toEqual(["La decisión 'hay' tiene más de una salida 'otherwise'"]);
  });

  it("names a condition that counts something that is not a class, or reads a value the query lacks", () => {
    // Performs the test.
    const count = errorsWithEdges((program) =>
      program.edges.map((edge) =>
        edge.condition
          ? { ...edge, condition: { count: ["clasificar.urgente"], op: ">", value: 0 } }
          : edge,
      ),
    );
    const field = errorsWithEdges((program) =>
      program.edges.map((edge) =>
        edge.condition ? { ...edge, condition: { field: "leer.total", op: ">", value: 0 } } : edge,
      ),
    );

    // Performs assertions.
    expect(count).toEqual(["La clase 'urgente' no existe en 'clasificar'"]);
    expect(field).toEqual([
      "'total' no es un valor que devuelva pedidos_atrasados (devuelve: total_filas)",
    ]);
  });

  it("asks for one rest class at the end, and a field the rows carry", () => {
    // Performs the test.
    const noRest = errorsWith("clasificar", {
      classes: [
        { name: "grave", op: ">=", value: 7 },
        { name: "leve", op: ">=", value: 3 },
      ],
    });
    const restFirst = errorsWith("clasificar", {
      classes: [
        { name: "al_dia", rest: true },
        { name: "grave", op: ">=", value: 7 },
        { name: "leve", op: ">=", value: 3 },
      ],
      exceptions: undefined,
    });
    const wrongField = errorsWith("clasificar", { by: "atraso" });

    // Performs assertions.
    expect(noRest).toEqual(["'clasificar' necesita exactamente una clase rest, y al final"]);
    expect(restFirst).toEqual(["'clasificar' necesita exactamente una clase rest, y al final"]);
    expect(wrongField).toEqual(["'clasificar' clasifica por 'atraso', que sus filas no traen"]);
  });

  it("checks a per-row action's limit, templates, classes and what the tool needs", () => {
    // Performs the test.
    const errors = errorsWith("avisar", {
      limit: undefined,
      only: ["urgente"],
      per_row: { key: "k-${pedido}", to: "${correo}", subject: "s", texto: "x" },
    });

    // Performs assertions.
    expect(errors).toEqual([
      "'avisar' va fila por fila sin 'limit': un paso por caso no queda abierto",
      "'avisar' se queda con la clase 'urgente', que sus filas no traen",
      "La plantilla de 'avisar' usa ${correo}, que sus filas no traen",
      "'avisar' manda 'texto', que send_notice no recibe en cada elemento",
      "A 'avisar' le falta lo que send_notice pide en cada elemento: message",
    ]);
  });

  it("asks a query for the parameters its tool always needs", () => {
    // Performs the test.
    const errors = errorsWith("leer", { params: {} });

    // Performs assertions.
    expect(errors).toEqual(["A 'leer' le falta lo que pedidos_atrasados pide siempre: dias"]);
  });

  it("refuses rows taken from a step some path skips, and a field the rows no longer carry", () => {
    // Performs the test.
    const errors = errorsWith("avisar", { from: "leer.filas", only: undefined });
    const skipped = (() => {
      const program = lateOrders();
      program.nodes.push({
        id: "otra",
        type: "query",
        title: "Otra consulta",
        tool: "rutas",
      });
      program.edges = program.edges.map((edge) =>
        edge.otherwise ? { ...edge, to: "otra" } : edge,
      );
      program.edges.push({ from: "otra", to: "nada" });
      program.nodes = program.nodes.map((node) =>
        node.id === "avisar" ? { ...node, from: "otra.filas", only: undefined } : node,
      );
      return judgeProgram(program, CATALOG).errors;
    })();

    // Performs assertions.
    expect(errors).toEqual(["La plantilla de 'avisar' usa ${class}, que sus filas no traen"]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        "'avisar' toma filas de 'otra', pero hay caminos que llegan sin pasar por él",
      ]),
    );
  });

  it("checks an agentic step: tool and per_group together, groups, limit and what each item uses", () => {
    // Performs the test.
    const base: Partial<ProgramNode> = {
      per_row: undefined,
      order_by: undefined,
      agentic: { instruction: "Escribe un aviso breve para el responsable de la ruta" },
    };
    const half = errorsWith("avisar", { ...base, per_group: undefined });
    const items = errorsWith("avisar", {
      ...base,
      group_by: "ruta",
      limit: 1,
      per_group: {
        fields: {
          key: "k-${group}",
          to: "${recipient}",
          subject: "${cliente}",
          message: "${message}",
        },
        recipients: { norte: "a@example.com", sur: "b@example.com" },
      },
    });

    // Performs assertions.
    expect(half).toEqual([
      "'avisar' redacta: o declara herramienta y 'per_group', o ninguna de las dos y su texto es la entrega",
    ]);
    expect(items).toEqual([
      "'avisar' tiene limit 1 y declara 2 grupos con destinatario: los que pasen del límite no recibirían nada",
      "'avisar' usa ${cliente} por grupo, y ahí solo existen ${group}, ${message}, ${recipient}",
    ]);
  });

  it("refuses an instruction that fixes a length nobody measured", () => {
    // Performs the test.
    const errors = errorsWith("avisar", {
      per_row: undefined,
      tool: undefined,
      agentic: { instruction: "Resume el día en un máximo de 300 caracteres" },
    });

    // Performs assertions.
    expect(errors).toEqual([
      expect.stringContaining("La instrucción no fija un largo en caracteres o palabras"),
    ]);
  });

  it("checks a join's keys, its new columns and what happens to a row with no pair", () => {
    // Performs the test.
    const program = lateOrders();
    program.nodes.splice(
      2,
      0,
      { id: "leer_rutas", type: "query", title: "Leer rutas", tool: "rutas" },
      {
        id: "cruzar",
        type: "join",
        title: "Agregar responsable",
        from: "leer.filas",
        with: "leer_rutas.filas",
        by: "zona",
        adds: { cliente: "responsable", jefe: "jefe" },
      },
    );
    program.edges = program.edges.map((edge) =>
      edge.from === "leer" ? { from: "leer", to: "leer_rutas" } : edge,
    );
    program.edges.push({ from: "leer_rutas", to: "cruzar" }, { from: "cruzar", to: "clasificar" });
    const verdict = judgeProgram(program, CATALOG);

    // Performs assertions.
    expect(verdict.errors).toEqual([
      "'cruzar' no dice qué pasa con una fila sin pareja ('blank' o 'drop')",
      "'cruzar' cruza por 'zona', que sus filas no traen",
      "'cruzar' cruza con 'zona', que la otra lista no trae",
      "'cruzar' agrega 'cliente', y sus filas ya traen un campo con ese nombre",
      "'cruzar' agrega 'jefe', que la otra lista no trae",
    ]);
    expect(verdict.warnings).toEqual([
      "Ningún paso usa lo que 'cruzar' trae: o falta conectarlo, o sobra",
    ]);
  });

  it("refuses a step that reads from the one whose failure brought it there", () => {
    // Performs the test.
    const errors = errorsWith("clasificar", { on_failure: "avisar" });

    // Performs assertions.
    expect(errors).toEqual(
      expect.arrayContaining([
        "'avisar' toma filas de 'clasificar', pero hay caminos que llegan sin pasar por él",
      ]),
    );
  });

  it("refuses comparing a text by order, ordering days, and choices outside a decision", () => {
    // Performs the test.
    const textOrder = errorsWith("clasificar", {
      classes: [
        { name: "grave", op: ">=", value: "7" as unknown as number },
        { name: "resto", rest: true },
      ],
    });
    const dayOrder = errorsWithEdges((program) =>
      program.edges.map((edge) =>
        edge.condition ? { ...edge, condition: { day: true, op: ">", value: 3 } } : edge,
      ),
    );
    const outside = errorsWithEdges((program) =>
      program.edges.map((edge) =>
        edge.from === "leer"
          ? { ...edge, condition: { day: true, op: "==", value: "monday" } }
          : edge,
      ),
    );

    // Performs assertions.
    expect(textOrder).toEqual([expect.stringContaining("contra un número")]);
    expect(dayOrder).toEqual(
      expect.arrayContaining([
        "La condición de 'hay' compara el día con algo que no es un día",
        "La condición de 'hay' ordena días, y un día solo es igual o distinto",
      ]),
    );
    expect(outside).toEqual([
      "'leer' no es una decisión: su salida no lleva condición ni 'otherwise'",
    ]);
  });

  it("refuses a repeated class name", () => {
    // Performs the test.
    const errors = errorsWith("clasificar", {
      classes: [
        { name: "grave", op: ">=", value: 7 },
        { name: "grave", op: ">=", value: 3 },
        { name: "al_dia", rest: true },
      ],
    });

    // Performs assertions.
    expect(errors).toEqual(expect.arrayContaining(["'clasificar' repite el nombre de una clase"]));
  });

  it("refuses filling with text a field the tool takes as a number", () => {
    // Performs the test.
    const numbered = contractOf({
      name: "send_notice",
      inputSchema: {
        type: "object",
        properties: {
          notices: {
            type: "array",
            maxItems: 0,
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                to: { type: "string" },
                subject: { type: "string" },
                message: { type: "string" },
                priority: { type: "integer" },
              },
            },
          },
        },
      },
    });
    const program = lateOrders();
    program.nodes = program.nodes.map((node) =>
      node.id === "avisar"
        ? { ...node, per_row: { ...node.per_row, priority: "${atraso_dias}" } }
        : node,
    );
    const errors = judgeProgram(program, new Map([...CATALOG, ["send_notice", numbered]])).errors;

    // Performs assertions.
    expect(numbered.batch).toMatchObject({ nonText: ["priority"], max: null });
    expect(errors).toEqual([
      "'avisar' llena 'priority' con texto, y send_notice espera ahí otro tipo de dato",
    ]);
  });

  it("leaves out of the values a condition can read the notes the assistant's cap adds", () => {
    // Performs the test.
    const contract = contractOf({
      name: "x",
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        properties: {
          total: { type: "integer" },
          nota: { type: "string" },
          nota_filtro: { type: "string" },
        },
      },
    });

    // Performs assertions.
    expect(contract.aggregates).toEqual(["total"]);
  });
});
