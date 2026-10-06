import { z } from "zod";

// The whole language, closed on purpose: every check on publish is cheap because it is this small,
// and anything it cannot say goes in an agentic step, never in a new feature of the graph
export const NODE_TYPES = [
  "start",
  "query",
  "decision",
  "classify",
  "join",
  "action",
  "end",
] as const;
export const OPERATORS = ["<", "<=", ">", ">=", "==", "!=", "in", "not in"] as const;
export const LIST_OPERATORS = ["in", "not in"] as const;
export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const SEVERITIES = ["info", "medium", "high"] as const;
export const END_STATUSES = ["delivered", "no_findings", "failed"] as const;

// The one group of an agentic step that does not group: everything it sees
export const SINGLE_GROUP = "all";

const SLUG = /^[a-z][a-z0-9_-]{0,30}$/;
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const value = z.union([z.number(), z.string(), z.array(z.string()).min(1)]);
// A length fixed in the instruction is a number nobody measured; the tone says how long
const LENGTH_IN_PROSE =
  /\d[\d.,]*\s*(car[aá]cteres|chars?|characters|palabras|words)\b|m[aá]ximo\s+(de\s+)?\d/i;

/**
 * Tells whether an operator compares against a list of texts
 *
 * @param   op  The operator
 *
 * @return  Whether it does
 */
function takesList(op: (typeof OPERATORS)[number]): boolean {
  return (LIST_OPERATORS as readonly string[]).includes(op);
}

export const conditionSchema = z
  .object({
    // `step.aggregate` of a query
    field: z.string().optional(),
    // `step.class` of a classify, summed
    count: z.array(z.string()).min(1).optional(),
    day: z.literal(true).optional(),
    op: z.enum(OPERATORS),
    value,
  })
  .strict()
  .refine(
    (condition) =>
      [condition.field, condition.count, condition.day].filter((source) => source !== undefined)
        .length === 1,
    "Una condición mira exactamente una cosa: field, count o day",
  )
  .refine(
    (condition) => Array.isArray(condition.value) === takesList(condition.op),
    "'in' y 'not in' comparan contra una lista de textos; los demás, contra un solo valor",
  );

export const classSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, "Una clase se nombra en minúsculas"),
    op: z.enum(OPERATORS).optional(),
    value: value.optional(),
    // The class that takes whatever no other one took, so every row lands somewhere
    rest: z.literal(true).optional(),
    severity: z.enum(SEVERITIES).optional(),
  })
  .strict()
  .refine(
    (item) => (item.rest === true) !== (item.op !== undefined && item.value !== undefined),
    "Una clase tiene op y value, o es rest; no las dos cosas ni ninguna",
  )
  .refine(
    (item) => item.op === undefined || Array.isArray(item.value) === takesList(item.op),
    "'in' y 'not in' comparan contra una lista de textos; los demás, contra un solo valor",
  );

export const summarizeSchema = z
  .object({
    by: z.array(z.string()).min(1),
    sum: z.array(z.string()).optional(),
    top: z
      .object({
        field: z.string(),
        n: z.number().int().min(1),
        // The field holds several values in one text, each counted on its own
        separator: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    // Within each group, the rows with the lowest or highest value of a field
    rank: z
      .object({
        field: z.string(),
        n: z.number().int().min(1),
        order: z.enum(["asc", "desc"]),
        show: z.array(z.string()).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const nodeSchema = z
  .object({
    id: z.string().regex(SLUG, "El id de un paso va en minúsculas, sin espacios"),
    type: z.enum(NODE_TYPES),
    // It is drawn on the flow, so it has a length
    title: z.string().min(3).max(120),
    tool: z.string().min(1).optional(),
    params: z.record(z.string(), z.union([scalar, z.array(scalar)])).optional(),
    // `step` or `step.list`: where its rows come from
    from: z.string().optional(),
    on_failure: z.string().optional(),
    // [classify] the field it cuts by; [join] the key on the left
    by: z.string().optional(),
    classes: z.array(classSchema).min(2).optional(),
    exceptions: z
      .array(
        z
          .object({
            if: z.object({ day: z.enum(DAYS) }).strict(),
            degrade: z.object({ from: z.string(), to: z.string() }).strict(),
          })
          .strict(),
      )
      .optional(),
    // [classify] the class a null value takes, or "drop"; without it a null fails the run
    if_null: z.string().optional(),
    // [join] the other list, its key, the columns it brings and what happens to a row with no pair
    with: z.string().optional(),
    with_by: z.string().optional(),
    adds: z.record(z.string(), z.string()).optional(),
    if_missing: z.enum(["blank", "drop"]).optional(),
    // [action] keep only these classes, in this order, up to this many rows or groups
    only: z.array(z.string()).optional(),
    order_by: z.string().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().min(1).optional(),
    // [action] one batch call, one item per row, filled from `${field}` templates
    per_row: z
      .record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
      .optional(),
    // [action] one call with fixed arguments
    once: z.record(z.string(), scalar).optional(),
    // [action, agentic] one model turn per group of rows
    group_by: z.string().optional(),
    summarize: summarizeSchema.optional(),
    agentic: z
      .object({
        instruction: z
          .string()
          .min(20)
          .refine(
            (text) => !LENGTH_IN_PROSE.test(text),
            "La instrucción no fija un largo en caracteres o palabras: el tono dice cuánto ('breve', 'tres líneas')",
          ),
      })
      .strict()
      .optional(),
    // [action, agentic] each item of the tool's batch, from `${group}`, `${message}` and `${recipient}`
    per_group: z
      .object({
        fields: z.record(z.string(), z.string()),
        // Who receives each group's message; a group not here is not written
        recipients: z
          .record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]))
          .optional(),
      })
      .strict()
      .optional(),
    // [end]
    status: z.enum(END_STATUSES).optional(),
    text: z.string().optional(),
  })
  .strict();

export const edgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    // Drawn over the arrow of a decision, so it has a length
    label: z.string().max(40).optional(),
    condition: conditionSchema.optional(),
    // The way out for whatever no condition took; at most one per decision
    otherwise: z.literal(true).optional(),
  })
  .strict();

export const programSchema = z
  .object({
    nodes: z
      .array(nodeSchema)
      .min(1)
      .max(30, "Un programa de más de 30 pasos nadie lo revisa entero: pártelo en dos"),
    edges: z
      .array(edgeSchema)
      .max(60, "Más de 60 conexiones no se revisan enteras: parte el programa en dos"),
  })
  .strict();

export type ProgramNode = z.infer<typeof nodeSchema>;
export type ProgramEdge = z.infer<typeof edgeSchema>;
export type Program = z.infer<typeof programSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Summarize = z.infer<typeof summarizeSchema>;
export type Day = (typeof DAYS)[number];
export type EndStatus = (typeof END_STATUSES)[number];
