#[cfg(target_os = "macos")]
mod mac_worker;
mod device;
mod host;
mod host_input;
mod macros;
mod recovery_guard;
use serde::Serialize;
use tauri::{Manager, WebviewWindowBuilder};
use vanzy_safety_core::{capabilities, is_allowed_navigation, reject_hardware_operation};

#[derive(Debug, Serialize)]
struct RuntimeCapabilities {
    hardware_enabled: bool,
    demo_only: bool,
    platform: &'static str,
    protocol_status: &'static str,
    supported_operations: &'static [&'static str],
}

/// Read-only facts supplied by the native process, not localStorage or UI state.
#[tauri::command]
fn get_runtime_capabilities() -> RuntimeCapabilities {
    let capabilities = capabilities();
    RuntimeCapabilities {
        hardware_enabled: capabilities.hardware_enabled,
        demo_only: capabilities.demo_only,
        platform: capabilities.platform,
        protocol_status: capabilities.protocol_status,
        supported_operations: capabilities.supported_operations,
    }
}

/// Deliberately contains no transport implementation, even for unknown inputs.
#[tauri::command]
fn request_hardware_operation(operation: String) -> Result<(), String> {
    reject_hardware_operation(&operation).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(device::DeviceState::default())
        .manage(host::HostState::default())
        .manage(macros::MacroState::default())
        .setup(|app| {
            // Configuration uses create:false so this navigation guard is
            // installed before the only webview is created.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("main window configuration is missing")?;
            WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(|url| {
                    url.username().is_empty()
                        && url.password().is_none()
                        && is_allowed_navigation(
                            url.scheme(),
                            url.host_str(),
                            url.port(),
                            cfg!(debug_assertions),
                        )
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            macros::macro_test, macros::macro_status, macros::macro_cancel,
            host::host_start, host::host_stop, host::host_status, host::host_recover, host::host_input_permission,
            device::device_read_snapshot,
            device::device_apply_map,
            device::device_apply_batch,
            device::device_cancel_batch,
            device::device_restore_previous,
            get_runtime_capabilities,
            request_hardware_operation,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                macros::cancel(window.app_handle());
                if device::is_busy(window.app_handle()) || host::is_active(window.app_handle()) || macros::is_running(window.app_handle()) {
                    // Keep the window visible while readback/restoration completes.
                    // A later explicit close can exit after the result is visible.
                    api.prevent_close();
                    if host::is_active(window.app_handle()) {
                        let _ = host::request_stop(window.app_handle());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build VANZY Manager")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                macros::cancel(app);
                if device::is_busy(app) || host::is_active(app) || macros::is_running(app) {
                    api.prevent_exit();
                    if host::is_active(app) {
                        let _ = host::request_stop(app);
                    }
                }
            }
        });
}

