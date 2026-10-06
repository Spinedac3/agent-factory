import type { Program, ProgramNode } from "./language.js";

/**
 * Lists every way out of each step: its edges and its jump on failure
 *
 * @param   program  The program
 *
 * @return  The pairs from and to
 */
export function arrows(program: Program): Array<{ from: string; to: string }> {
  return [
    ...program.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    ...program.nodes.flatMap((node) =>
      node.on_failure === undefined ? [] : [{ from: node.id, to: node.on_failure }],
    ),
  ];
}

/**
 * Tells whether the program loops back on itself anywhere
 *
 * @param   program  The program
 *
 * @return  Whether it has a cycle
 */
export function hasCycle(program: Program): boolean {
  const next = new Map<string, string[]>();
  for (const arrow of arrows(program)) {
    next.set(arrow.from, [...(next.get(arrow.from) ?? []), arrow.to]);
  }
  // 1 while on the current path, 2 once every way out of it was seen
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === 1 || (state.get(to) === undefined && visit(to))) {
        return true;
      }
    }
    state.set(id, 2);
    return false;
  };

  return program.nodes.some((node) => state.get(node.id) === undefined && visit(node.id));
}

/**
 * Lists the steps reachable from the start, following edges and jumps on failure
 *
 * @param   program  The program
 * @param   without  A step the walk may not go through
 *
 * @return  The ids reached
 */
export function reachable(program: Program, without?: string): Set<string> {
  const start = program.nodes.find((node) => node.type === "start");
  const seen = new Set<string>();
  if (!start || start.id === without) {
    return seen;
  }
  const all = arrows(program);
  const queue = [start.id];
  seen.add(start.id);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const arrow of all.filter((item) => item.from === current && item.to !== without)) {
      if (!seen.has(arrow.to)) {
        seen.add(arrow.to);
        queue.push(arrow.to);
      }
    }
  }

  return seen;
}

/**
 * Tells whether every way from the start to a step goes through another, which is what lets the
 * step use that other one's output
 *
 * @param   program  The program
 * @param   before   The step that must always run first
 * @param   step     The step that uses it
 *
 * @return  Whether it dominates
 */
export function dominates(program: Program, before: string, step: string): boolean {
  if (before === step) {
    return false;
  }
  const start = program.nodes.find((node) => node.type === "start");
  if (!start || start.id === step) {
    return false;
  }

  return before === start.id || !reachable(program, before).has(step);
}

/**
 * Names the step a reference `step` or `step.list` points to
 *
 * @param   reference  The reference
 *
 * @return  The step id
 */
export function stepOf(reference: string): string {
  return reference.split(".", 1)[0] as string;
}

/**
 * Lists the `${fields}` of a template, in order and once each
 *
 * @param   template  A text, or an object of texts one level deep
 *
 * @return  The field names
 */
export function templateFields(template: unknown): string[] {
  const seen = new Set<string>();
  const texts =
    typeof template === "string"
      ? [template]
      : template && typeof template === "object"
        ? Object.values(template).filter((item): item is string => typeof item === "string")
        : [];
  for (const text of texts) {
    for (const match of text.matchAll(/\$\{([^}]+)\}/g)) {
      seen.add((match[1] as string).trim());
    }
  }

  return [...seen];
}

/**
 * Finds a step by id
 *
 * @param   program  The program
 * @param   id       Step id
 *
 * @return  The step, if any
 */
export function stepById(program: Program, id: string): ProgramNode | undefined {
  return program.nodes.find((node) => node.id === id);
}
