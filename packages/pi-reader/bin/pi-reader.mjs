#!/usr/bin/env node
import { convertReaderInput, normalizeFormat } from "../src/index.js";

const USAGE = `Usage: pi-reader <input> [options]

Convert an HTTP(S) URL or compatible file to Markdown or JSON.

Options:
  -f, --format <markdown|json>  Output format (default: markdown)
  -o, --output <path>           Write output to file instead of stdout
      --overwrite               Replace output file if it exists
  -h, --help                    Show help
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.input) throw new Error("Missing input.\n\n" + USAGE);
  const result = await convertReaderInput({
    input: options.input,
    format: normalizeFormat(options.format ?? "markdown"),
    output: options.output,
    overwrite: options.overwrite,
  });
  if (result.output) {
    process.stderr.write(`Wrote ${result.format} to ${result.output}\n`);
  } else {
    process.stdout.write(result.text);
    if (!result.text.endsWith("\n")) process.stdout.write("\n");
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ input?: string, format?: string, output?: string, overwrite?: boolean, help?: boolean }} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--format" || arg === "-f") options.format = argv[++i];
    else if (arg === "--output" || arg === "-o") options.output = argv[++i];
    else if (arg === "--overwrite") options.overwrite = true;
    else if (!options.input) options.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
