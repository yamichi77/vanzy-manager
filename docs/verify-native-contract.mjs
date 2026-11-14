/** Static checks only. These do not compile or execute the Rust application. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");
const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
const capability = JSON.parse(
  await read("src-tauri/capabilities/main-demo.json"),
);

test("only the local main webview has explicit application permissions", () => {
  assert.equal(config.app.withGlobalTauri, false);
  assert.deepEqual(config.app.security.capabilities, ["main-demo"]);
  assert.deepEqual(capability.windows, ["main"]);
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.deepEqual(capability.permissions, [
    "allow-get-runtime-capabilities",
    "allow-request-hardware-operation",
    "allow-device-read-snapshot",
    "allow-device-apply-map",
    "allow-device-apply-batch",
    "allow-device-cancel-batch",
    "allow-device-restore-previous",
    "allow-host-start", "allow-host-stop", "allow-host-status", "allow-host-recover", "allow-host-input-permission",
  ]);
});

test("production CSP allows no remote server, shell, or asset filesystem access", () => {
  const directives = Object.fromEntries(
    config.app.security.csp.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
  assert.deepEqual(directives["default-src"], ["'self'"]);
  assert.deepEqual(directives["script-src"], ["'self'"]);
  assert.deepEqual(directives["connect-src"], ["ipc:", "http://ipc.localhost"]);
  for (const directive of ["object-src", "frame-src", "form-action"]) {
    assert.deepEqual(directives[directive], ["'none'"]);
  }
  assert.deepEqual(config.app.security.assetProtocol, {
    enable: false,
    scope: [],
  });
  assert.equal(config.bundle.externalBin, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, undefined);
  assert.match(
    config.app.security.headers["Permissions-Policy"],
    /bluetooth=\(\)/,
  );
  assert.match(config.app.security.headers["Permissions-Policy"], /hid=\(\)/);
});

/** Fail-closed scanner for the manifest's supported table declarations.
 * Every dependency declaration is checked; unfamiliar TOML syntax fails, never passes silently.
 * This is a static check, not cargo metadata or transitive dependency validation. */
function dependencyNames(manifest) {
  const names = [];
  let dependencyTable = false;
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      assert.match(line, /^\[[^\n]+\]$/, "Unsupported table declaration");
      const dep = line.match(
        /(?:^\[|\.)(?:build-|dev-)?dependencies(?:\.([^\]]+))?\]$/,
      );
      dependencyTable = !!dep && !dep[1];
      if (dep?.[1]) names.push(dep[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    if (dependencyTable) {
      const match = line.match(
        /^(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_-]+))\s*=/,
      );
      assert.ok(match, "Unsupported dependency declaration: " + line);
      assert.doesNotMatch(
        line,
        /\b(?:package|git|registry|workspace)\s*=/,
        "Unapproved dependency source or alias",
      );
      names.push(match[1] || match[2] || match[3]);
    } else {
      // Dotted declarations outside tables require a full TOML parser; reject rather than miss them.
      assert.doesNotMatch(
        line,
        /(?:build-|dev-)?dependencies\s*[.="']/,
        "Unsupported dotted dependency declaration",
      );
    }
  }
  return names.sort();
}
const allowedDeps = ["serde", "serde_json", "tauri", "tauri-build", "uuid", "vanzy-safety-core", "windows-sys"];
test("Rust has exactly the approved direct dependencies", async () => {
  assert.deepEqual(
    dependencyNames(await read("src-tauri/Cargo.toml")),
    allowedDeps,
  );
  assert.deepEqual(
    dependencyNames(await read("src-tauri/safety-core/Cargo.toml")),
    [],
  );
});
test("frontend includes no device transports or Tauri plugins", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.ok(
    !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) =>
      name.startsWith("@tauri-apps/plugin-"),
    ),
  );
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(resolve(root, "src"))) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    assert.doesNotMatch(
      await read("src/" + name),
      /navigator\s*(?:\.\s*(?:bluetooth|hid|usb|serial)|\[\s*["'](?:bluetooth|hid|usb|serial)["']\s*\])/,
    );
  }
});

