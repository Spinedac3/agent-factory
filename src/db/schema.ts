import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { Program } from "../programs/language.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// A program as its owner is editing it; what runs is always a published version
export const programs = pgTable(
  "programs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    code: varchar("code", { length: 60 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull().default(""),
    // The person in the assistant it runs for, whose permissions bound it
    ownerId: integer("owner_id").notNull(),
    draft: jsonb("draft").$type<Program>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("programs_code_unique").on(t.code),
    index("programs_owner_idx").on(t.ownerId),
  ],
);

// Published versions never change: a run keeps the version it started with
export const programVersions = pgTable(
  "program_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    programId: integer("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<Program>().notNull(),
    publishedBy: integer("published_by").notNull(),
    publishedAt: timestamptz("published_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("program_versions_unique").on(t.programId, t.version)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: integer("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ownerId: integer("owner_id").notNull(),
    // running, then delivered, no_findings or failed
    status: varchar("status", {
      length: 20,
      enum: ["running", "delivered", "no_findings", "failed"],
    })
      .notNull()
      .default("running"),
    reason: text("reason"),
    text: text("text"),
    delivery: text("delivery"),
    counts: jsonb("counts").$type<Record<string, number>>(),
    steps: jsonb("steps").$type<string[]>(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [index("runs_program_idx").on(t.programId, t.startedAt)],
);

// Every tool call of a run, with its arguments: what the run did, step by step
export const runCalls = pgTable(
  "run_calls",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    step: varchar("step", { length: 40 }).notNull(),
    tool: varchar("tool", { length: 64 }).notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    ok: boolean("ok").notNull(),
    error: varchar("error", { length: 64 }),
  },
  (t) => [index("run_calls_run_idx").on(t.runId, t.position)],
);
