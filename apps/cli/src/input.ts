/**
 * Reads command text from a file or stdin. `-` means read all of stdin, so
 * `open -` and `replan <id> --feedback -` compose with pipes.
 */

import { readFileSync } from "node:fs";

export async function readTextInput(source: string): Promise<string> {
  if (source !== "-") return readFileSync(source, "utf8");
  return readStdin();
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}