test("native commands use the Rust guard and install navigation validation", async () => {
  const source = await read("src-tauri/src/lib.rs");
  assert.match(source, /reject_hardware_operation\(&operation\)/);
  assert.match(source, /\.on_navigation\(/);
  assert.match(source, /url\.username\(\)\.is_empty\(\)/);
  assert.match(source, /url\.password\(\)\.is_none\(\)/);
  assert.match(source, /is_allowed_navigation\(/);
  assert.match(
    source,
    /\.on_new_window\(\|_, _\| tauri::webview::NewWindowResponse::Deny\)/,
  );
  const build = await read("src-tauri/build.rs");
  assert.match(build, /AppManifest::new\(\)\.commands/);
});

test("the actual policy source is demo-only with no input-based escape hatch", async () => {
  const source = await read("src-tauri/safety-core/src/lib.rs");
  assert.match(source, /hardware_enabled:\s*false/);
  assert.match(source, /demo_only:\s*true/);
  assert.match(source, /protocol_status:\s*"unverified"/);
  assert.match(source, /supported_operations:\s*&\[\]/);
  assert.match(
    source,
    /pub fn reject_hardware_operation\(_operation: &str\) -> Result<\(\), HardwareAccessDenied>\s*\{\s*Err\(HardwareAccessDenied\)\s*\}/,
  );
});

test("close and exit retain native readback or restoration in progress", async () => {
  const source = await read("src-tauri/src/lib.rs");
  assert.match(source, /WindowEvent::CloseRequested/);
  assert.match(source, /api\.prevent_close\(\)/);
  assert.equal((source.match(/device::is_busy/g) || []).length, 2);
  assert.match(source, /api\.prevent_exit\(\)/);
  const device = (await read("src-tauri/src/device.rs")).split("#[cfg(test)]")[0];
  assert.equal((device.match(/let operation = DeviceOperation::new/g) || []).length, 3);
  assert.equal((device.match(/let _operation = operation/g) || []).length, 3);
});

test("ordinary writes cannot skip unresolved host restoration", async () => {
  const device = await read("src-tauri/src/device.rs");
  assert.equal((device.match(/recovery_guard::ensure_resolved/g) || []).length, 3);
  const worker = await read("src-tauri/transport/vanzy-windows.ps1");
  const mutex = worker.indexOf("if(-not $mutexHeld)");
  const guard = worker.indexOf("if($req.operation -ne 'read'){Assert-HostRecoveryResolved");
  const access = worker.indexOf("$selector=[Windows.Devices.Bluetooth.BluetoothLEDevice]");
  assert.ok(mutex < guard && guard < access);
});

test("macOS transport is a fixed bundled native helper with no frontend shell access", async () => {
  const mac = JSON.parse(await read("src-tauri/tauri.macos.conf.json"));
  assert.deepEqual(mac.bundle.resources, {"binaries/vanzy-macos":"vanzy-macos", "binaries/vanzy-macos-host":"vanzy-macos-host"});
  const worker=await read("src-tauri/src/mac_worker.rs");
  assert.match(worker, /resource_dir\(\)/);
  assert.match(worker, /"vanzy-macos-host"/);
  assert.doesNotMatch(worker, /\.args\(/);
  const info=await read("src-tauri/Info.macos.plist");
  assert.match(info, /NSBluetoothAlwaysUsageDescription/);
});

test("macOS permission request remains separate from device writes and key emission", async () => {
  const host = await read("src-tauri/src/host.rs");
  const input = await read("src-tauri/src/host_input.rs");
  assert.match(host, /pub fn host_input_permission[\s\S]*?check\(&window\)\?;[\s\S]*?host_input::input_permission\(request\)/);
  assert.match(input, /if !request \{ return Ok\(AXIsProcessTrusted\(\) != 0\); \}/);
  assert.match(input, /AXIsProcessTrustedWithOptions\(dictionary\.0\)/);
  assert.ok(host.indexOf("host_input::ensure_input_permission()?") < host.indexOf("let mut child=worker_command"));
});
