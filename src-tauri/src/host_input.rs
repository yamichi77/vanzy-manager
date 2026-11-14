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

/// Validate a configured chord without querying OS permissions or generating input.
pub fn validate_chord(keys: &[u16], modifiers: u8) -> Result<(), String> {
    validate(keys, modifiers)?;
    #[cfg(target_os = "macos")]
    macos::chord(keys, modifiers)?;
    Ok(())
}

/// Read-only readiness check. Never opens a permission prompt or sends keys.
pub fn ensure_input_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { macos::ensure_permission() }
    #[cfg(not(target_os = "macos"))]
    { Ok(()) }
}

/// Query accessibility trust; `request=true` only asks macOS to show its own
/// asynchronous guidance. It never grants trust or starts an input session.
pub fn input_permission(request: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    { macos::permission(request) }
    #[cfg(not(target_os = "macos"))]
    { let _ = request; Ok(true) }
}

/// Emit key-downs for all modifiers and normal keys, then key-ups in reverse.
/// Zero padding is accepted; duplicates, unsupported usages and empty chords are not.
/// OS event insertion does not guarantee that an application handles the chord.
pub fn emit_chord(keys: &[u16], modifiers: u8) -> Result<(), String> {
    let chord = validate(keys, modifiers)?;
    #[cfg(windows)]
    { windows::emit(&chord) }
    #[cfg(target_os = "macos")]
    { let _ = chord; macos::emit(keys, modifiers) }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = chord; Err("Host keyboard chords require Windows or macOS".into()) }
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


