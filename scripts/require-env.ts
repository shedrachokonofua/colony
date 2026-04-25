#!/usr/bin/env -S tsx

const missing = process.argv.slice(2).filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required env var(s): ${missing.join(", ")}`);
  process.exit(1);
}
