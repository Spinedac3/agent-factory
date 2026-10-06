import { contractOf, type ToolSchemas } from "../../src/programs/contracts.js";
import type { Program } from "../../src/programs/language.js";
import type { CallTool, ToolAnswer } from "../../src/programs/run.js";
import type { Catalog } from "../../src/programs/validate.js";

// Tools shaped as the assistant publishes them over MCP: a created tool and send_notice
export const TOOLS: ToolSchemas[] = [
  {
    name: "pedidos_atrasados",
    inputSchema: {
      type: "object",
      properties: { dias: { type: "integer" } },
      required: ["dias"],
    },
    outputSchema: {
      type: "object",
      properties: {
        filas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pedido: { type: ["string", "null"] },
              cliente: { type: ["string", "null"] },
              ruta: { type: ["string", "null"] },
              atraso_dias: { type: ["number", "null"] },
              monto: { type: ["number", "null"] },
            },
          },
        },
        total_filas: { type: "integer" },
      },
    },
  },
  {
    name: "rutas",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        filas: {
          type: "array",
          items: {
            type: "object",
            properties: { ruta: { type: "string" }, responsable: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "send_notice",
    inputSchema: {
      type: "object",
      properties: {
        notices: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              to: { type: "string" },
              subject: { type: "string" },
              message: { type: "string" },
            },
            required: ["key", "to", "subject", "message"],
          },
        },
      },
      required: ["notices"],
    },
  },
];

export const CATALOG: Catalog = new Map(TOOLS.map((tool) => [tool.name, contractOf(tool)]));

export const ORDERS = [
  { pedido: "P-1", cliente: "Abarrotes Luna", ruta: "norte", atraso_dias: 9, monto: 120 },
  { pedido: "P-2", cliente: "Tienda Sol", ruta: "sur", atraso_dias: 2, monto: 80 },
  { pedido: "P-3", cliente: "Super Rey", ruta: "norte", atraso_dias: 5, monto: 300 },
  { pedido: "P-4", cliente: "Mini Mar", ruta: "sur", atraso_dias: 12, monto: 45 },
];

/**
 * Builds the demo program: read late orders, classify them, and warn per row about the late ones
 *
 * @return  The program
 */
export function lateOrders(): Program {
  return {
    nodes: [
      { id: "inicio", type: "start", title: "Cada mañana" },
      {
        id: "leer",
        type: "query",
        title: "Leer pedidos atrasados",
        tool: "pedidos_atrasados",
        params: { dias: 1 },
        on_failure: "sin_datos",
      },
      {
        id: "clasificar",
        type: "classify",
        title: "Separar por atraso",
        from: "leer.filas",
        by: "atraso_dias",
        classes: [
          { name: "grave", op: ">=", value: 7, severity: "high" },
          { name: "leve", op: ">=", value: 3, severity: "medium" },
          { name: "al_dia", rest: true },
        ],
        exceptions: [{ if: { day: "monday" }, degrade: { from: "grave", to: "leve" } }],
      },
      { id: "hay", type: "decision", title: "¿Hay atrasados?" },
      {
        id: "avisar",
        type: "action",
        title: "Avisar cada atrasado",
        tool: "send_notice",
        from: "clasificar",
        only: ["grave", "leve"],
        order_by: "atraso_dias",
        order: "desc",
        limit: 10,
        per_row: {
          key: "atraso-${pedido}",
          to: "bodega@example.com",
          subject: "Pedido ${pedido} atrasado",
          message: "${cliente}: ${atraso_dias} días (${class})",
        },
      },
      { id: "listo", type: "end", title: "Avisado", status: "delivered" },
      {
        id: "nada",
        type: "end",
        title: "Sin atrasos",
        status: "no_findings",
        text: "Hoy no hay pedidos atrasados",
      },
      {
        id: "sin_datos",
        type: "end",
        title: "No se pudo leer",
        status: "delivered",
        text: "No se pudieron leer los pedidos atrasados",
      },
    ],
    edges: [
      { from: "inicio", to: "leer" },
      { from: "leer", to: "clasificar" },
      { from: "clasificar", to: "hay" },
      {
        from: "hay",
        to: "avisar",
        label: "sí",
        condition: { count: ["clasificar.grave", "clasificar.leve"], op: ">", value: 0 },
      },
      { from: "hay", to: "nada", label: "no", otherwise: true },
      { from: "avisar", to: "listo" },
    ],
  };
}

/**
 * Builds fake tools that answer from a table and record every call
 *
 * @param   answers  What each tool answers, or a function of its arguments
 *
 * @return  The caller and the calls it saw
 */
export function fakeTools(
  answers: Record<string, ToolAnswer | ((args: Record<string, unknown>) => ToolAnswer)>,
): { callTool: CallTool; seen: Array<{ tool: string; args: Record<string, unknown> }> } {
  const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];

  return {
    seen,
    callTool: async (tool, args) => {
      seen.push({ tool, args });
      const answer = answers[tool] ?? { ok: true, data: { queued: true } };
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
}
