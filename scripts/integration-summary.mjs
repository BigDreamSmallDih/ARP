// Prints a per-provider result table from a vitest JSON report of the live integration tests.
// A provider without a key and model is reported as NOT TESTED, never as PASS.
import { readFileSync } from 'node:fs';

const PROVIDERS = ['openai', 'anthropic', 'gemini'];
const reportPath = process.argv[2];

function loadResults() {
  if (reportPath === undefined) return [];
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    return report.testResults.flatMap((file) => file.assertionResults);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function statusOf(results, provider, prefix) {
  const match = results.find(
    (result) => result.ancestorTitles.includes(`live ${provider} adapter`) && result.title.startsWith(prefix),
  );
  return match?.status;
}

function verdict(status) {
  if (status === 'passed') return 'PASS';
  if (status === 'failed') return 'FAIL';
  return undefined;
}

const results = loadResults();
const lines = [
  '### Live provider tests',
  '',
  '| Provider | Key check (free) | Message call (billable) |',
  '| --- | --- | --- |',
];

for (const provider of PROVIDERS) {
  const key = verdict(statusOf(results, provider, 'verify:')) ?? 'NOT TESTED (no key and model available to this run)';
  const keyWasTested = key === 'PASS' || key === 'FAIL';
  const send =
    verdict(statusOf(results, provider, 'send:')) ??
    (keyWasTested ? 'NOT RUN (billable calls were not enabled)' : 'NOT TESTED');
  lines.push(`| ${provider} | ${key} | ${send} |`);
}

console.log(lines.join('\n'));
