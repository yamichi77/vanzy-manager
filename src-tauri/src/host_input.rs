//! A bounded, opt-in host keyboard chord. No hooks, text input, or device writes.
//! Call only for an enabled, explicitly configured device gesture.

/// Identifies our synthetic events to any existing input observer (not a secret).
pub const INPUT_MARKER: usize = 0x5641_4E5A;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Key {
    scan: u16,
    extended: bool,
    // Pause has an E1 sequence and is emitted as VK_PAUSE instead.
    virtual_key: u16,
}

fn key(scan: u16) -> Key {
    Key { scan: scan & 0xff, extended: scan & 0xe000 != 0, virtual_key: 0 }
}

fn usage_key(usage: u16) -> Result<Key, String> {
    // USB keyboard usages 04..65, translated to PC set-1 scan codes.
    const SCANS: [u16; 98] = [
        0x1e,0x30,0x2e,0x20,0x12,0x21,0x22,0x23,0x17,0x24,0x25,0x26,0x32,
        0x31,0x18,0x19,0x10,0x13,0x1f,0x14,0x16,0x2f,0x11,0x2d,0x15,0x2c,
        0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,
        0x1c,0x01,0x0e,0x0f,0x39,0x0c,0x0d,0x1a,0x1b,0x2b,0x2b,0x27,0x28,
        0x29,0x33,0x34,0x35,0x3a,
        0x3b,0x3c,0x3d,0x3e,0x3f,0x40,0x41,0x42,0x43,0x44,0x57,0x58,
        0xe037,0x46,0x00,0xe052,0xe047,0xe049,0xe053,0xe04f,0xe051,
        0xe04d,0xe04b,0xe050,0xe048,0x45,0xe035,0x37,0x4a,0x4e,0xe01c,
        0x4f,0x50,0x51,0x4b,0x4c,0x4d,0x47,0x48,0x49,0x52,0x53,0x56,0xe05d,
    ];
    if !(0x04..=0x65).contains(&usage) {
        return Err(format!("Unsupported keyboard usage: 0x{usage:04X}"));
    }
    if usage == 0x48 {
        return Ok(Key { scan: 0, extended: false, virtual_key: 0x13 });
    }
    Ok(key(SCANS[(usage - 4) as usize]))
}

fn validate(keys: &[u16], modifiers: u8) -> Result<Vec<Key>, String> {
    if modifiers & !0x0f != 0 {
        return Err("Only Ctrl/Shift/Alt/GUI modifier bits are supported".into());
    }
    if keys.len() > 6 || (keys.is_empty() && modifiers != 8) {
        return Err("A chord requires one to six normal keyboard usages".into());
    }
    let mut normal = Vec::new();
    for usage in keys.iter().copied().filter(|usage| *usage != 0) {
        let mapped = usage_key(usage)?;
        if normal.contains(&mapped) {
            return Err("Duplicate keys (including physical scan-code aliases) are not supported".into());
        }
        normal.push(mapped);
    }
    if normal.is_empty() && !(keys.is_empty() && modifiers == 8) {
        return Err("A chord must contain a normal key, not only modifiers or zero padding".into());
    }
    let mut chord = Vec::new();
    for (bit, scan) in [(1, 0x1d), (2, 0x2a), (4, 0x38), (8, 0xe05b)] {
        if modifiers & bit != 0 { chord.push(key(scan)); }
    }
    chord.extend(normal);
    Ok(chord)
}

/// Validate a configured chord without querying Windows or generating input.
pub fn validate_chord(keys: &[u16], modifiers: u8) -> Result<(), String> {
    validate(keys, modifiers).map(|_| ())
}

/// Emit key-downs for all modifiers and normal keys, then key-ups in reverse.
/// Zero padding is accepted; duplicates, unsupported usages and empty chords are not.
/// Windows queues the whole chord together, but application handling is not guaranteed.
pub fn emit_chord(keys: &[u16], modifiers: u8) -> Result<(), String> {
    let chord = validate(keys, modifiers)?;
    #[cfg(windows)]
    { windows::emit(&chord) }
    #[cfg(not(windows))]
    { let _ = chord; Err("Host keyboard chords are supported only on Windows".into()) }
}

#[cfg(windows)]
mod windows {
    use super::{Key, INPUT_MARKER};
    use std::{mem::size_of, sync::Mutex};
    use windows_sys::Win32::{Foundation::{GetLastError, SetLastError}, UI::Input::KeyboardAndMouse::*};

    static SEND_LOCK: Mutex<()> = Mutex::new(());

