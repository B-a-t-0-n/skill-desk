// Run the JavaScript parser's regression cases against the Rust CLI without
// writing another *.test.mjs file that node --test could discover twice.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const reference = [
  new URL('./reference/parser.test.mjs', import.meta.url),
  new URL('./parser.test.mjs', import.meta.url),
].find(url => fs.existsSync(url));
if (!reference) throw new Error('Parser reference tests are missing. Expected tests/reference/parser.test.mjs.');

const binary = process.env.SKILL_DESK_DATA_BIN
  ? path.resolve(process.env.SKILL_DESK_DATA_BIN)
  : fileURLToPath(new URL(`../src-tauri/target/debug/examples/skill-desk-data${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
if (!fs.existsSync(binary)) {
  throw new Error(`Rust data CLI not found: ${binary}. Build it with cargo build --manifest-path src-tauri/Cargo.toml --example skill-desk-data, or set SKILL_DESK_DATA_BIN.`);
}

function moduleURL(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const adapter = moduleURL(`
import {spawnSync} from 'node:child_process';
const binary = ${JSON.stringify(binary)};
function run(mode, input) {
  const result = spawnSync(binary, [mode], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true,
    timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error('Rust CLI ' + mode + ': ' + result.error.message);
  if (result.status !== 0) throw new Error('Rust CLI ' + mode + ' exited with ' + result.status + ': ' + result.stderr.trim().slice(0, 2000));
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error('Rust CLI ' + mode + ' returned invalid JSON: ' + error.message); }
}
export const extractAvailableSkills = text => run('--catalog', {text});
export const parseSessionRecords = (records, metadata = {}) => run('--parse', {records, metadata});
//# sourceURL=skill-desk-rust-parser-adapter.mjs
`);

const source = fs.readFileSync(reference, 'utf8');
let replacements = 0;
const transformed = source.replace(/(\bfrom\s+)(['"])(?:\.\.\/)+lib\/parser\.mjs\2/g, (_match, prefix) => {
  replacements++;
  return `${prefix}${JSON.stringify(adapter)}`;
});
if (replacements !== 1) throw new Error(`Expected one parser import in ${fileURLToPath(reference)}, found ${replacements}.`);

await import(moduleURL(`${transformed}\n//# sourceURL=skill-desk-rust-parser-parity.mjs\n`));
