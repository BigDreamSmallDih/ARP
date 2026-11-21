import { readFileSync } from 'node:fs';

const [title, file, tail = '40'] = process.argv.slice(2);

if (title === undefined || file === undefined) {
  console.error('Usage: node scripts/annotate-log.mjs <title> <log file> [lines]');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  text = `No log was written to ${file}.`;
}

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const excerpt = text.replace(ansi, '').trimEnd().split('\n').slice(-Number(tail)).join('\n');
const escaped = excerpt.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

console.log(`::error title=${title}::${escaped}`);
