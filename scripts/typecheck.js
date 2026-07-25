#!/usr/bin/env node

/**
 * Runs `tsc --noEmit` and fails only on diagnostics that belong to this project.
 *
 * `skipLibCheck` suppresses errors inside `.d.ts` files, but several dependencies
 * ship declaration entry points that re-export their own untranspiled sources —
 * `@expo/ui/build/universal/index.d.ts` is `export * from '../../src/universal/...'`,
 * and expo-image does the same. TypeScript therefore type-checks those `.tsx`
 * files, and they are web-targeted source compiled against native React Native
 * types, so they report errors no change in this repo can fix.
 *
 * Everything under `src/` (plus the config and test files) is still checked and
 * still fails the build. Vendor-internal diagnostics are printed as a trailing
 * summary so a real upstream regression stays visible instead of silently
 * disappearing.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Invoke TypeScript's JS entry point directly rather than the `.bin` shim, so no
// shell is involved and the call behaves identically on Windows and POSIX.
const tsc = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], { encoding: 'utf8' });

if (result.error) {
  console.error(`Could not run tsc: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const lines = output.split(/\r?\n/);

// A diagnostic starts at column 0 with `path(line,col): error TSxxxx: ...`;
// continuation lines are indented and belong to the diagnostic above them.
const isDiagnosticStart = (line) => /^\S.*\(\d+,\d+\): (error|warning) TS\d+:/.test(line);
const isVendor = (line) => line.startsWith('node_modules/') || line.startsWith('node_modules\\');

const projectLines = [];
const vendorFiles = new Set();
let inVendorDiagnostic = false;

for (const line of lines) {
  if (isDiagnosticStart(line)) {
    inVendorDiagnostic = isVendor(line);
    if (inVendorDiagnostic) vendorFiles.add(line.slice(0, line.indexOf('(')));
    else projectLines.push(line);
    continue;
  }
  if (line.trim() && !inVendorDiagnostic) projectLines.push(line);
}

const projectErrorCount = projectLines.filter(isDiagnosticStart).length;

if (projectLines.length) console.error(projectLines.join('\n'));

if (vendorFiles.size) {
  console.error(
    `\nIgnored ${vendorFiles.size} dependency file(s) whose published declarations point at their own source:`,
  );
  for (const file of [...vendorFiles].sort()) console.error(`  ${file}`);
}

if (projectErrorCount) {
  console.error(`\n${projectErrorCount} error(s) in project code.`);
  process.exit(1);
}

console.log('No type errors in project code.');
