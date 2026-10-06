import { stepOf } from "./graph.js";
import {
  type Condition,
  type Day,
  type EndStatus,
  type Program,
  type ProgramEdge,
  type ProgramNode,
  SINGLE_GROUP,
} from "./language.js";
import { summarizedRows, summaryLines } from "./summarize.js";
import type { Catalog } from "./validate.js";

export type ToolAnswer =
  | { ok: true; data: unknown }
  | { ok: false; error: string; message: string };

export type CallTool = (tool: string, args: Record<string, unknown>) => Promise<ToolAnswer>;

// One model turn of an agentic step: it reads only its group's data and writes the text
export type CallModel = (turn: {
  group: string;
  instruction: string;
  data: string;
  attempt: 1 | 2;
}) => Promise<string>;

export interface StepCall {
  step: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string | null;
}

export interface RunResult {
  status: EndStatus;
  // Why it failed, said so the owner can act on it
  reason: string | null;
  endId: string | null;
  text: string;
  // What the agentic steps without a tool wrote: the run's own message
  delivery: string | null;
  calls: StepCall[];
  counts: Record<string, number>;
  steps: string[];
}

export interface RunOptions {
  program: Program;
  catalog: Catalog;
  // The run's day, date and time in its zone: the only things from outside, given at the start
  day: Day;
  date: string;
  time: string;
  callTool: CallTool;
  callModel?: CallModel;
  pause?: (ms: number) => Promise<void>;
  onStep?: (stepId: string) => void;
}

type Row = Record<string, unknown>;

// What one agentic turn may read: what the model takes without a prompt that is too long
export const MAX_MODEL_DATA_BYTES = 400_000;
// Turns written at the same time
const BATCH_OF_TURNS = 4;
// Rejections that come from how the step is built, so every run would get them again
const DEFINITIVE = new Set(["invalid_arguments", "missing_scope", "invalid_filter"]);

/**
 * A step that cannot go on; it takes the step's on_failure, or ends the run as failed
 */
class StepFailure extends Error {
  /**
   * Builds the failure of a step
   *
   * @param   step        Where it happened
   * @param   message     What happened, for the owner
   * @param   definitive  Whether it would happen on every run, so on_failure does not apply
   */
  constructor(
    public readonly step: ProgramNode,
    message: string,
    public readonly definitive = false,
  ) {
    super(message);
  }
}

/**
 * Compares two values with the closed set of operators; anything but equality needs numbers
 *
 * @param   left   The value read
 * @param   op     The operator
 * @param   right  The value declared
 *
 * @return  Whether it holds
 */
export function compare(left: unknown, op: string, right: unknown): boolean {
  if (op === "==" || op === "!=") {
    return (String(left) === String(right)) === (op === "==");
  }
  if (op === "in" || op === "not in") {
    const inside = Array.isArray(right) && right.some((item) => String(item) === String(left));
    return inside === (op === "in");
  }
  if (typeof left !== "number" || typeof right !== "number" || !Number.isFinite(left)) {
    throw new Error(`no se puede comparar ${JSON.stringify(left)} ${op} ${JSON.stringify(right)}`);
  }
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      throw new Error(`operador desconocido: ${op}`);
  }
}

/**
 * Runs a program from start to end. With the same tool answers it takes the same path and writes
 * the same calls: nothing is skipped, nothing is improvised
 *
 * @param   options  The program, its tools, the day and how to call tools and the model
 *
 * @return  How it ended, with every call and step
 */
export async function runProgram(options: RunOptions): Promise<RunResult> {
  return new Walker(options).walk();
}

/**
 * The state of one run while it walks the program
 */
class Walker {
  private readonly byId: Map<string, ProgramNode>;
  // The output of each step lives only under its id, so no step can overwrite another's
  private readonly outputs = new Map<string, unknown>();
  private readonly counts: Record<string, number> = {};
  private readonly calls: StepCall[] = [];
  private readonly steps: string[] = [];
  private delivery: string | null = null;
  private pendingReason: string | null = null;

