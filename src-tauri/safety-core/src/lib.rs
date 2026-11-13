//! Demo-only policy. This crate has no I/O, environment switches, or device code.

use std::fmt;

pub const HARDWARE_DISABLED_MESSAGE: &str = "Hardware operation blocked: this build is demo-only. Bluetooth, HID, device writes and firmware operations are not implemented.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeCapabilities {
    pub hardware_enabled: bool,
    pub demo_only: bool,
    pub platform: &'static str,
    pub protocol_status: &'static str,
    pub supported_operations: &'static [&'static str],
}

pub fn capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        hardware_enabled: false,
        demo_only: true,
        platform: std::env::consts::OS,
        protocol_status: "unverified",
        supported_operations: &[],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HardwareAccessDenied;

impl fmt::Display for HardwareAccessDenied {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(HARDWARE_DISABLED_MESSAGE)
    }
}

impl std::error::Error for HardwareAccessDenied {}

/// Reject every operation. Never trust a frontend mode, profile or operation name.
pub fn reject_hardware_operation(_operation: &str) -> Result<(), HardwareAccessDenied> {
    Err(HardwareAccessDenied)
}

/// Permit only the bundled application origin, plus the exact Vite development
/// origin in debug builds. Remote websites and local files are never allowed.
/// The caller must also reject URL user information before using this predicate.
pub fn is_allowed_navigation(
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    development: bool,
) -> bool {
    match (scheme, host, port) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some("127.0.0.1"), Some(1420)) => development,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_always_report_demo_only() {
        let runtime = capabilities();
        assert!(!runtime.hardware_enabled);
        assert!(runtime.demo_only);
        assert_eq!(runtime.protocol_status, "unverified");
        assert!(runtime.supported_operations.is_empty());
        assert_eq!(runtime.platform, std::env::consts::OS);
    }

    #[test]
    fn every_hardware_operation_is_rejected() {
        for operation in [
            "scan", "connect", "pair", "disconnect", "read_gatt", "write_gatt",
            "send_hid", "apply_profile", "flash_firmware", "reset", "calibrate",
        ] {
            assert_eq!(reject_hardware_operation(operation), Err(HardwareAccessDenied));
        }
    }

    #[test]
    fn unrecognized_inputs_cannot_bypass_rejection() {
        for operation in ["", "demo", "allow=true", "hardware_enabled=true", "\0", "🔥"] {
            assert_eq!(reject_hardware_operation(operation), Err(HardwareAccessDenied));
        }
    }

    #[test]
    fn rejection_explains_the_real_limitation() {
        let message = reject_hardware_operation("connect").unwrap_err().to_string();
        assert_eq!(message, HARDWARE_DISABLED_MESSAGE);
        assert!(message.contains("demo-only"));
        assert!(message.contains("not implemented"));
    }

    #[test]
    fn packaged_origins_are_allowed() {
        for development in [false, true] {
            assert!(is_allowed_navigation("tauri", Some("localhost"), None, development));
            assert!(is_allowed_navigation("http", Some("tauri.localhost"), None, development));
            assert!(is_allowed_navigation("https", Some("tauri.localhost"), None, development));
        }
    }

    #[test]
    fn vite_is_allowed_only_in_development_at_the_exact_origin() {
        assert!(is_allowed_navigation("http", Some("127.0.0.1"), Some(1420), true));
        assert!(!is_allowed_navigation("http", Some("127.0.0.1"), Some(1420), false));
        assert!(!is_allowed_navigation("http", Some("localhost"), Some(1420), true));
        assert!(!is_allowed_navigation("https", Some("127.0.0.1"), Some(1420), true));
        assert!(!is_allowed_navigation("http", Some("127.0.0.1"), Some(3000), true));
    }

    #[test]
    fn remote_files_scripts_and_lookalike_origins_are_denied() {
        for development in [false, true] {
            for (scheme, host, port) in [
                ("https", Some("example.com"), None),
                ("https", Some("tauri.localhost.example.com"), None),
                ("https", Some("tauri.localhost"), Some(4443)),
                ("tauri", Some("localhost.example.com"), None),
                ("tauri", Some("localhost"), Some(1234)),
                ("file", None, None),
                ("data", None, None),
                ("javascript", None, None),
                ("ipc", Some("localhost"), None),
            ] {
                assert!(!is_allowed_navigation(scheme, host, port, development));
            }
        }
    }
}

pub mod protocol;
