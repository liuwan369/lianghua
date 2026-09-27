/** Long-lived JSONL bridge. Read-only commands arrive through stdin. */
import { createInterface } from "node:readline";
import { connectAccountReader } from "../live/account-data.js";

const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
// Third-party diagnostics must never include authenticated requests or secrets.
console.log = console.info = console.warn = console.error = () => {};
let reader: Awaited<ReturnType<typeof connectAccountReader>> | undefined;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    if (JSON.parse(line)?.command !== "refresh") throw new Error("invalid_command");
    reader ??= await connectAccountReader();
    output(await reader());
  } catch {
    reader = undefined;
    output({ error_code: "account_data_unavailable", read_only: true, checked_at: new Date().toISOString() });
  }
}
