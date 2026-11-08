#!/usr/bin/env node
// Human-in-the-loop reproduction loop.
// Copy this file, edit the steps below, and run it.
// The agent runs the script; the user follows prompts in their terminal.
//
// Usage:
//   node hitl-loop.template.mjs
//
// Two helpers:
//   await step("<instruction>")         → show instruction, wait for Enter
//   await capture("<question>")         → show question, return the response
//
// At the end, captured values are printed as KEY=VALUE for the agent to parse.
//
// `capture` prints its value back to the terminal, where the agent reads it,
// so capture observations, and leave signing in to the user as a `step`.
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

async function ask(prompt) {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  if (done) { console.error('\nhitl-loop: input closed before the loop finished'); process.exit(1); }
  return value;
}

async function step(instruction) {
  process.stdout.write(`\n>>> ${instruction}\n`);
  await ask('    [Enter when done] ');
}

async function capture(question) {
  process.stdout.write(`\n>>> ${question}\n`);
  return ask('    > ');
}

// --- edit below ---------------------------------------------------------

await step("Open the app at http://localhost:3000 and sign in.");

const ERRORED = await capture("Click the 'Export' button. Did it throw an error? (y/n)");

const ERROR_MSG = await capture("Paste the error message (or 'none'):");

// --- edit above ---------------------------------------------------------

process.stdout.write('\n--- Captured ---\n');
process.stdout.write(`ERRORED=${ERRORED}\n`);
process.stdout.write(`ERROR_MSG=${ERROR_MSG}\n`);
process.exit(0);
