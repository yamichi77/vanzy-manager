//! Only bundled fixed-purpose native helpers. No user-supplied executable or arguments.
use tauri::Manager;
pub fn command(app: &tauri::AppHandle, host: bool) -> Result<std::process::Command, String> {
    let name=if host {"vanzy-macos-host"} else {"vanzy-macos"};
    let bundled=app.path().resource_dir().map_err(|e|e.to_string())?.join(name);
    #[cfg(debug_assertions)]
    let executable=if bundled.is_file() {bundled} else {std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name)};
    #[cfg(not(debug_assertions))]
    let executable=bundled;
    if !executable.is_file() {return Err("Bundled macOS BLE helper missing; rebuild the application".into());}
    Ok(std::process::Command::new(executable))
}
