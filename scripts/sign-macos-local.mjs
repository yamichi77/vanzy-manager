// Sign only a locally built VANZY bundle. The private key stays in Keychain.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('Run on macOS.');
const identity = process.env.VANZY_SIGNING_IDENTITY;
if (!identity || !/^[0-9a-f]{40}$/i.test(identity)) throw new Error('Set VANZY_SIGNING_IDENTITY to your local certificate SHA-1 fingerprint. Never use an ad-hoc fallback.');
const app = resolve(process.argv[2] || 'src-tauri/target/release/bundle/macos/VANZY Manager.app');
const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${app}/Contents/Info.plist`], {encoding:'utf8'}).trim();
if (id !== 'dev.vanzy.manager.demo') throw new Error('Not a VANZY Manager bundle.');
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, '--timestamp=none', app], {stdio:'inherit'});
execFileSync(process.execPath, ['scripts/check-macos-signing.mjs', app, ...process.argv.slice(3)], {stdio:'inherit'});