#[cfg(target_os = "macos")]
mod macos {
    use std::{ffi::c_void, sync::Mutex};
    type Ref = *mut c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: Ref) -> u8;
        static kAXTrustedCheckOptionPrompt: Ref;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state: i32) -> Ref;
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
        fn CGEventSetFlags(event: Ref, flags: u64);
        fn CGEventSetIntegerValueField(event: Ref, field: i32, value: i64);
        fn CGEventPost(tap: u32, event: Ref);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: Ref);
        static kCFBooleanTrue: Ref;
        fn CFDictionaryCreate(allocator: Ref, keys: *const Ref, values: *const Ref,
            count: isize, key_callbacks: Ref, value_callbacks: Ref) -> Ref;
    }
    struct Owned(Ref);
    impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) } } }
    static SEND_LOCK: Mutex<()> = Mutex::new(());
    const MODIFIERS: [(u8, u16, u64); 4] = [
        (1, 0x3b, 1 << 18), (2, 0x38, 1 << 17),
        (4, 0x3a, 1 << 19), (8, 0x37, 1 << 20),
    ];

    // Physical ANSI/ISO key positions, from Apple's HIToolbox Events.h.
    // Deliberately no invented substitute for PrintScreen, ScrollLock, Pause,
    // Insert or NumLock: macOS has no equivalent public virtual-key constants.
    fn usage(usage: u16) -> Result<u16, String> {
        const CODES: [u16; 98] = [
            0x00,0x0b,0x08,0x02,0x0e,0x03,0x05,0x04,0x22,0x26,0x28,0x25,0x2e,
            0x2d,0x1f,0x23,0x0c,0x0f,0x01,0x11,0x20,0x09,0x0d,0x07,0x10,0x06,
            0x12,0x13,0x14,0x15,0x17,0x16,0x1a,0x1c,0x19,0x1d,
            0x24,0x35,0x33,0x30,0x31,0x1b,0x18,0x21,0x1e,0x2a,0x2a,0x29,0x27,
            0x32,0x2b,0x2f,0x2c,0x39,
            0x7a,0x78,0x63,0x76,0x60,0x61,0x62,0x64,0x65,0x6d,0x67,0x6f,
            0xffff,0xffff,0xffff,0xffff,0x73,0x74,0x75,0x77,0x79,
            0x7c,0x7b,0x7d,0x7e,0xffff,0x4b,0x43,0x4e,0x45,0x4c,
            0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5b,0x5c,0x52,0x41,0x0a,0x6e,
        ];
        let code = usage.checked_sub(4).and_then(|i| CODES.get(i as usize)).copied();
        match code {
            Some(code) if code != 0xffff => Ok(code),
            _ => Err(format!("Keyboard usage 0x{usage:04X} has no supported macOS key equivalent")),
        }
    }
    pub(super) fn chord(keys: &[u16], modifiers: u8) -> Result<Vec<(u16,u64)>, String> {
        let mut chord: Vec<_> = MODIFIERS.iter().filter(|(bit,_,_)| modifiers & bit != 0)
            .map(|(_,code,flag)| (*code,*flag)).collect();
        for code in keys.iter().copied().filter(|k| *k != 0).map(usage) {
            let code=code?;
            if chord.iter().any(|(old,_)| *old == code) {return Err("Duplicate macOS physical key".into());}
            chord.push((code,0));
        }
        Ok(chord)
    }
    pub(super) fn permission(request: bool) -> Result<bool, String> {
        unsafe {
            // The read-only path must not call the prompting API.
            if !request { return Ok(AXIsProcessTrusted() != 0); }
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            // Both objects are immortal framework constants. Null callbacks make
            // this temporary dictionary borrow (not retain/release) those objects.
            // The key passed to AX is the exact framework constant, so identity
            // equality is sufficient. The dictionary itself is owned and released.
            let dictionary = CFDictionaryCreate(std::ptr::null_mut(), keys.as_ptr(),
                values.as_ptr(), 1, std::ptr::null_mut(), std::ptr::null_mut());
            if dictionary.is_null() { return Err("Cannot allocate accessibility prompt options".into()); }
            let dictionary = Owned(dictionary);
            // Apple's prompt is asynchronous: false here is pending/not granted,
            // not a failure to show it. The UI must recheck with request=false.
            Ok(AXIsProcessTrustedWithOptions(dictionary.0) != 0)
        }
    }
    pub(super) fn ensure_permission() -> Result<(),String> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            Err("macOS Accessibility permission is required for VANZY Manager. No permission was requested or changed.".into())
        } else { Ok(()) }
    }
    fn event_plan(chord: &[(u16,u64)], caps_lock: u64) -> Vec<(u16,bool,u64)> {
        let mut flags=caps_lock & (1 << 16);
        chord.iter().map(|k|(true,k)).chain(chord.iter().rev().map(|k|(false,k)))
            .map(|(down,(key,modifier))| {
                if down {flags |= modifier;} else {flags &= !modifier;}
                (*key,down,flags)
            }).collect()
    }
    // Create *all* down/up events before posting any. Allocation failures therefore
    // cannot leave keys held. Once posting begins the loop has no fallible branches.
    // CGEventPost returns void: app delivery is not observable/guaranteed by this API.
    pub(super) fn emit(keys: &[u16], modifiers: u8) -> Result<(),String> {
        let chord=chord(keys,modifiers)?;
        let _lock=SEND_LOCK.lock().map_err(|_| "Host input sender lock poisoned")?;
        unsafe {
            ensure_permission()?;
            // Combined session state also includes input generated by other apps.
            // Refuse rather than release someone else's keys. A physical transition
            // after this preflight remains an unavoidable race, as on Windows.
            if CGEventSourceFlagsState(0) & ((1 << 17)|(1 << 18)|(1 << 19)|(1 << 20)|(1 << 23)) != 0
                || [0x36,0x37,0x38,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f].iter().any(|k| CGEventSourceKeyState(0,*k))
                || chord.iter().any(|(key,_)| CGEventSourceKeyState(0,*key)) {
                return Err("Chord skipped because a modifier or chord key is already held".into());
            }
            let source=CGEventSourceCreate(-1); // kCGEventSourceStatePrivate
            if source.is_null() {return Err("Cannot allocate macOS event source".into());}
            let source=Owned(source);
            let plan=event_plan(&chord,CGEventSourceFlagsState(0));
            let mut events=Vec::with_capacity(plan.len());
            for (key,down,flags) in plan {
                let event=CGEventCreateKeyboardEvent(source.0,key,down);
                if event.is_null() {return Err("Cannot allocate macOS keyboard event; nothing sent".into());}
                let event=Owned(event);
                CGEventSetFlags(event.0,flags);
                CGEventSetIntegerValueField(event.0,42,super::INPUT_MARKER as i64); // kCGEventSourceUserData
                events.push(event);
            }
            for event in &events {CGEventPost(0,event.0);} // kCGHIDEventTap; exact reverse keyups
        }
        Ok(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test] fn releases_in_reverse_order_with_correct_modifier_flags() {
            let plan=event_plan(&chord(&[4,5],9).unwrap(),0);
            assert_eq!(plan,vec![
                (0x3b,true,1<<18),(0x37,true,(1<<18)|(1<<20)),
                (0,true,(1<<18)|(1<<20)),(0x0b,true,(1<<18)|(1<<20)),
                (0x0b,false,(1<<18)|(1<<20)),(0,false,(1<<18)|(1<<20)),
                (0x37,false,1<<18),(0x3b,false,0),
            ]);
            assert_eq!(event_plan(&[(0,0)],1<<16),vec![(0,true,1<<16),(0,false,1<<16)]);
            assert!(super::super::validate_chord(&[0x46],0).is_err());
        }
        #[test] fn maps_mac_physical_keys_and_rejects_unavailable_keys() {
            assert_eq!(usage(4).unwrap(),0x00);
            assert_eq!(usage(0x1d).unwrap(),0x06);
            assert_eq!(usage(0x4f).unwrap(),0x7c);
            assert_eq!(usage(0x58).unwrap(),0x4c);
            assert_eq!(usage(0x65).unwrap(),0x6e);
            for key in [3,0x46,0x47,0x48,0x49,0x53,0x66] {assert!(usage(key).is_err());}
            assert_eq!(chord(&[4,0],15).unwrap(),vec![(0x3b,1<<18),(0x38,1<<17),(0x3a,1<<19),(0x37,1<<20),(0,0)]);
            assert!(chord(&[0x31,0x32],0).is_err());
        }
    }
}
