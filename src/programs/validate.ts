import type { ToolContract } from "./contracts.js";
import { dominates, hasCycle, reachable, stepById, stepOf, templateFields } from "./graph.js";
import {
  type Condition,
  DAYS,
  type Program,
  type ProgramNode,
  programSchema,
  SINGLE_GROUP,
} from "./language.js";

export type Catalog = ReadonlyMap<string, ToolContract>;

export interface Verdict {
  program: Program | null;
  errors: string[];
  // Not wrong, but almost always a connection that was missed
  warnings: string[];
}

interface Source {
  fields: Set<string>;
  // The classify the rows come through, whose classes `only` may name
  classifier: ProgramNode | null;
}

// A name for a column a join adds, the same shape as a class
const COLUMN = /^[a-z][a-z0-9_]{0,40}$/;
// A group is one model turn: past this a run is no longer an agent
const MAX_GROUPS = 100;
// What a per_group template can use
const GROUP_FIELDS = ["group", "message", "recipient"];

/**
 * Judges a program as published: its shape, then every rule the schema alone cannot say, all in
 * one list so everything can be fixed in one pass
 *
 * @param   raw      The program as received
 * @param   catalog  The tools its owner can use, with their contracts
 *
 * @return  The parsed program, its errors and its warnings
 */
export function judgeProgram(raw: unknown, catalog: Catalog): Verdict {
  const parsed = programSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      program: null,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "programa"}: ${issue.message}`,
      ),
      warnings: [],
    };
  }
  const program = parsed.data;
  const errors = [...shapeErrors(program, catalog)];
  // The rest assumes ids that resolve; with a broken shape it would only add noise
  if (errors.length === 0) {
    errors.push(...decisionErrors(program, catalog));
    for (const node of program.nodes) {
      errors.push(...nodeErrors(program, node, catalog));
    }
  }

  return { program, errors, warnings: unusedData(program) };
}

/**
 * Checks the graph: one start, ends with a status, every step reachable, no loop, tools only where
 * they run and only those the owner has
 *
 * @param   program  The program
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function shapeErrors(program: Program, catalog: Catalog): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of program.nodes) {
    if (ids.has(node.id)) {
      errors.push(`El paso '${node.id}' está repetido`);
    }
    ids.add(node.id);
  }
  const starts = program.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) {
    errors.push("El programa necesita exactamente un paso de inicio");
  }
  if (!program.nodes.some((node) => node.type === "end")) {
    errors.push("El programa necesita al menos un final");
  }
  for (const edge of program.edges) {
    for (const id of [edge.from, edge.to]) {
      if (!ids.has(id)) {
        errors.push(`Una conexión usa '${id}', que no existe`);
      }
    }
  }
  for (const node of program.nodes) {
    errors.push(...stepShapeErrors(program, node, ids, catalog));
  }
  if (hasCycle(program)) {
    errors.push("El programa vuelve sobre sí mismo: un programa no tiene ciclos");
  }
  if (starts.length === 1) {
    const reached = reachable(program);
    for (const node of program.nodes.filter((item) => !reached.has(item.id))) {
      errors.push(`El paso '${node.id}' no se alcanza desde el inicio`);
    }
  }

  return errors;
}

/**
 * Checks one step's place in the graph and the tool it uses
 *
 * @param   program  The program
 * @param   node     The step
 * @param   ids      Every step id
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function stepShapeErrors(
  program: Program,
  node: ProgramNode,
  ids: Set<string>,
  catalog: Catalog,
): string[] {
  const errors: string[] = [];
  const out = program.edges.filter((edge) => edge.from === node.id);
  if (node.on_failure !== undefined && !ids.has(node.on_failure)) {
    errors.push(`'${node.id}' salta al fallar a '${node.on_failure}', que no existe`);
  }
  if (node.type === "end") {
    if (out.length > 0) {
      errors.push(`El final '${node.id}' no puede llevar a otro paso`);
    }
    if (node.status === undefined) {
      errors.push(`El final '${node.id}' no dice cómo termina (delivered, no_findings o failed)`);
    }
  } else if (node.type === "decision") {
    if (out.length < 2) {
      errors.push(`La decisión '${node.id}' necesita al menos dos salidas`);
    }
  } else if (out.length !== 1) {
    errors.push(`El paso '${node.id}' tiene que llevar a exactamente un paso siguiente`);
  }
  if (node.tool !== undefined) {
    if (node.type !== "query" && node.type !== "action") {
      errors.push(`'${node.id}' es un paso ${node.type} y no puede usar una herramienta`);
    } else if (!catalog.has(node.tool)) {
      errors.push(`'${node.id}' usa '${node.tool}', que la persona dueña no puede usar`);
    }
  }

  return errors;
}

/**
 * Checks the decisions: each way out has a condition or is the one otherwise, and each condition
 * reads what its step can see
 *
 * @param   program  The program
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function decisionErrors(program: Program, catalog: Catalog): string[] {
  const errors: string[] = [];
  for (const node of program.nodes.filter((item) => item.type === "decision")) {
    const out = program.edges.filter((edge) => edge.from === node.id);
    if (out.filter((edge) => edge.otherwise === true).length > 1) {
      errors.push(`La decisión '${node.id}' tiene más de una salida 'otherwise'`);
    }
    for (const edge of out) {
      if ((edge.condition !== undefined) === (edge.otherwise === true)) {
        errors.push(
          `'${node.id}' → '${edge.to}' necesita una condición o ser 'otherwise', y no las dos`,
        );
      }
      if (!edge.label?.trim()) {
        errors.push(`'${node.id}' → '${edge.to}' necesita una etiqueta que se lea en la flecha`);
      }
      if (edge.condition) {
        errors.push(...conditionErrors(program, node.id, edge.condition, catalog));
      }
    }
  }

  return errors;
}

/**
 * Checks what a condition reads: an aggregate of a query, classes of a classify, or the day
 *
 * @param   program     The program
 * @param   decisionId  The decision it belongs to
 * @param   condition   The condition
 * @param   catalog     The owner's tools
 *
 * @return  The errors
 */
function conditionErrors(
  program: Program,
  decisionId: string,
  condition: Condition,
  catalog: Catalog,
): string[] {
  const errors: string[] = [];
  if (condition.field !== undefined) {
    const [stepId, field] = condition.field.split(".", 2) as [string, string | undefined];
    const step = stepById(program, stepId);
    if (!step || field === undefined) {
      return [`La condición de '${decisionId}' lee '${condition.field}', que no es paso.campo`];
    }
    if (!dominates(program, stepId, decisionId)) {
      errors.push(`'${decisionId}' lee '${stepId}', pero hay caminos que llegan sin pasar por él`);
    }
    const contract = step.type === "query" && step.tool ? catalog.get(step.tool) : undefined;
    if (!contract) {
      errors.push(
        step.type === "classify"
          ? `'${decisionId}' lee '${condition.field}', pero '${stepId}' clasifica filas: para contarlas va {"count": ["${stepId}.<clase>"]}`
          : `'${decisionId}' lee '${condition.field}', y 'field' solo lee un valor de una consulta`,
      );
    } else if (!contract.aggregates.includes(field)) {
      errors.push(
        `'${field}' no es un valor que devuelva ${step.tool} (devuelve: ${contract.aggregates.join(", ") || "ninguno"})`,
      );
    }
  }
  for (const reference of condition.count ?? []) {
    const [stepId, name] = reference.split(".", 2) as [string, string | undefined];
    const step = stepById(program, stepId);
    if (step?.type !== "classify" || name === undefined) {
      errors.push(
        `'${decisionId}' cuenta '${reference}', y 'count' cuenta las filas de una clase de un paso classify`,
      );
      continue;
    }
    if (!(step.classes ?? []).some((item) => item.name === name)) {
      errors.push(`La clase '${name}' no existe en '${stepId}'`);
    }
    if (!dominates(program, stepId, decisionId)) {
      errors.push(
        `'${decisionId}' cuenta '${stepId}', pero hay caminos que llegan sin pasar por él`,
      );
    }
  }
  if (condition.day === true) {
    const days = [condition.value].flat();
    if (!days.every((day) => (DAYS as readonly unknown[]).includes(day))) {
      errors.push(`La condición de '${decisionId}' compara el día con algo que no es un día`);
    }
  }

  return errors;
}

/**
 * Checks one step by its type: what makes it runnable and whether what it reads exists
 *
 * @param   program  The program
 * @param   node     The step
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function nodeErrors(program: Program, node: ProgramNode, catalog: Catalog): string[] {
  const errors: string[] = [];
  if (node.summarize !== undefined && node.type !== "classify" && node.agentic === undefined) {
    errors.push(`'${node.id}' resume, y eso solo lo aplica un classify o un paso agéntico`);
  }
  if (node.only !== undefined && node.type !== "action") {
    errors.push(
      `'${node.id}' usa 'only', que solo filtra las filas de una acción: aquí no filtraría nada`,
    );
  }
  for (const key of ["from", "with"] as const) {
    errors.push(...unnamedList(program, node, key, catalog));
  }
  switch (node.type) {
    case "query":
      if (node.tool === undefined) {
        errors.push(`La consulta '${node.id}' no dice qué herramienta usa`);
      } else {
        errors.push(...paramsErrors(node, catalog, []));
      }
      break;
    case "classify":
      errors.push(...classifyErrors(program, node, catalog));
      break;
    case "join":
      errors.push(...joinErrors(program, node, catalog));
      break;
    case "action":
      errors.push(...actionErrors(program, node, catalog));
      break;
    default:
      break;
  }

  return errors;
}

/**
 * Asks to name the list when a query's tool returns several and the reference does not say which
 *
 * @param   program  The program
 * @param   node     The step that reads
 * @param   key      Which reference: from or with
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function unnamedList(
  program: Program,
  node: ProgramNode,
  key: "from" | "with",
  catalog: Catalog,
): string[] {
  const reference = node[key];
  const source = reference === undefined ? undefined : stepById(program, reference);
  const lists =
    source?.type === "query" && source.tool ? (catalog.get(source.tool)?.lists ?? []) : [];

  return lists.length > 1
    ? [
        `'${node.id}' toma '${key}: ${reference}' sin decir qué lista, y ${source?.tool} devuelve ${lists.length}: escribe '${reference}.<lista>' (${lists.map((list) => list.name).join(", ")})`,
      ]
    : [];
}

/**
 * Resolves the rows a reference points to and the fields they carry, following classify and join
 * back to the query that read them
 *
 * @param   program    The program
 * @param   reference  `step` or `step.list`, or `classify.class`
 * @param   who        The step that reads them
 * @param   catalog    The owner's tools
 * @param   errors     Where a reference that does not resolve is reported
 *
 * @return  The fields and the classify on the way, or null when it does not resolve
 */
export function sourceOf(
  program: Program,
  reference: string | undefined,
  who: string,
  catalog: Catalog,
  errors: string[],
): Source | null {
  if (reference === undefined) {
    errors.push(`'${who}' no dice de dónde salen sus filas`);
    return null;
  }
  const [stepId, part] = reference.split(".", 2) as [string, string | undefined];
  const step = stepById(program, stepId);
  if (!step) {
    errors.push(`'${who}' toma filas de '${stepId}', que no existe`);
    return null;
  }
  if (!dominates(program, stepId, who)) {
    errors.push(`'${who}' toma filas de '${stepId}', pero hay caminos que llegan sin pasar por él`);
    return null;
  }
  if (step.type === "classify") {
    if (part !== undefined && !(step.classes ?? []).some((item) => item.name === part)) {
      errors.push(`'${who}' toma la clase '${part}', que '${stepId}' no tiene`);
    }
    const base = sourceOf(program, step.from, stepId, catalog, []);
    const own = step.summarize
      ? [...step.summarize.by, "rows", ...(step.summarize.sum ?? [])]
      : [...(base?.fields ?? [])];
    return { fields: new Set([...own, "class", "severity"]), classifier: step };
  }
  if (step.type === "join") {
    const base = sourceOf(program, step.from, stepId, catalog, []);
    return {
      fields: new Set([...(base?.fields ?? []), ...Object.keys(step.adds ?? {})]),
      classifier: base?.classifier ?? null,
    };
  }
  const lists = step.type === "query" && step.tool ? (catalog.get(step.tool)?.lists ?? []) : [];
  if (lists.length === 0) {
    errors.push(`'${who}' toma filas de '${stepId}', que no devuelve ninguna lista de filas`);
    return null;
  }
  const list =
    part === undefined
      ? lists.length === 1
        ? lists[0]
        : undefined
      : lists.find((item) => item.name === part);
  if (!list) {
    // Several lists with none named is reported once, by unnamedList
    if (part !== undefined) {
      errors.push(
        `'${who}' pide '${reference}', y las listas de ${step.tool} son: ${lists.map((item) => item.name).join(", ")}`,
      );
    }
    return null;
  }

  return { fields: new Set(list.fields), classifier: null };
}

/**
 * Checks that a tool gets every parameter it requires on each call, from the step or its batch
 *
 * @param   node      The step
 * @param   catalog   The owner's tools
 * @param   supplied  Arguments the step fills in another way
 *
 * @return  The errors
 */
function paramsErrors(node: ProgramNode, catalog: Catalog, supplied: string[]): string[] {
  const contract = node.tool ? catalog.get(node.tool) : undefined;
  if (!contract) {
    return [];
  }
  const empty = (value: unknown) =>
    value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  const given = { ...(node.params ?? {}), ...(node.once ?? {}) } as Record<string, unknown>;
  const missing = contract.required.filter(
    (name) => !supplied.includes(name) && empty(given[name]),
  );
  const unknown = Object.keys(given).filter((name) => !contract.params.includes(name));

  return [
    ...(missing.length > 0
      ? [`A '${node.id}' le falta lo que ${node.tool} pide siempre: ${missing.join(", ")}`]
      : []),
    ...(unknown.length > 0
      ? [`'${node.id}' le pasa a ${node.tool} lo que no recibe: ${unknown.join(", ")}`]
      : []),
  ];
}

/**
 * Checks a classify: the field it cuts by, one rest class at the end, its exceptions and nulls
 *
 * @param   program  The program
 * @param   node     The step
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function classifyErrors(program: Program, node: ProgramNode, catalog: Catalog): string[] {
  const errors: string[] = [];
  const classes = node.classes ?? [];
  const names = new Set(classes.map((item) => item.name));
  // A rest at the end leaves no value without a class, so no row can fail to land
  if (classes.filter((item) => item.rest === true).length !== 1 || classes.at(-1)?.rest !== true) {
    errors.push(`'${node.id}' necesita exactamente una clase rest, y al final`);
  }
  if (node.by === undefined) {
    errors.push(`'${node.id}' no dice por qué campo clasifica`);
  }
  const source = sourceOf(program, node.from, node.id, catalog, errors);
  const summarize = node.summarize;
  if (source && summarize) {
    for (const field of [...summarize.by, ...(summarize.sum ?? [])]) {
      if (!source.fields.has(field)) {
        errors.push(`'${node.id}' resume por '${field}', que sus filas no traen`);
      }
    }
  }
  const cuttable = summarize
    ? new Set([...summarize.by, "rows", ...(summarize.sum ?? [])])
    : source?.fields;
  if (cuttable && node.by !== undefined && !cuttable.has(node.by)) {
    errors.push(`'${node.id}' clasifica por '${node.by}', que sus filas no traen`);
  }
  for (const exception of node.exceptions ?? []) {
    for (const name of [exception.degrade.from, exception.degrade.to]) {
      if (!names.has(name)) {
        errors.push(`La excepción de '${node.id}' usa '${name}', que no es una de sus clases`);
      }
    }
  }
  if (node.if_null !== undefined && node.if_null !== "drop" && !names.has(node.if_null)) {
    errors.push(`'${node.id}' manda los nulos a '${node.if_null}', que no es una clase ni 'drop'`);
  }

  return errors;
}

/**
 * Checks a join: both lists ran before it, the keys exist, the columns it adds are new, and what
 * happens to a row with no pair is said
 *
 * @param   program  The program
 * @param   node     The step
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function joinErrors(program: Program, node: ProgramNode, catalog: Catalog): string[] {
  const errors: string[] = [];
  const left = sourceOf(program, node.from, node.id, catalog, errors);
  const right = sourceOf(program, node.with, node.id, catalog, errors);
  if (node.by === undefined) {
    errors.push(`'${node.id}' no dice por qué campo cruza`);
  }
  // How many rows survive is a choice, never a default
  if (node.if_missing === undefined) {
    errors.push(`'${node.id}' no dice qué pasa con una fila sin pareja ('blank' o 'drop')`);
  }
  const adds = Object.entries(node.adds ?? {});
  if (adds.length === 0) {
    errors.push(`'${node.id}' no agrega ninguna columna: el cruce no traería nada`);
  }
  if (left && node.by !== undefined && !left.fields.has(node.by)) {
    errors.push(`'${node.id}' cruza por '${node.by}', que sus filas no traen`);
  }
  const rightKey = node.with_by ?? node.by;
  if (right && rightKey !== undefined && !right.fields.has(rightKey)) {
    errors.push(`'${node.id}' cruza con '${rightKey}', que la otra lista no trae`);
  }
  for (const [name, field] of adds) {
    if (!COLUMN.test(name)) {
      errors.push(`'${name}' no sirve como nombre de columna en '${node.id}'`);
    }
    if (left?.fields.has(name)) {
      errors.push(`'${node.id}' agrega '${name}', y sus filas ya traen un campo con ese nombre`);
    }
    if (right && !right.fields.has(field)) {
      errors.push(`'${node.id}' agrega '${field}', que la otra lista no trae`);
    }
  }

  return errors;
}

/**
 * Checks an action by its kind: once, per row or agentic
 *
 * @param   program  The program
 * @param   node     The step
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function actionErrors(program: Program, node: ProgramNode, catalog: Catalog): string[] {
  const kinds = [node.once, node.per_row, node.agentic].filter((kind) => kind !== undefined);
  if (kinds.length !== 1) {
    return [`La acción '${node.id}' tiene que ser una de: once, per_row o agentic`];
  }
  if (node.agentic !== undefined) {
    return agenticErrors(program, node, catalog);
  }
  if (node.tool === undefined) {
    return [`La acción '${node.id}' no dice qué herramienta usa`];
  }
  if (node.once !== undefined) {
    const literal = Object.entries(node.once).filter(
      ([, value]) => typeof value === "string" && templateFields(value).length > 0,
    );
    // `once` is passed as written: a ${field} would reach the person as is
    return [
      ...literal.map(
        ([name]) => `'${node.id}' usa \${...} en '${name}', y 'once' no completa plantillas`,
      ),
      ...paramsErrors(node, catalog, []),
    ];
  }

  return perRowErrors(program, node, catalog);
}

/**
 * Checks a per-row action: its limit, its rows, and that each item gives the tool what it needs
 *
 * @param   program  The program
 * @param   node     The step
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function perRowErrors(program: Program, node: ProgramNode, catalog: Catalog): string[] {
  const errors: string[] = [];
  const batch = catalog.get(node.tool as string)?.batch;
  if (!batch) {
    return [`${node.tool} no recibe una lista de elementos, así que no sirve para 'per_row'`];
  }
  errors.push(...paramsErrors(node, catalog, [batch.name]));
  if (node.limit === undefined) {
    errors.push(`'${node.id}' va fila por fila sin 'limit': un paso por caso no queda abierto`);
  }
  const source = sourceOf(program, node.from, node.id, catalog, errors);
  if (!source) {
    return errors;
  }
  errors.push(...rowsErrors(node, source));
  const perRow = node.per_row ?? {};
  for (const [name, template] of Object.entries(perRow)) {
    if (!batch.fields.includes(name)) {
      errors.push(`'${node.id}' manda '${name}', que ${node.tool} no recibe en cada elemento`);
    }
    for (const field of templateFields(template)) {
      if (!source.fields.has(field)) {
        errors.push(`La plantilla de '${node.id}' usa \${${field}}, que sus filas no traen`);
      }
    }
  }
  const missing = batch.required.filter((name) => !(name in perRow));
  if (missing.length > 0) {
    errors.push(
      `A '${node.id}' le falta lo que ${node.tool} pide en cada elemento: ${missing.join(", ")}`,
    );
  }

  return errors;
}

/**
 * Checks the rows an action keeps: the classes it filters by and the field it orders by
 *
 * @param   node    The step
 * @param   source  Its rows
 *
 * @return  The errors
 */
function rowsErrors(node: ProgramNode, source: Source): string[] {
  const classes = (source.classifier?.classes ?? []).map((item) => item.name);

  return [
    ...(node.only ?? [])
      .filter((name) => !classes.includes(name))
      .map((name) => `'${node.id}' se queda con la clase '${name}', que sus filas no traen`),
    ...(node.order_by !== undefined && !source.fields.has(node.order_by)
      ? [`'${node.id}' ordena por '${node.order_by}', que sus filas no traen`]
      : []),
  ];
}

/**
 * Checks an agentic action: its groups, what it summarizes, and how each group's message becomes
 * an item of the tool, or the run's own text when it has no tool
 *
 * @param   program  The program
 * @param   node     The step
 * @param   catalog  The owner's tools
 *
 * @return  The errors
 */
function agenticErrors(program: Program, node: ProgramNode, catalog: Catalog): string[] {
  const errors: string[] = [];
  // With no tool, what it writes is the run's text; a per_group would have nowhere to go
  if ((node.tool === undefined) !== (node.per_group === undefined)) {
    return [
      `'${node.id}' redacta: o declara herramienta y 'per_group', o ninguna de las dos y su texto es la entrega`,
    ];
  }
  const recipients = Object.keys(node.per_group?.recipients ?? {});
  if (node.group_by === undefined && recipients.some((key) => key !== SINGLE_GROUP)) {
    errors.push(`'${node.id}' no agrupa, y entonces su único grupo se llama '${SINGLE_GROUP}'`);
  }
  if (node.group_by !== undefined) {
    if (node.limit === undefined) {
      errors.push(`'${node.id}' agrupa sin 'limit': un turno por grupo no queda abierto`);
    } else if (node.limit > MAX_GROUPS) {
      errors.push(
        `'${node.id}' pide ${node.limit} turnos de modelo; el máximo por corrida es ${MAX_GROUPS}`,
      );
    } else if (node.limit < recipients.length) {
      errors.push(
        `'${node.id}' tiene limit ${node.limit} y declara ${recipients.length} grupos con destinatario: los que pasen del límite no recibirían nada`,
      );
    }
  }
  const source = sourceOf(program, node.from, node.id, catalog, errors);
  if (source) {
    errors.push(...rowsErrors(node, source));
    const summarize = node.summarize;
    const used = [
      ...(node.group_by === undefined ? [] : [node.group_by]),
      ...(summarize?.by ?? []),
      ...(summarize?.sum ?? []),
      ...(summarize?.top ? [summarize.top.field] : []),
      ...(summarize?.rank ? [summarize.rank.field, ...summarize.rank.show] : []),
    ];
    for (const field of used.filter((item) => !source.fields.has(item))) {
      errors.push(`'${node.id}' usa '${field}', que sus filas no traen`);
    }
  }
  if (node.tool !== undefined && node.per_group) {
    errors.push(...groupItemErrors(node, catalog, recipients.length > 0));
  }

  return errors;
}

/**
 * Checks that each group's item gives the tool what it needs, with only the values a group has
 *
 * @param   node           The step
 * @param   catalog        The owner's tools
 * @param   hasRecipients  Whether `${recipient}` exists
 *
 * @return  The errors
 */
function groupItemErrors(node: ProgramNode, catalog: Catalog, hasRecipients: boolean): string[] {
  const errors: string[] = [];
  const batch = catalog.get(node.tool as string)?.batch;
  if (!batch) {
    return [
      `${node.tool} no recibe una lista de elementos, así que no sirve para un paso por grupos`,
    ];
  }
  errors.push(...paramsErrors(node, catalog, [batch.name]));
  const fields = node.per_group?.fields ?? {};
  const known = GROUP_FIELDS.filter((field) => field !== "recipient" || hasRecipients);
  for (const [name, template] of Object.entries(fields)) {
    if (!batch.fields.includes(name)) {
      errors.push(`'${node.id}' manda '${name}', que ${node.tool} no recibe en cada elemento`);
    }
    for (const field of templateFields(template).filter((item) => !known.includes(item))) {
      errors.push(
        `'${node.id}' usa \${${field}} por grupo, y ahí solo existen ${known.map((item) => `\${${item}}`).join(", ")}`,
      );
    }
  }
  const missing = batch.required.filter((name) => !(name in fields));
  if (missing.length > 0) {
    errors.push(
      `A '${node.id}' le falta lo que ${node.tool} pide en cada elemento: ${missing.join(", ")}`,
    );
  }

  return errors;
}

/**
 * Warns about a query, classify or join whose rows no later step uses: it runs and costs for nothing
 *
 * @param   program  The program
 *
 * @return  The warnings
 */
function unusedData(program: Program): string[] {
  const used = new Set<string>();
  for (const node of program.nodes) {
    for (const reference of [node.from, node.with]) {
      if (reference !== undefined) {
        used.add(stepOf(reference));
      }
    }
  }
  for (const edge of program.edges) {
    if (edge.condition?.field !== undefined) {
      used.add(stepOf(edge.condition.field));
    }
    for (const reference of edge.condition?.count ?? []) {
      used.add(stepOf(reference));
    }
  }

  return program.nodes
    .filter((node) => ["query", "classify", "join"].includes(node.type) && !used.has(node.id))
    .map((node) => `Ningún paso usa lo que '${node.id}' trae: o falta conectarlo, o sobra`);
}