    fn event(key: Key, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT {
                wVk: key.virtual_key,
                wScan: key.scan,
                dwFlags: (if key.virtual_key == 0 { KEYEVENTF_SCANCODE } else { 0 })
                    | (if key.extended { KEYEVENTF_EXTENDEDKEY } else { 0 })
                    | (if up { KEYEVENTF_KEYUP } else { 0 }),
                time: 0,
                dwExtraInfo: INPUT_MARKER,
            } },
        }
    }

    fn send(events: &[INPUT]) -> (usize, u32) {
        // SAFETY: events is a live contiguous INPUT array with the required ABI size.
        unsafe {
            SetLastError(0);
            let sent = SendInput(events.len() as u32, events.as_ptr(), size_of::<INPUT>() as i32);
            (sent as usize, GetLastError())
        }
    }

    pub(super) fn emit(chord: &[Key]) -> Result<(), String> {
        let _guard = SEND_LOCK.lock().map_err(|_| "Host input sender lock was poisoned".to_string())?;
        // GetAsyncKeyState cannot distinguish physical from third-party synthetic state.
        // Conservatively refuse either. Do not release or alter those existing keys.
        // A physical transition after these checks is an unavoidable OS-level race.
        for vk in [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LSHIFT, VK_RSHIFT,
            VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN] {
            if unsafe { GetAsyncKeyState(vk as i32) } < 0 {
                return Err("Chord skipped because a modifier is already held".into());
            }
        }
        for key in chord {
            let vk = if key.virtual_key != 0 { key.virtual_key as u32 } else {
                unsafe { MapVirtualKeyW(key.scan as u32 | if key.extended { 0xe000 } else { 0 }, MAPVK_VSC_TO_VK_EX) }
            };
            if vk == 0 {
                return Err("A chord key cannot be mapped on the current keyboard layout".into());
            }
            if unsafe { GetAsyncKeyState(vk as i32) } < 0 {
                return Err("Chord skipped because one of its keys is already held".into());
            }
        }
        let events: Vec<INPUT> = chord.iter().map(|k| event(*k, false))
            .chain(chord.iter().rev().map(|k| event(*k, true))).collect();
        let (sent, error) = send(&events);
        if sent == events.len() { return Ok(()); }

        // Only release our accepted downs whose corresponding ups were not inserted.
        // Never issue blanket modifier/key releases. A cleanup can itself be blocked.
        let down_count = sent.min(chord.len());
        let up_count = sent.saturating_sub(chord.len()).min(chord.len());
        let outstanding = down_count.saturating_sub(up_count);
        let cleanup: Vec<INPUT> = chord[..outstanding].iter().rev().map(|k| event(*k, true)).collect();
        let (released, cleanup_error) = if cleanup.is_empty() { (0, 0) } else { send(&cleanup) };
        Err(format!(
            "SendInput inserted {sent}/{} events (Windows error {error}); cleanup inserted {released}/{outstanding} releases (error {cleanup_error}). Windows UIPI may block input to elevated applications without reporting a specific error. No privilege escalation was attempted.",
            events.len()
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn events_are_marked_scan_codes_with_explicit_reverse_release() {
            // Inspect the generated records only. Never call SendInput in tests.
            let down = event(super::super::key(0xe04d), false);
            let up = event(super::super::key(0xe04d), true);
            let (down, up) = unsafe { (down.Anonymous.ki, up.Anonymous.ki) };
            assert_eq!(down.wVk, 0);
            assert_eq!(down.wScan, 0x4d);
            assert_eq!(down.dwExtraInfo, INPUT_MARKER);
            assert_eq!(up.dwExtraInfo, INPUT_MARKER);
            assert_eq!(down.dwFlags, KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY);
            assert_eq!(up.dwFlags, down.dwFlags | KEYEVENTF_KEYUP);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_invalid_and_duplicate_inputs() {
        for keys in [&[][..], &[0, 0][..], &[3][..], &[0x66][..], &[4, 4][..], &[0x31, 0x32][..], &[4,5,6,7,8,9,10][..]] {
            assert!(validate(keys, 0).is_err(), "{keys:?}");
        }
        assert!(validate(&[4], 0x10).is_err());
        assert!(validate(&[0], 0x0f).is_err());
        assert_eq!(validate(&[], 8).unwrap(), vec![key(0xe05b)]);
    }

    #[test]
    fn supports_standard_usages_and_zero_padding() {
        for usage in 4..=0x65 { assert!(validate(&[usage], 0).is_ok()); }
        assert_eq!(validate(&[4, 0, 0], 0).unwrap(), vec![key(0x1e)]);
        assert_eq!(validate(&[4, 5, 6, 7, 8, 9], 15).unwrap().len(), 10);
    }

    #[test]
    fn maps_extended_keys_pause_and_modifier_order() {
        assert_eq!(usage_key(0x4f).unwrap(), key(0xe04d));
        assert_eq!(usage_key(0x65).unwrap(), key(0xe05d));
        assert_eq!(usage_key(0x48).unwrap().virtual_key, 0x13);
        let chord = validate(&[4, 5], 15).unwrap();
        assert_eq!(&chord[..4], &[key(0x1d), key(0x2a), key(0x38), key(0xe05b)]);
        assert_eq!(&chord[4..], &[key(0x1e), key(0x30)]);
    }
}
