#!/usr/bin/env node
/** Entry point of the `sermonize-admin` binary (see main.ts). */
import { main } from './main.js';

process.exitCode = await main({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
