import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  // The assistant whose tools the agents use, and who says who a person is
  ASSISTANT_URL: z.string().url().default("http://localhost:3000"),
  ASSISTANT_ISSUER: z.string().min(1).default("ai-assistant"),
  // How the assistant knows this factory; the secret is a file, never a variable
  ASSISTANT_CLIENT_ID: z.string().min(1).default("agent-factory"),
  ASSISTANT_CLIENT_SECRET_FILE: z.string().min(1).default("secrets/agent-factory.secret"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Reads the configuration from the environment, refusing to start on a wrong value
 *
 * @param   source  The environment
 *
 * @return  The configuration
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Configuración inválida: ${problems.join("; ")}`);
  }

  return parsed.data;
}
