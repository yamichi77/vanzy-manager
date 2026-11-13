fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "host_start", "host_stop", "host_status", "host_recover", "device_read_snapshot", "device_apply_map", "device_apply_batch", "device_cancel_batch", "device_restore_previous", "get_runtime_capabilities",
        "request_hardware_operation",
    ]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build the demo-only Tauri application");
}

