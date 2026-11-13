//! Allowlist for verified 3.2.1/A2 keyboard and per-slot FW defaults, not firmware I/O.
/// Known A2 model name with a per-device suffix. A name is not authentication:
/// transports must additionally pin the paired device ID, GATT service and firmware.
pub fn is_supported_product_name(name: &str) -> bool {
    let Some(serial) = name.strip_prefix("VANZY#1-").and_then(|n| n.strip_suffix("/A2")) else { return false; };
    serial.len() == 4 && serial.bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

pub fn validate_keyboard_map(index: u8, bytes: &[u8]) -> Result<(), &'static str> {
    if !(1..=11).contains(&index) { return Err("Only analyzed logical gesture slots 1–11 are supported"); }
    if bytes.len() != 15 || bytes[0] != 5 || bytes[1] > 15
        || !(matches!(bytes[2], 4..=56 | 58..=69 | 73..=82) || (bytes[1] == 8 && bytes[2] == 0))
        || bytes[3..].iter().any(|b| *b != 0) {
        return Err("Only a single keyboard action plus modifiers is verified; multiple slots are not a chord");
    }
    Ok(())
}
// Verified FW 3.2.1 initialization defaults, not manufacturing-specific values.
// Callers must independently enforce the supported product and firmware identity.
const FW_3_2_1_DEFAULT_PREFIXES: [[u8; 3]; 11] = [
    [5, 0, 80], [5, 0, 79], [5, 8, 43], [5, 0, 40],
    [4, 1, 0], [4, 0, 0], [4, 3, 0],
    [1, 22, 0], [1, 24, 0], [1, 16, 0], [1, 17, 0],
];

pub fn validate_apply_map(index: u8, bytes: &[u8]) -> Result<(), &'static str> {
    if validate_keyboard_map(index, bytes).is_ok() { return Ok(()); }
    if (1..=11).contains(&index) && bytes.len() == 15
        && bytes[..3] == FW_3_2_1_DEFAULT_PREFIXES[usize::from(index - 1)]
        && bytes[3..].iter().all(|b| *b == 0) {
        return Ok(());
    }
    Err("Only a verified keyboard action or the exact FW 3.2.1 default for this slot is supported")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_model_family_not_one_personal_device() {
        for name in ["VANZY#1-0000/A2", "VANZY#1-FFFF/A2", "VANZY#1-1234/A2"] {
            assert!(is_supported_product_name(name));
        }
        for name in ["", "VANZY", "VANZY#2-0000/A2", "VANZY#1-0000/A3", "VANZY#1-000/A2", "VANZY#1-00000/A2", "VANZY#1-gggg/A2", "VANZY#1-ffff/A2", "VANZY#1-0000/A2\n", "other-VANZY#1-0000/A2"] {
            assert!(!is_supported_product_name(name), "{name}");
        }
    }

    #[test]
    fn permits_only_verified_keyboard_maps() {
        let mut value = vec![5, 3, 0x50]; value.resize(15, 0);
        assert!(validate_keyboard_map(1, &value).is_ok());
        assert!(validate_keyboard_map(12, &value).is_err());
        let mut win = vec![5, 8, 0]; win.resize(15, 0);
        assert!(validate_keyboard_map(3, &win).is_ok());
        win[1] = 0;
        assert!(validate_keyboard_map(3, &win).is_err());
        win[2] = 0xe3;
        assert!(validate_keyboard_map(3, &win).is_err());
        value[3] = 5;
        assert!(validate_keyboard_map(1, &value).is_err());
        assert!(validate_keyboard_map(1, &[5, 0, 0x50]).is_err());
        assert!(validate_keyboard_map(1, &[0; 15]).is_err());
    }
    #[test]
    fn permits_all_exact_fw_defaults_and_preserves_keyboard_support() {
        for (offset, prefix) in FW_3_2_1_DEFAULT_PREFIXES.iter().enumerate() {
            let mut value = prefix.to_vec(); value.resize(15, 0);
            assert!(validate_apply_map((offset + 1) as u8, &value).is_ok());
        }
        let mut keyboard = vec![5, 3, 80]; keyboard.resize(15, 0);
        for index in 1..=11 { assert!(validate_apply_map(index, &keyboard).is_ok()); }
    }
    #[test]
    fn non_keyboard_defaults_are_bound_to_their_slot_and_exact_bytes() {
        for index in 5..=11 {
            let mut value = FW_3_2_1_DEFAULT_PREFIXES[usize::from(index - 1)].to_vec();
            value.resize(15, 0);
            assert!(validate_keyboard_map(index, &value).is_err());
            for other in 0..=12 {
                assert_eq!(validate_apply_map(other, &value).is_ok(), other == index);
            }
            for offset in 0..15 {
                let mut altered = value.clone(); altered[offset] ^= 0x80;
                assert!(validate_apply_map(index, &altered).is_err());
            }
            assert!(validate_apply_map(index, &value[..14]).is_err());
            value.push(0);
            assert!(validate_apply_map(index, &value).is_err());
        }
        for index in [0, 12, 255] {
            assert!(validate_apply_map(index, &[5, 0, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
        }
        assert!(validate_apply_map(1, &[]).is_err());
        assert!(validate_apply_map(5, &[0; 15]).is_err());
    }
}
