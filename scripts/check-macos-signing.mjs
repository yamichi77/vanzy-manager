// Read-only deployment preflight. Does not sign code, touch TCC, or install apps.
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Run this check on macOS.');
const [candidate, installed] = process.argv.slice(2);
if (!candidate) throw new Error('Usage: node scripts/check-macos-signing.mjs <candidate.app> [installed.app]');
function run(args) {
  try { return execFileSync('/usr/bin/codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(String(error.stderr || error.message).trim()); }
}
function inspect(app) {
  const path = resolve(app);
  run(['--verify', '--deep', '--strict', path]);
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', '-r-', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot inspect signature');
  const details = `${result.stdout}\n${result.stderr}`;
  if (/Signature=adhoc/.test(details)) throw new Error(`Ad-hoc signing is not upgrade-stable: ${path}. Use a persistent signing identity; do not reset or weaken OS permissions.`);
  const requirement = details.match(/^designated => (.+)$/m)?.[1];
  if (!requirement) throw new Error(`No designated requirement: ${path}`);
  return { path, requirement };
}
try {
  const next = inspect(candidate);
  if (installed) {
    const old = inspect(installed);
    run(['--verify', '-R', `=${old.requirement}`, next.path]);
    run(['--verify', '-R', `=${next.requirement}`, old.path]);
  }
  console.log('Signature checks passed. This does not grant or verify runtime privacy permissions.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
