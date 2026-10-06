// A stand-in for the Claude CLI: answers with what it received, so a test can see it
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
