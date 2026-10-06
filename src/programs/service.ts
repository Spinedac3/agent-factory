import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AssistantSession } from "../assistant/mcp.js";
import type { RunToken, RunTokenRequest } from "../assistant/runTokens.js";
import { RunTokenError } from "../assistant/runTokens.js";
import type { Database } from "../db/client.js";
import { programs, programVersions, runCalls, runs } from "../db/schema.js";
import { contractOf } from "./contracts.js";
import { DAYS, type Day, type Program } from "./language.js";
import { type CallModel, type RunResult, runProgram } from "./run.js";
import { type Catalog, judgeProgram, type Verdict } from "./validate.js";

export interface ProgramsDependencies {
  db: Database;
  runTokens: {
    issue: (request: RunTokenRequest) => Promise<RunToken>;
    revoke: (token: string) => Promise<void>;
  };
  openSession: (token: string) => Promise<AssistantSession>;
  callModel?: CallModel;
  // Where the run's day and time are read
  timeZone: string;
  now?: () => Date;
  logger?: { error: (details: object, message: string) => void };
}

export interface Saved {
  code: string;
  verdict: Verdict;
}

// What the token of a check lives; it only lists the tools and ends
const CHECK_MINUTES = 1;
// What a run on demand may take before its token ends under it
const RUN_MINUTES = 30;

/**
 * Lists the tools a program uses
 *
 * @param   program  The program
 *
 * @return  Their names, once each
 */
function toolsOf(program: Program): string[] {
  return [...new Set(program.nodes.flatMap((node) => (node.tool ? [node.tool] : [])))];
}

/**
 * Programs: kept by their owner, judged against the tools the owner can use now, published as
 * versions that never change, and run on demand
 */
export class Programs {
  /**
   * Prepares the service
   *
   * @param   deps  Database, the assistant and the model
   */
  constructor(private readonly deps: ProgramsDependencies) {}

  /**
   * Reads the contracts of the tools a program uses, as its owner can use them now
   *
   * @param   ownerId  The owner
   * @param   tools    The tools
   *
   * @return  The catalog of the ones granted
   */
  async catalogFor(ownerId: number, tools: string[]): Promise<Catalog> {
    if (tools.length === 0) {
      return new Map();
    }
    let granted: RunToken;
    try {
      granted = await this.deps.runTokens.issue({
        ownerId,
        tools,
        minutes: CHECK_MINUTES,
        runId: `check-${randomUUID()}`,
      });
    } catch (error) {
      // None granted is an answer, not a failure: the judge names every tool the owner lacks
      if (error instanceof RunTokenError && error.code === "no_tools") {
        return new Map();
      }
      throw error;
    }
    const session = await this.deps.openSession(granted.token);
    try {
      return new Map((await session.tools()).map((tool) => [tool.name, contractOf(tool)]));
    } finally {
      await session.close();
      await this.deps.runTokens.revoke(granted.token).catch(() => undefined);
    }
  }

  /**
   * Saves a program's draft, judged; a draft may have errors, a published version never
   *
   * @param   ownerId      The person saving it
   * @param   code         Its code
   * @param   name         Its name
   * @param   description  What it is for
   * @param   raw          The program as received
   *
   * @return  The verdict, or null when the code belongs to someone else
   */
  async save(
    ownerId: number,
    code: string,
    name: string,
    description: string,
    raw: unknown,
  ): Promise<Saved | null> {
    const [existing] = await this.deps.db.select().from(programs).where(eq(programs.code, code));
    if (existing && existing.ownerId !== ownerId) {
      return null;
    }
    const parsed = judgeProgram(raw, new Map());
    if (!parsed.program) {
      return { code, verdict: parsed };
    }
    const verdict = judgeProgram(
      parsed.program,
      await this.catalogFor(ownerId, toolsOf(parsed.program)),
    );
    const values = { name, description, draft: parsed.program, updatedAt: new Date() };
    if (existing) {
      await this.deps.db.update(programs).set(values).where(eq(programs.id, existing.id));
    } else {
      await this.deps.db.insert(programs).values({ ...values, code, ownerId });
    }

    return { code, verdict };
  }

