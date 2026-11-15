fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref()==Ok("macos") {
        println!("cargo:rerun-if-changed=Info.macos.plist");
        std::fs::create_dir_all("binaries").expect("macOS helper output directory");
        for name in ["vanzy-macos", "vanzy-macos-host"] {
            println!("cargo:rerun-if-changed=transport/{name}.swift");
            println!("cargo:rerun-if-changed=transport/VanzyMacTransport.swift");
            let status=std::process::Command::new("/usr/bin/xcrun")
                .args(["swiftc", "-O", "-parse-as-library", "transport/VanzyMacTransport.swift", &format!("transport/{name}.swift"), "-o", &format!("binaries/{name}"), "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.macos.plist"])
                .status().expect("Xcode command line tools with swiftc are required");
            assert!(status.success(), "macOS BLE helper compilation failed");
        }
    }
    let manifest = tauri_build::AppManifest::new().commands(&[
        "macro_test", "macro_status", "macro_cancel", "host_start", "host_stop", "host_status", "host_recover", "host_input_permission", "device_read_snapshot", "device_apply_map", "device_apply_batch", "device_cancel_batch", "device_restore_previous", "get_runtime_capabilities",
        "request_hardware_operation",
    ]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build the demo-only Tauri application");
}