  /**
   * Prepares the walk
   *
   * @param   options  The program, its tools, the day and the callers
   */
  constructor(private readonly options: RunOptions) {
    this.byId = new Map(options.program.nodes.map((node) => [node.id, node]));
  }

  /**
   * Walks from the start until an end, a failure or a step with nowhere to go
   *
   * @return  The run's result
   */
  async walk(): Promise<RunResult> {
    const { program } = this.options;
    let current = program.nodes.find((node) => node.type === "start") ?? null;
    if (!current) {
      return this.failed(null, "el programa no tiene inicio");
    }
    // An acyclic program never takes more steps than it has
    const most = program.nodes.length + 2;
    while (current !== null) {
      if (this.steps.length >= most) {
        return this.failed(null, "el programa dio más pasos de los que tiene");
      }
      this.steps.push(current.id);
      this.options.onStep?.(current.id);
      if (current.type === "end") {
        return this.finish(current);
      }
      try {
        if (current.type === "decision") {
          const chosen = this.decide(current);
          if (!chosen) {
            return this.failed(
              current.id,
              `ninguna condición de '${current.id}' se cumplió y no hay salida 'otherwise' (conteos: ${JSON.stringify(this.counts)})`,
            );
          }
          current = this.byId.get(chosen.to) ?? null;
          continue;
        }
        await this.perform(current);
      } catch (error) {
        if (!(error instanceof StepFailure)) {
          throw error;
        }
        const branch =
          !error.definitive && error.step.on_failure !== undefined
            ? this.byId.get(error.step.on_failure)
            : undefined;
        if (!branch) {
          return this.failed(error.step.id, error.message);
        }
        this.pendingReason = error.message;
        current = branch;
        continue;
      }
      const next = program.edges.find((edge) => edge.from === (current as ProgramNode).id);
      current = next ? (this.byId.get(next.to) ?? null) : null;
    }

    return this.failed(null, "el programa se quedó sin camino antes de un final");
  }

  /**
   * Does what one step does, keeping its output under its id
   *
   * @param   node  The step
   */
  private async perform(node: ProgramNode): Promise<void> {
    switch (node.type) {
      case "query":
        this.outputs.set(node.id, await this.call(node, (node.params ?? {}) as Row));
        break;
      case "classify":
        this.outputs.set(node.id, this.classify(node));
        break;
      case "join":
        this.outputs.set(node.id, this.join(node));
        break;
      case "action":
        if (node.agentic !== undefined) {
          await this.write(node);
        } else if (node.per_row !== undefined) {
          await this.perRow(node);
        } else {
          await this.call(node, { ...(node.params ?? {}), ...(node.once ?? {}) } as Row);
        }
        break;
      default:
        break;
    }
  }