  /**
   * Publishes the draft as a new version, judged again against the tools as they are now
   *
   * @param   ownerId  The owner
   * @param   code     The program
   *
   * @return  The version and the verdict; no version when it has errors; null when not found
   */
  async publish(
    ownerId: number,
    code: string,
  ): Promise<{ version: number | null; verdict: Verdict } | null> {
    const program = await this.find(ownerId, code);
    if (!program) {
      return null;
    }
    const verdict = judgeProgram(
      program.draft,
      await this.catalogFor(ownerId, toolsOf(program.draft)),
    );
    if (verdict.errors.length > 0) {
      return { version: null, verdict };
    }
    const [last] = await this.deps.db
      .select({ version: programVersions.version })
      .from(programVersions)
      .where(eq(programVersions.programId, program.id))
      .orderBy(desc(programVersions.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;
    await this.deps.db.insert(programVersions).values({
      programId: program.id,
      version,
      definition: program.draft,
      publishedBy: ownerId,
    });

    return { version, verdict };
  }

  /**
   * Finds a program of its owner
   *
   * @param   ownerId  The owner
   * @param   code     The program
   *
   * @return  The program, or null when it is not theirs or does not exist
   */
  async find(ownerId: number, code: string) {
    const [program] = await this.deps.db
      .select()
      .from(programs)
      .where(and(eq(programs.code, code), eq(programs.ownerId, ownerId)));

    return program ?? null;
  }

  /**
   * Starts a run of the last published version; it goes on in the background
   *
   * @param   ownerId  The owner
   * @param   code     The program
   *
   * @return  The run id, "unpublished", or null when the program is not theirs
   */
  async start(ownerId: number, code: string): Promise<string | "unpublished" | null> {
    const program = await this.find(ownerId, code);
    if (!program) {
      return null;
    }
    const [published] = await this.deps.db
      .select()
      .from(programVersions)
      .where(eq(programVersions.programId, program.id))
      .orderBy(desc(programVersions.version))
      .limit(1);
    if (!published) {
      return "unpublished";
    }
    const [run] = await this.deps.db
      .insert(runs)
      .values({ programId: program.id, version: published.version, ownerId })
      .returning({ id: runs.id });
    const runId = (run as { id: string }).id;
    this.running = this.running
      .then(() => this.execute(runId, ownerId, published.definition))
      .catch((error: unknown) => this.deps.logger?.error({ err: error, runId }, "run failed"));

    return runId;
  }

  // Runs on demand, one after another; the scheduler of later phases spreads them
  private running: Promise<void> = Promise.resolve();

  /**
   * Waits for the runs already started, for whoever needs them finished
   */
  async idle(): Promise<void> {
    await this.running;
  }

  /**
   * Runs a version with its own token, and keeps its outcome and every call
   *
   * @param   runId    The run
   * @param   ownerId  The owner
   * @param   program  The version that runs
   */
  private async execute(runId: string, ownerId: number, program: Program): Promise<void> {
    let result: RunResult;
    try {
      result = await this.walk(runId, ownerId, program);
    } catch (error) {
      const reason =
        error instanceof RunTokenError
          ? `el asistente no dio el token de la corrida: ${error.message}`
          : `la corrida no pudo seguir: ${error instanceof Error ? error.message : String(error)}`;
      result = {
        status: "failed",
        reason,
        endId: null,
        text: reason,
        delivery: null,
        calls: [],
        counts: {},
        steps: [],
      };
    }
    await this.deps.db
      .update(runs)
      .set({
        status: result.status,
        reason: result.reason,
        text: result.text,
        delivery: result.delivery,
        counts: result.counts,
        steps: result.steps,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    if (result.calls.length > 0) {
      await this.deps.db.insert(runCalls).values(
        result.calls.map((call, position) => ({
          runId,
          position,
          step: call.step,
          tool: call.tool,
          args: call.args,
          ok: call.ok,
          error: call.error,
        })),
      );
    }
  }

  /**
   * Walks a version against the assistant, with a token bounded by what the owner can use now
   *
   * @param   runId    The run
   * @param   ownerId  The owner
   * @param   program  The version that runs
   *
   * @return  How it ended
   */
  private async walk(runId: string, ownerId: number, program: Program): Promise<RunResult> {
    const tools = toolsOf(program);
    const token =
      tools.length === 0
        ? null
        : await this.deps.runTokens.issue({ ownerId, tools, minutes: RUN_MINUTES, runId });
    const session = token ? await this.deps.openSession(token.token) : null;
    try {
      const catalog: Catalog = new Map(
        ((await session?.tools()) ?? []).map((tool) => [tool.name, contractOf(tool)]),
      );
      const { day, date, time } = moment(this.deps.now?.() ?? new Date(), this.deps.timeZone);
      return await runProgram({
        program,
        catalog,
        day,
        date,
        time,
        callTool: (tool, args) =>
          session
            ? session.call(tool, args)
            : Promise.resolve({ ok: false, error: "no_tools", message: "sin herramientas" }),
        callModel: this.deps.callModel,
      });
    } finally {
      await session?.close().catch(() => undefined);
      if (token) {
        await this.deps.runTokens.revoke(token.token).catch(() => undefined);
      }
    }
  }
}

/**
 * Reads the day, date and time of an instant in a zone
 *
 * @param   instant   The instant
 * @param   timeZone  The zone
 *
 * @return  Its day of the week, date and time
 */
export function moment(instant: Date, timeZone: string): { day: Day; date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const day = (parts.weekday ?? "").toLowerCase() as Day;

  return {
    day: DAYS.includes(day) ? day : "monday",
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
