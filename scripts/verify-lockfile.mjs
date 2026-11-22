import { existsSync, readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'package-lock.json';
const REGISTRY = 'https://registry.npmjs.org/';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!existsSync(path)) {
  fail(`${path} is missing. Run the "Bootstrap lockfile" workflow to generate it, then commit the result.`);
}

let lock;
try {
  lock = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  fail(`${path} is not valid JSON: ${error.message}`);
}

if (lock.lockfileVersion !== 3) {
  fail(`${path} uses lockfileVersion ${lock.lockfileVersion}; expected 3.`);
}

const problems = [];
let registryPackages = 0;

for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  const isWorkspaceOrRoot = key === '' || !key.includes('node_modules/') || entry.link === true;
  if (isWorkspaceOrRoot || entry.inBundle === true) continue;

  registryPackages += 1;
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
    problems.push(`${key}: resolved from ${entry.resolved ?? 'an unknown source'}, expected ${REGISTRY}`);
  }
  if (typeof entry.integrity !== 'string') {
    problems.push(`${key}: no integrity hash`);
  }
}

if (registryPackages === 0) {
  fail(`${path} lists no registry packages; it looks empty or incomplete.`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  fail(`${problems.length} lockfile entries failed verification.`);
}

console.log(`Lockfile OK: ${registryPackages} registry packages, all with integrity hashes.`);