  /**
   * Calls a step's tool and records the call
   *
   * @param   node  The step
   * @param   args  The arguments
   *
   * @return  What the tool returned
   */
  private async call(node: ProgramNode, args: Row): Promise<unknown> {
    const tool = node.tool as string;
    const answer = await this.options.callTool(tool, args).catch(
      (error: unknown): ToolAnswer => ({
        ok: false,
        error: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    this.calls.push({
      step: node.id,
      tool,
      args,
      ok: answer.ok,
      error: answer.ok ? null : answer.error,
    });
    if (!answer.ok) {
      const definitive = DEFINITIVE.has(answer.error);
      throw new StepFailure(
        node,
        definitive
          ? `${tool} rechaza lo que '${node.id}' le pide y lo va a rechazar en toda corrida (${answer.error}): ${answer.message} — hay que arreglar el paso`
          : `${tool} falló en '${node.id}': ${answer.message}`,
        definitive,
      );
    }

    return answer.data;
  }

  /**
   * Reads the rows a reference points to: a list of a query, the rows of a classify or join, or
   * one class of a classify
   *
   * @param   node       The step that reads
   * @param   reference  `step`, `step.list` or `classify.class`
   *
   * @return  The rows
   */
  private rowsOf(node: ProgramNode, reference: string): Row[] {
    const [stepId, part] = reference.split(".", 2) as [string, string | undefined];
    const output = this.outputs.get(stepId);
    if (output === undefined) {
      throw new StepFailure(
        node,
        `'${node.id}' necesita lo que trajo '${stepId}', y ese paso no corrió`,
      );
    }
    let list: unknown;
    if (Array.isArray(output)) {
      list = part === undefined ? output : output.filter((row) => (row as Row).class === part);
    } else {
      const source = this.byId.get(stepId);
      const name =
        part ?? (source?.tool ? this.options.catalog.get(source.tool)?.lists[0]?.name : undefined);
      list = name === undefined ? undefined : (output as Row)[name];
    }
    // The tool changed under the program: a list it promised did not come
    if (!Array.isArray(list)) {
      throw new StepFailure(
        this.byId.get(stepId) ?? node,
        `'${stepId}' no trajo la lista '${part ?? "(filas)"}': la herramienta cambió debajo del programa`,
      );
    }

    return list as Row[];
  }

  /**
   * Fails when the first row lacks a field the program reads: with fixed parameters it would be
   * missing on every run
   *
   * @param   source  The step the rows came from
   * @param   rows    The rows
   * @param   fields  The fields read
   */
  private requireFields(source: ProgramNode, rows: Row[], fields: string[]): void {
    const first = rows[0];
    for (const field of fields.filter((item) => first !== undefined && !(item in first))) {
      throw new StepFailure(
        source,
        `las filas de '${source.id}' ya no traen '${field}': la herramienta cambió debajo del programa`,
        true,
      );
    }
  }

  /**
   * Puts each row in the first class whose cut it meets, or in the rest; applies the exceptions of
   * the day and counts each class
   *
   * @param   node  The classify
   *
   * @return  The rows with their class and severity
   */
  private classify(node: ProgramNode): Row[] {
    const raw = this.rowsOf(node, node.from as string);
    const field = node.by as string;
    const rows = node.summarize ? summarizedRows(raw, node.summarize) : raw;
    if (!node.summarize) {
      this.requireFields(this.byId.get(stepOf(node.from as string)) ?? node, raw, [field]);
    }
    const classes = node.classes ?? [];
    const severityOf = (name: string) => classes.find((item) => item.name === name)?.severity;
    const out: Row[] = [];
    for (const row of rows) {
      const value = row[field];
      let name: string | undefined;
      if (value === null || value === undefined) {
        if (node.if_null === undefined) {
          throw new StepFailure(
            node,
            `'${node.id}' recibió un '${field}' vacío y no dice qué hacer con él`,
          );
        }
        if (node.if_null === "drop") {
          continue;
        }
        name = node.if_null;
      } else {
        name = classes.find((item) => {
          if (item.rest === true) {
            return false;
          }
          try {
            return compare(value, item.op as string, item.value);
          } catch {
            throw new StepFailure(
              node,
              `'${field}' trajo ${JSON.stringify(value)} y '${node.id}' lo compara con un número: la herramienta cambió debajo del programa`,
            );
          }
        })?.name;
        name ??= classes.find((item) => item.rest === true)?.name;
      }
      out.push({ ...row, class: name, severity: severityOf(name as string) });
    }
    for (const exception of node.exceptions ?? []) {
      if (exception.if.day !== this.options.day) {
        continue;
      }
      for (const row of out.filter((item) => item.class === exception.degrade.from)) {
        row.class = exception.degrade.to;
        row.severity = severityOf(exception.degrade.to);
      }
    }
    for (const item of classes) {
      this.counts[`${node.id}.${item.name}`] = out.filter((row) => row.class === item.name).length;
    }

    return out;
  }

  /**
   * Joins two lists this path already read, one to one by a key; a key twice on the right would
   * multiply rows, so it fails instead
   *
   * @param   node  The join
   *
   * @return  The left rows with the columns it adds
   */
  private join(node: ProgramNode): Row[] {
    const left = this.rowsOf(node, node.from as string);
    const right = this.rowsOf(node, node.with as string);
    const rightStep = stepOf(node.with as string);
    const key = node.by as string;
    const rightKey = node.with_by ?? key;
    const adds = Object.entries(node.adds ?? {});
    this.requireFields(this.byId.get(stepOf(node.from as string)) ?? node, left, [key]);
    this.requireFields(this.byId.get(rightStep) ?? node, right, [
      rightKey,
      ...adds.map(([, field]) => field),
    ]);
    const keyOf = (value: unknown) =>
      value === null || value === undefined ? "" : String(value).trim();
    const pairs = new Map<string, Row>();
    for (const row of right) {
      const id = keyOf(row[rightKey]);
      if (id === "") {
        continue;
      }
      if (pairs.has(id)) {
        throw new StepFailure(
          node,
          `'${node.id}' cruza uno a uno y '${rightStep}' trae más de una fila para '${id}': que la consulta agrupe por '${rightKey}'`,
        );
      }
      pairs.set(id, row);
    }
    const blanks = Object.fromEntries(adds.map(([name]) => [name, null]));
    const out: Row[] = [];
    let joined = 0;
    let unpaired = 0;
    for (const row of left) {
      const pair = pairs.get(keyOf(row[key]));
      if (pair === undefined) {
        unpaired += 1;
        if (node.if_missing === "blank") {
          out.push({ ...row, ...blanks });
        }
        continue;
      }
      joined += 1;
      out.push({
        ...row,
        ...Object.fromEntries(adds.map(([name, field]) => [name, pair[field] ?? null])),
      });
    }
    this.counts[`${node.id}.joined`] = joined;
    this.counts[`${node.id}.unpaired`] = unpaired;

    return out;
  }

  /**
   * Keeps an action's rows: only the classes it names, in the order it asks
   *
   * @param   node  The action
   *
   * @return  The rows
   */
  private keptRows(node: ProgramNode): Row[] {
    let rows = this.rowsOf(node, node.from as string);
    if (node.only !== undefined) {
      const only = new Set(node.only);
      rows = rows.filter((row) => only.has(row.class as string));
    }
    if (node.order_by !== undefined) {
      const field = node.order_by;
      const direction = node.order === "desc" ? -1 : 1;
      const isNumber = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value);
      // Rows without a number go last, never ahead of the ones that have one
      rows = [...rows].sort((a, b) => {
        const left = a[field];
        const right = b[field];
        if (!isNumber(left)) {
          return isNumber(right) ? 1 : 0;
        }
        return isNumber(right) ? (left - right) * direction : -1;
      });
    }

    return rows;
  }

  /**
   * Fills a template with a row's values; a missing field fails, a null shows as a dash
   *
   * @param   node      The step
   * @param   template  The template
   * @param   values    The row
   *
   * @return  The text
   */
  private fill(node: ProgramNode, template: string, values: Row): string {
    return template.replace(/\$\{([^}]+)\}/g, (_, raw: string) => {
      const field = raw.trim();
      if (!(field in values)) {
        throw new StepFailure(
          node,
          `la plantilla de '${node.id}' pide '${field}' y la fila no lo trae`,
        );
      }
      const value = values[field];
      return value === null || value === undefined ? "—" : String(value);
    });
  }

  /**
   * Sends the tool one item per row, in batches of the size it takes
   *
   * @param   node  The action
   */
  private async perRow(node: ProgramNode): Promise<void> {
    const rows = this.keptRows(node).slice(0, node.limit);
    if (rows.length === 0) {
      return;
    }
    const items = rows.map((row) =>
      Object.fromEntries(
        Object.entries(node.per_row ?? {}).map(([name, template]) => [
          name,
          typeof template === "string"
            ? this.fill(node, template, row)
            : Object.fromEntries(
                Object.entries(template).map(([key, text]) => [key, this.fill(node, text, row)]),
              ),
        ]),
      ),
    );
    await this.sendBatch(node, items);
  }

  /**
   * Calls a tool with its items, split into the batches it takes, with the step's fixed
   * parameters on each call
   *
   * @param   node   The action
   * @param   items  The items
   */
  private async sendBatch(node: ProgramNode, items: Row[]): Promise<void> {
    const batch = this.options.catalog.get(node.tool as string)?.batch;
    if (!batch) {
      throw new StepFailure(node, `${node.tool} ya no recibe una lista de elementos`, true);
    }
    const size = batch.max ?? items.length;
    for (let index = 0; index < items.length; index += size) {
      await this.call(node, {
        ...(node.params ?? {}),
        [batch.name]: items.slice(index, index + size),
      });
    }
  }

  /**
   * Writes one message per group, each turn seeing only its group's rows or their summary; with a
   * tool each message becomes items of it, without one it is the run's own text
   *
   * @param   node  The agentic action
   */
  private async write(node: ProgramNode): Promise<void> {
    if (!this.options.callModel) {
      throw new StepFailure(node, `'${node.id}' redacta y esta corrida no tiene modelo`);
    }
    const groups = this.groupsOf(node);
    const recipients = node.per_group?.recipients;
    if (recipients !== undefined) {
      // A group comes from the data: only a recipient the owner wrote counts, never an inherited one
      const without = [...groups.keys()].filter((group) => !Object.hasOwn(recipients, group));
      for (const group of without) {
        groups.delete(group);
      }
      if (without.length > 0) {
        this.counts[`${node.id}.without_recipient`] = without.length;
      }
    }
    // Alphabetical, so the same rows give the same groups and order on every run
    const keys = [...groups.keys()].sort().slice(0, node.limit);
    if (keys.length === 0) {
      return;
    }
    const written: Array<{ group: string; message: string }> = [];
    const lost: string[] = [];
    for (let index = 0; index < keys.length; index += BATCH_OF_TURNS) {
      const turns = await Promise.all(
        keys.slice(index, index + BATCH_OF_TURNS).map(async (group) => {
          try {
            return {
              group,
              message: await this.writeGroup(node, group, groups.get(group) as Row[]),
            };
          } catch (error) {
            if (!(error instanceof StepFailure)) {
              throw error;
            }
            lost.push(`${group}: ${error.message.slice(0, 160)}`);
            return null;
          }
        }),
      );
      written.push(
        ...turns.filter((turn): turn is { group: string; message: string } => turn !== null),
      );
    }
    // Turns end in any order; the lost ones are named in the same order on every run
    lost.sort();
    if (written.length === 0) {
      throw new StepFailure(
        node,
        `no salió ninguna redacción en '${node.id}' (${lost.join(", ")})`,
      );
    }
    if (node.tool === undefined) {
      const part = written.map((turn) => turn.message).join("\n\n");
      this.delivery = this.delivery === null ? part : `${this.delivery}\n\n${part}`;
    } else {
      await this.sendBatch(node, this.groupItems(node, written));
    }
    // What was written is delivered, and the run still ends as a failure that says what was lost
    if (lost.length > 0) {
      throw new StepFailure(
        node,
        `se redactaron ${written.length} de ${keys.length} en '${node.id}'; sin mensaje: ${lost.join(", ")}`,
      );
    }
  }

  /**
   * Splits an agentic step's rows into its groups
   *
   * @param   node  The agentic action
   *
   * @return  The rows of each group
   */
  private groupsOf(node: ProgramNode): Map<string, Row[]> {
    const rows = this.keptRows(node);
    const groups = new Map<string, Row[]>();
    if (node.group_by === undefined) {
      if (rows.length > 0) {
        groups.set(SINGLE_GROUP, rows);
      }
      return groups;
    }
    for (const row of rows) {
      const key = String(row[node.group_by] ?? "").trim();
      // Without a key there is nobody to write to
      if (key !== "") {
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
    }

    return groups;
  }

  /**
   * Turns each group's message into the items of the tool, one per recipient
   *
   * @param   node     The agentic action
   * @param   written  Each group with its message
   *
   * @return  The items
   */
  private groupItems(node: ProgramNode, written: Array<{ group: string; message: string }>): Row[] {
    const fields = node.per_group?.fields ?? {};
    const recipients = node.per_group?.recipients;

    return written.flatMap(({ group, message }) => {
      const to = recipients && Object.hasOwn(recipients, group) ? recipients[group] : undefined;
      const people = to === undefined ? [undefined] : [to].flat();
      return people.map((recipient) =>
        Object.fromEntries(
          Object.entries(fields).map(([name, template]) => [
            name,
            this.fill(node, template, {
              group,
              message,
              ...(recipient === undefined ? {} : { recipient }),
            }),
          ]),
        ),
      );
    });
  }

  /**
   * Writes one group's message: its data within the budget, one retry only when the answer is empty
   *
   * @param   node   The agentic action
   * @param   group  The group
   * @param   rows   Its rows
   *
   * @return  The message
   */
  private async writeGroup(node: ProgramNode, group: string, rows: Row[]): Promise<string> {
    const { day, date, time } = this.options;
    const data = [
      ...(node.group_by === undefined ? this.sourceAggregates(node) : [groupTotals(rows)]),
      `día: ${day} ${date} · hora de inicio de la corrida: ${time} · grupo (${node.group_by ?? SINGLE_GROUP}): ${group} · filas: ${rows.length}${node.only ? ` · todas son de clase ${node.only.join("/")}` : ""}`,
      ...(node.summarize
        ? summaryLines(rows, node.summarize)
        : rows.map((row) => JSON.stringify(row))),
    ].join("\n");
    if (Buffer.byteLength(data) > MAX_MODEL_DATA_BYTES) {
      throw new StepFailure(
        node,
        `'${node.id}' le mandaría al modelo ${Math.round(Buffer.byteLength(data) / 1024)} KB y el máximo es ${MAX_MODEL_DATA_BYTES / 1000} KB: ${node.summarize ? "resume por menos campos o filtra con 'only'" : "agrega 'summarize' para que el programa cuente y el modelo solo redacte"}`,
      );
    }
    const instruction = (node.agentic as { instruction: string }).instruction;
    for (const attempt of [1, 2] as const) {
      if (attempt === 2) {
        await (this.options.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms))))(
          1_500,
        );
      }
      let text: string;
      try {
        text = (
          await (this.options.callModel as CallModel)({
            group,
            instruction:
              attempt === 1
                ? instruction
                : `${instruction}\n\nTu intento anterior vino vacío. Redacta de nuevo.`,
            data,
            attempt,
          })
        ).trim();
      } catch (error) {
        throw new StepFailure(
          node,
          `el modelo falló redactando '${group}' en '${node.id}': ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        );
      }
      if (text !== "") {
        return text;
      }
    }

    throw new StepFailure(
      node,
      `el modelo no escribió nada para '${group}' en '${node.id}' (2 intentos)`,
    );
  }

  /**
   * Writes the values the source query already computed, so the model does not count them again
   *
   * @param   node  The agentic action
   *
   * @return  One line, or none
   */
  private sourceAggregates(node: ProgramNode): string[] {
    const stepId = stepOf(node.from as string);
    const source = this.byId.get(stepId);
    const contract = source?.tool ? this.options.catalog.get(source.tool) : undefined;
    const output = this.outputs.get(stepId);
    if (!contract || !output || typeof output !== "object" || Array.isArray(output)) {
      return [];
    }
    const values = contract.aggregates
      .filter((name) => (output as Row)[name] !== undefined && (output as Row)[name] !== null)
      .map((name) => `${name}: ${String((output as Row)[name])}`);

    return values.length > 0 ? [`ya calculado por la consulta → ${values.join(" · ")}`] : [];
  }

  /**
   * Picks a decision's way out: the first condition that holds, in order, or the otherwise
   *
   * @param   node  The decision
   *
   * @return  The edge taken, or none
   */
  private decide(node: ProgramNode): ProgramEdge | undefined {
    const out = this.options.program.edges.filter((edge) => edge.from === node.id);

    return (
      out.find((edge) => edge.condition !== undefined && this.holds(node, edge.condition)) ??
      out.find((edge) => edge.otherwise === true)
    );
  }

  /**
   * Evaluates a condition against what the run already read
   *
   * @param   node       The decision
   * @param   condition  The condition
   *
   * @return  Whether it holds
   */
  private holds(node: ProgramNode, condition: Condition): boolean {
    try {
      if (condition.day === true) {
        return compare(this.options.day, condition.op, condition.value);
      }
      if (condition.field !== undefined) {
        const [stepId, field] = condition.field.split(".", 2) as [string, string];
        const value = (this.outputs.get(stepId) as Row | undefined)?.[field];
        if (value === undefined) {
          throw new Error(`'${condition.field}' no vino en el resultado`);
        }
        return compare(value, condition.op, condition.value);
      }
      const missing = (condition.count ?? []).filter((reference) => !(reference in this.counts));
      // A classify that did not run counted nothing: taking it as zero would choose a way blindly
      if (missing.length > 0) {
        throw new Error(`no hay conteo de ${missing.join(", ")}: ese paso no corrió`);
      }
      const total = (condition.count ?? []).reduce(
        (sum, reference) => sum + (this.counts[reference] as number),
        0,
      );
      return compare(total, condition.op, condition.value);
    } catch (error) {
      throw new StepFailure(
        node,
        `la condición de '${node.id}' no se pudo evaluar: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Ends at an end step, with its text or what the agentic steps wrote
   *
   * @param   end  The end step
   *
   * @return  The run's result
   */
  private finish(end: ProgramNode): RunResult {
    const status = end.status ?? "delivered";
    const base =
      end.text ??
      this.delivery ??
      [
        end.title,
        ...this.calls.filter((call) => call.ok).map((call) => `- ${call.tool}`),
        Object.keys(this.counts).length > 0
          ? `Conteos: ${Object.entries(this.counts)
              .map(([name, count]) => `${name} ${count}`)
              .join(", ")}`
          : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
    // Coming through a failure branch that still delivers, the reason travels with the text
    const text =
      this.pendingReason !== null && status !== "failed"
        ? `${base}\nPor el camino de error: ${this.pendingReason}`
        : base;

    return {
      status,
      reason:
        status === "failed"
          ? (this.pendingReason ?? `llegó a '${end.id}', que termina en falla`)
          : null,
      endId: end.id,
      text,
      delivery: status === "failed" ? null : this.delivery,
      calls: this.calls,
      counts: this.counts,
      steps: this.steps,
    };
  }

  /**
   * Ends the run as failed, naming the step when there is one
   *
   * @param   stepId  Where it failed
   * @param   reason  Why
   *
   * @return  The run's result
   */
  private failed(stepId: string | null, reason: string): RunResult {
    return {
      status: "failed",
      reason: stepId === null ? reason : `falló en '${stepId}': ${reason}`,
      endId: null,
      // What was written before the failure is not delivered, but its owner can read it
      text:
        this.delivery === null ? reason : `${reason}\n\nLo que sí se redactó:\n${this.delivery}`,
      delivery: null,
      calls: this.calls,
      counts: this.counts,
      steps: this.steps,
    };
  }
}

/**
 * Writes a group's own totals, computed over its rows, so the model does not add them up
 *
 * @param   rows  The group's rows
 *
 * @return  The line
 */
function groupTotals(rows: Row[]): string {
  const parts = [`filas: ${rows.length}`];
  for (const field of Object.keys(rows[0] ?? {})) {
    // Adding percentages means nothing
    if (field.endsWith("_pct")) {
      continue;
    }
    const values = rows.map((row) => row[field]);
    if (values.every((value) => typeof value === "number")) {
      const sum = values.reduce((total: number, value) => total + (value as number), 0);
      parts.push(`${field} (suma): ${Math.round(sum * 100) / 100}`);
    } else if (values.every((value) => typeof value === "boolean")) {
      parts.push(`${field}=true: ${values.filter(Boolean).length}`);
    }
  }

  return `totales de este grupo, ya calculados (no los recuentes) → ${parts.join(" · ")}`;
}
