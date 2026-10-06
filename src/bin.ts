#!/usr/bin/env node
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  env: process.env,
});
