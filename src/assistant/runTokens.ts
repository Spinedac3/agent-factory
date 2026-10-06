export interface RunTokenRequest {
  ownerId: number;
  tools: string[];
  minutes: number;
  runId: string;
}

export interface RunToken {
  token: string;
  // What the run can use: the agent's tools its owner can use now
  tools: string[];
  // What the agent asked for and its owner can no longer use
  denied: string[];
  expiresIn: number;
}

export class RunTokenError extends Error {
  /**
   * Builds a refusal from the assistant, with what the owner should hear
   *
   * @param   code     The assistant's error code
   * @param   message  The assistant's message, in Spanish
   * @param   denied   Tools refused, when that was the reason
   */
  constructor(
    public readonly code: string,
    message: string,
    public readonly denied: string[] = [],
  ) {
    super(message);
    this.name = "RunTokenError";
  }
}

export interface RunTokensDependencies {
  assistantUrl: string;
  clientId: string;
  secret: string;
  fetch?: typeof fetch;
}

/**
 * Asks the assistant for the tokens of agent runs, as the machine client it declared
 */
export class RunTokens {
  /**
   * @param   deps  The assistant's address, this client's credentials and how to reach it
   */
  constructor(private readonly deps: RunTokensDependencies) {}

  /**
   * Gets the token of one run, bounded by what its owner can use now
   *
   * @param   request  Owner, tools, duration and run
   *
   * @return  The token with the tools it reaches
   *
   * @throws  RunTokenError
   */
  async issue(request: RunTokenRequest): Promise<RunToken> {
    const answer = await this.post("/runs/tokens", {
      owner_id: request.ownerId,
      tools: request.tools,
      minutes: request.minutes,
      run_id: request.runId,
    });
    const data = answer.data as {
      token: string;
      tools: string[];
      denied: string[];
      expires_in: number;
    };

    return {
      token: data.token,
      tools: data.tools,
      denied: data.denied,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Ends the token of a run that finished
   *
   * @param   token  The run's token
   *
   * @throws  RunTokenError
   */
  async revoke(token: string): Promise<void> {
    await this.post("/runs/tokens/revoke", { token });
  }

  /**
   * Sends one request to the assistant with this client's credentials
   *
   * @param   path  Route
   * @param   body  JSON body
   *
   * @return  The assistant's answer
   *
   * @throws  RunTokenError
   */
  private async post(path: string, body: object): Promise<{ data?: unknown }> {
    const credentials = Buffer.from(`${this.deps.clientId}:${this.deps.secret}`).toString("base64");
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(new URL(path, this.deps.assistantUrl), {
        method: "POST",
        headers: { authorization: `Basic ${credentials}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RunTokenError("assistant_unreachable", "No se pudo contactar al asistente");
    }
    const answer = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      data?: { denied?: string[] };
    };
    if (!response.ok || answer.ok !== true) {
      throw new RunTokenError(
        answer.error ?? `http_${response.status}`,
        answer.message ?? "El asistente rechazó el pedido",
        answer.data?.denied ?? [],
      );
    }

    return answer;
  }
}
