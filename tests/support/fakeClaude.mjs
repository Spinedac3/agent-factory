// A stand-in for the Claude CLI: answers with what it received, so a test can see it
import { existsSync } from "node:fs";

// As the real one, it reads its MCP configuration from where it runs
const config = process.argv[process.argv.indexOf("--mcp-config") + 1];
if (!config || !existsSync(config)) {
  process.stderr.write(`MCP config file not found: ${config}`);
  process.exit(1);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const seen = { argv: process.argv.slice(2), env: Object.keys(process.env), stdin };
  if (stdin.includes("FAIL_EXIT")) {
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(seen) }));
});
