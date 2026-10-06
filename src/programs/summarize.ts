import type { Summarize } from "./language.js";

// Counting is not writing: what can be counted is counted here, and the model gets the summary

interface Group {
  key: string[];
  rows: number;
  sums: number[];
  top: Map<string, { rows: number; sum: number }>;
}

type Row = Record<string, unknown>;

const SEPARATOR = "\u0000";
const MISSING = "(sin dato)";

/**
 * Reads a number, taking anything else as zero
 *
 * @param   value  A cell
 *
 * @return  The number
 */
function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Rounds to two decimals
 *
 * @param   value  A number
 *
 * @return  The rounded number
 */
function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Groups rows by some fields, counting them, summing and tallying the top field
 *
 * @param   rows       Rows
 * @param   by         Fields that split them
 * @param   summarize  What to sum and tally
 *
 * @return  The groups, most rows first and then by key, the same order on every run
 */
function gather(rows: Row[], by: string[], summarize: Summarize): Group[] {
  const groups = new Map<string, Group>();
  const sums = summarize.sum ?? [];
  for (const row of rows) {
    const key = by.map((field) => String(row[field] ?? MISSING));
    const id = key.join(SEPARATOR);
    const group = groups.get(id) ?? { key, rows: 0, sums: sums.map(() => 0), top: new Map() };
    groups.set(id, group);
    group.rows += 1;
    sums.forEach((field, index) => {
      group.sums[index] = (group.sums[index] as number) + numberOf(row[field]);
    });
    if (summarize.top) {
      const raw = String(row[summarize.top.field] ?? MISSING);
      // A field holding several values in one text counts each on its own
      const values = summarize.top.separator
        ? raw
            .split(summarize.top.separator)
            .map((item) => item.trim())
            .filter((item) => item !== "")
        : [raw];
      for (const value of values) {
        const tally = group.top.get(value) ?? { rows: 0, sum: 0 };
        tally.rows += 1;
        tally.sum += numberOf(row[sums[0] ?? ""]);
        group.top.set(value, tally);
      }
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.rows - a.rows || a.key.join().localeCompare(b.key.join()),
  );
}

/**
 * Turns rows into one row per group: the fields it groups by, how many rows, and each sum. A
 * classify with `summarize` cuts over these
 *
 * @param   rows       Rows
 * @param   summarize  How to group
 *
 * @return  One row per group
 */
export function summarizedRows(rows: Row[], summarize: Summarize): Row[] {
  return gather(rows, summarize.by, summarize).map((group) => ({
    ...Object.fromEntries(summarize.by.map((field, index) => [field, group.key[index]])),
    rows: group.rows,
    ...Object.fromEntries(
      (summarize.sum ?? []).map((field, index) => [field, rounded(group.sums[index] as number)]),
    ),
  }));
}

/**
 * Writes the sums of a group as text
 *
 * @param   summarize  What is summed
 * @param   sums       The sums
 *
 * @return  The text
 */
function sumsText(summarize: Summarize, sums: number[]): string {
  return (summarize.sum ?? [])
    .map((field, index) => ` · ${field}: ${rounded(sums[index] as number)}`)
    .join("");
}

/**
 * Writes the lines a model reads instead of the rows: a total, the count by class, a subtotal for
 * every level above the full key, each group with its top and rank. The same rows give the same
 * lines on every run
 *
 * @param   rows       Rows
 * @param   summarize  How to summarize
 *
 * @return  The lines
 */
export function summaryLines(rows: Row[], summarize: Summarize): string[] {
  const detail = gather(rows, summarize.by, summarize);
  const total = gather(rows, [], summarize)[0];
  const lines = [
    `resumen por ${summarize.by.join(" · ")}, calculado sobre las ${rows.length} filas (no lo recuentes): grupos: ${detail.length}${total ? sumsText(summarize, total.sums) : ""}`,
  ];
  // The count by class is what a model cannot answer by reading a summary, so it goes first
  if (rows.some((row) => typeof row.class === "string")) {
    const byClass = gather(rows, ["class"], { by: ["class"], sum: summarize.sum });
    lines.push(
      `por clase: ${byClass.map((group) => `${group.key[0]} ${group.rows}${sumsText(summarize, group.sums).replace(/ · /g, ", ")}`).join(" · ")}`,
    );
  }
  const levels = summarize.by.slice(0, -1).map((_, index) => {
    const groups = gather(rows, summarize.by.slice(0, index + 1), summarize);
    return {
      groups: new Map(groups.map((group) => [prefix(group.key, index + 1), group])),
      order: new Map(groups.map((group, position) => [prefix(group.key, index + 1), position])),
      children: new Map<string, number>(),
    };
  });
  levels.forEach((level, index) => {
    const below = levels[index + 1] ? [...(levels[index + 1]?.groups.values() ?? [])] : detail;
    for (const group of below) {
      const id = prefix(group.key, index + 1);
      level.children.set(id, (level.children.get(id) ?? 0) + 1);
    }
  });
  const subtotal = (level: number, id: string): string => {
    const current = levels[level] as (typeof levels)[number];
    const group = current.groups.get(id) as Group;
    const key = group.key.map((value, index) => `${summarize.by[index]}=${value}`).join(" · ");
    return `${"  ".repeat(level)}${key}: filas ${group.rows}${sumsText(summarize, group.sums)} · ${summarize.by[level + 1]} distintos: ${current.children.get(id) ?? 0}`;
  };
  // Each group goes under its subtotals, and each level keeps its own order
  const ordered = [...detail].sort((a, b) => {
    for (const [index, level] of levels.entries()) {
      const difference =
        (level.order.get(prefix(a.key, index + 1)) ?? 0) -
        (level.order.get(prefix(b.key, index + 1)) ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return b.rows - a.rows;
  });
  const written = new Set<string>();
  for (const group of ordered) {
    levels.forEach((_, index) => {
      const id = prefix(group.key, index + 1);
      if (!written.has(id)) {
        written.add(id);
        lines.push(subtotal(index, id));
      }
    });
    const key = group.key.map((value, index) => `${summarize.by[index]}=${value}`).join(" · ");
    lines.push(
      `${"  ".repeat(levels.length)}${key}: filas ${group.rows}${sumsText(summarize, group.sums)}${topText(summarize, group)}${rankText(summarize, rows, group)}`,
    );
  }

  return lines;
}

/**
 * Joins the first fields of a key
 *
 * @param   key    A group key
 * @param   count  How many fields
 *
 * @return  The joined prefix
 */
function prefix(key: string[], count: number): string {
  return key.slice(0, count).join(SEPARATOR);
}

/**
 * Writes the most frequent values of the top field in a group
 *
 * @param   summarize  How to summarize
 * @param   group      The group
 *
 * @return  The text, empty without a top
 */
function topText(summarize: Summarize, group: Group): string {
  if (!summarize.top) {
    return "";
  }
  const best = [...group.top.entries()]
    .sort((a, b) => b[1].rows - a[1].rows || b[1].sum - a[1].sum || a[0].localeCompare(b[0]))
    .slice(0, summarize.top.n)
    .map(([value, tally]) => `${value} (${tally.rows})`);

  return ` · top ${summarize.top.field}: ${best.join(", ")}`;
}

/**
 * Writes the rows of a group with the lowest or highest value of a field: the "ten worst of each
 * area" a top, which counts frequencies, cannot give
 *
 * @param   summarize  How to summarize
 * @param   rows       Every row
 * @param   group      The group
 *
 * @return  The text, empty without a rank
 */
function rankText(summarize: Summarize, rows: Row[], group: Group): string {
  const rank = summarize.rank;
  if (!rank) {
    return "";
  }
  const id = group.key.join(SEPARATOR);
  // Only a number ranks: an empty or text value is not the lowest, it goes last either way
  const measure = (row: Row): number | null => {
    const value = row[rank.field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const byRank = (a: Row, b: Row): number => {
    const left = measure(a);
    const right = measure(b);
    if (left === null || right === null) {
      return left === right ? 0 : left === null ? 1 : -1;
    }
    return rank.order === "asc" ? left - right : right - left;
  };
  const chosen = rows
    .filter(
      (row) => summarize.by.map((field) => String(row[field] ?? MISSING)).join(SEPARATOR) === id,
    )
    .sort(byRank)
    .slice(0, rank.n)
    .map(
      (row) =>
        `${rank.show.map((field) => String(row[field] ?? MISSING)).join(" ")}: ${rank.field}=${String(row[rank.field] ?? MISSING)}`,
    );

  return chosen.length === 0
    ? ""
    : ` · ${rank.order === "asc" ? "menores" : "mayores"} ${rank.field} (${chosen.length}): ${chosen.join("; ")}`;
}
