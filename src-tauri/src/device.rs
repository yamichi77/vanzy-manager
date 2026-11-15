//! Fixed Windows BLE worker. No arbitrary command, path, GATT or firmware interface.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}};
use tauri::Manager;
use vanzy_safety_core::protocol::{validate_apply_map, is_supported_product_name};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    pub index: u8, pub target: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<UndoEntry>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoEntry { pub index: u8, pub target: Vec<u8> }
impl Undo {
    fn all(&self) -> Vec<UndoEntry> {
        self.entries.clone().unwrap_or_else(|| vec![UndoEntry {index:self.index,target:self.target.clone()}])
    }
    fn from_entries(entries: Vec<UndoEntry>) -> Self {
        Self {index:entries[0].index,target:entries[0].target.clone(),entries:Some(entries)}
    }
}
fn remaining_undo(device: &str, undo: &Undo, inversion: Option<bool>, snapshot: &Snapshot) -> Option<Undo> {
    let entries=undo.all();
    if device != snapshot.device_id || !inversion.map_or(entries.iter().all(|e| e.index <= 4), |v| v == snapshot.touch_inverted) { return None; }
    let remaining=entries.into_iter().filter(|e| snapshot.maps.get(&e.index.to_string()) != Some(&e.target)).collect::<Vec<_>>();
    if remaining.is_empty() {None} else {Some(Undo::from_entries(remaining))}
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub snapshot_id: String,
    pub device_id: String,
    pub product: String,
    pub firmware: String,
    pub captured_at: String,
    pub maps: BTreeMap<String, Vec<u8>>,
    pub touch_inverted: bool,
    pub backup_path: String,
    pub undo: Option<Undo>,
}
#[derive(Default)]
pub struct DeviceSession { pub(crate) current: Option<Snapshot>, recovery: Option<(String, Undo, std::path::PathBuf, Option<bool>)> }
#[derive(Default)]
pub struct DeviceState(pub Mutex<DeviceSession>, Arc<AtomicUsize>, Arc<AtomicUsize>);
// 0 = idle, 1 = running/queued, 2 = stop after the current item readback.
struct BatchOperation(Arc<AtomicUsize>);
impl Drop for BatchOperation { fn drop(&mut self) { self.0.store(0, Ordering::SeqCst); } }
struct DeviceOperation(Arc<AtomicUsize>);
impl DeviceOperation {
    fn new(app: &tauri::AppHandle) -> Self {
        Self::track(app.state::<DeviceState>().1.clone())
    }
    fn track(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}
impl Drop for DeviceOperation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
pub fn is_busy(app: &tauri::AppHandle) -> bool {
    // Poisoned or held state must not be treated as safely idle.
    let state = app.state::<DeviceState>();
    state_busy(&state)
}
fn state_busy(state: &DeviceState) -> bool {
    state.1.load(Ordering::SeqCst) != 0 || state.2.load(Ordering::SeqCst) != 0 || state.0.try_lock().is_err()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRequest {
    pub snapshot_id: String,
    pub index: u8,
    pub expected: Vec<u8>,
    pub target: Vec<u8>,
}
fn check_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the local main window may use the device".into()); }
    if !cfg!(any(target_os = "windows", target_os = "macos")) { return Err("Device access requires Windows or macOS".into()); }
    Ok(())
}
fn decode_snapshot(value: &serde_json::Value) -> Result<Snapshot, String> {
    if value["ok"].as_bool() != Some(true) {
        return Err(format!("{} / 設定送信: {} / バックアップ: {}。再読取りするまで停止します。",
            value["error"].as_str().unwrap_or("Device operation failed"),
            value["settingWriteSent"].as_bool().unwrap_or(false),
            value["backupPath"].as_str().unwrap_or("なし")));
    }
    let raw = &value["snapshot"];
    let text = |key: &str| raw[key].as_str().map(str::to_owned).ok_or_else(|| format!("Missing {key}"));
    let maps: BTreeMap<String, Vec<u8>> = serde_json::from_value(raw["maps"].clone()).map_err(|e| e.to_string())?;
    if maps.len() != 11 || (1..=11).any(|i| maps.get(&i.to_string()).map(Vec::len) != Some(15)) {
        return Err("Invalid live map response; stopped".into());
    }
    if text("firmware")? != "3.2.1" || !is_supported_product_name(&text("product")?) || raw["source"] != "vanzy-live" {
        return Err("Unverified device response; stopped".into());
    }
    Ok(Snapshot {
        snapshot_id: uuid::Uuid::new_v4().to_string(), device_id: text("deviceId")?, product: text("product")?,
        firmware: text("firmware")?, captured_at: text("capturedAt")?, maps,
        touch_inverted: raw["touchInverted"].as_bool().ok_or("Missing touch inversion")?,
        backup_path: value["backupPath"].as_str().ok_or("Missing durable backup")?.to_owned(), undo: None,
    })
}
#[cfg(target_os = "windows")]
fn run_worker(mut request: serde_json::Value, app: &tauri::AppHandle, recovery: Option<&std::path::Path>) -> Result<Snapshot, String> {
    use std::{io::Read, os::windows::process::CommandExt, process::{Command, Stdio}, time::{Duration, Instant}};
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("device-backups");
    std::fs::create_dir_all(&directory).map_err(|e| format!("Backup directory: {e}"))?;
    request["backupDirectory"] = serde_json::json!(directory);
    // Resolve the Windows-owned executable, never PATH or a frontend-supplied program.
    let root = std::env::var_os("SystemRoot").ok_or("Windows SystemRoot missing")?;
    let executable = std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script = include_str!("../transport/vanzy-windows.ps1");
    let mut child = Command::new(executable)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
        .env("VANZY_MANAGER_REQUEST", request.to_string())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn().map_err(|e| format!("Could not start fixed BLE worker: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing worker stdout")?;
    let stderr = child.stderr.take().ok_or("Missing worker stderr")?;
    let out = std::thread::spawn(move || { let mut s=String::new(); let _=stdout.take(65536).read_to_string(&mut s); s });
    let err = std::thread::spawn(move || { let mut s=String::new(); let _=stderr.take(65536).read_to_string(&mut s); s });
    let start = Instant::now();
    let status = loop {
        if let Some(status)=child.try_wait().map_err(|e| e.to_string())? { break status; }
        if start.elapsed() > Duration::from_secs(120) {
            let _=child.kill(); let _=child.wait(); let _=out.join(); let _=err.join();
            return Err("BLE worker timed out. Outcome/notification cleanup may be uncertain. Do not retry a write; read the device first. Backups are preserved.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output=out.join().map_err(|_| "BLE output reader failed")?;
    let error=err.join().map_err(|_| "BLE error reader failed")?;
    let line=output.lines().find_map(|line| line.strip_prefix("VANZY_RESULT:"));
    match line {
        Some(json) if status.success() => {
            let value:serde_json::Value=serde_json::from_str(json).map_err(|e| format!("Invalid worker response: {e}"))?;
            if value["ok"].as_bool()==Some(false) && value["settingWriteSent"].as_bool()==Some(false) {
                if let Some(path)=recovery { resolve_recovery(path)?; }
            }
            decode_snapshot(&value)
        },
        _ => Err(format!("BLE worker failed before a valid result. Device state must be re-read. {}", error.chars().take(600).collect::<String>())),
    }
}
#[cfg(target_os = "macos")]
fn run_worker(mut request: serde_json::Value, app: &tauri::AppHandle, recovery: Option<&std::path::Path>) -> Result<Snapshot, String> {
    use std::{io::Read, process::Stdio, time::{Duration, Instant}};
    request["backupDirectory"] = serde_json::json!(backup_directory(app)?);
    let mut child = crate::mac_worker::command(app, false)?.env("VANZY_MANAGER_REQUEST", request.to_string())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    let stdout=child.stdout.take().ok_or("Missing worker stdout")?;
    let stderr=child.stderr.take().ok_or("Missing worker stderr")?;
    let out=std::thread::spawn(move || {let mut s=String::new();let _=stdout.take(65536).read_to_string(&mut s);s});
    let err=std::thread::spawn(move || {let mut s=String::new();let _=stderr.take(8192).read_to_string(&mut s);s});
    let start=Instant::now();
    let status=loop {
        if let Some(s)=child.try_wait().map_err(|e|e.to_string())? {break s;}
        if start.elapsed()>Duration::from_secs(120) {let _=child.kill();let _=child.wait();return Err("BLE worker timed out. Outcome uncertain; read device before retrying. Backups preserved.".into());}
        std::thread::sleep(Duration::from_millis(50));
    };
    let output=out.join().map_err(|_|"BLE output failed")?;
    let error=err.join().unwrap_or_default();
    let line=output.lines().find_map(|line|line.strip_prefix("VANZY_RESULT:")).ok_or_else(||format!("BLE worker failed: {}",error.chars().take(600).collect::<String>()))?;
    if !status.success() {return Err(format!("BLE worker exited unexpectedly: {error}"));}
    let value:serde_json::Value=serde_json::from_str(line).map_err(|e|e.to_string())?;
    if value["ok"]==false && value["settingWriteSent"]==false {if let Some(path)=recovery {resolve_recovery(path)?;}}
    decode_snapshot(&value)
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn run_worker(_: serde_json::Value, _: &tauri::AppHandle, _: Option<&std::path::Path>) -> Result<Snapshot, String> { Err("Windows-only".into()) }

#[tauri::command]
pub async fn device_read_snapshot(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Snapshot, String> {
    check_window(&window)?;
    let operation = {let _gate=crate::macros::ACTIVITY_GATE.lock().map_err(|_|"Activity gate unavailable")?;if crate::macros::is_running(&app){return Err("Stop the macro before device operations".into())}DeviceOperation::new(&app)};
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let state=app.state::<DeviceState>();
        let mut session=state.0.try_lock().map_err(|_| "Another device operation is running")?;
        session.current=None;
        let mut next=run_worker(serde_json::json!({"operation":"read"}), &app, None)?;
        session.recovery=load_recovery(&app)?;
        if let Some((device, undo, _, inversion)) = &session.recovery {
            next.undo=remaining_undo(device, undo, *inversion, &next);
        }
        session.current=Some(next.clone()); Ok(next)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn device_apply_map(window: tauri::WebviewWindow, app: tauri::AppHandle, request: ApplyRequest) -> Result<Snapshot, String> {
    check_window(&window)?;
    validate_apply_map(request.index, &request.target).map_err(str::to_owned)?;
    let operation = {let _gate=crate::macros::ACTIVITY_GATE.lock().map_err(|_|"Activity gate unavailable")?;if crate::macros::is_running(&app){return Err("Stop the macro before device operations".into())}DeviceOperation::new(&app)};
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let state=app.state::<DeviceState>();
        let mut session=state.0.try_lock().map_err(|_| "Another device operation is running")?;
        crate::recovery_guard::ensure_resolved(&backup_directory(&app)?)?;
        let before=session.current.take().ok_or("Read and back up the device first")?;
        if before.snapshot_id != request.snapshot_id || before.maps.get(&request.index.to_string()) != Some(&request.expected) {
            return Err("Stale preview. Read the device again".into());
        }
        if request.expected == request.target { return Err("No change to apply".into()); }
        let recovery_path=save_recovery(&app, &before, request.index)?;
        session.recovery=Some((before.device_id.clone(), Undo{index:request.index, target:request.expected.clone(),entries:None}, recovery_path.clone(), Some(before.touch_inverted)));
        let mut next=run_worker(serde_json::json!({"operation":"apply", "deviceId":before.device_id,"expectedProduct":before.product,
            "expectedMaps":before.maps, "expectedTouchInverted":before.touch_inverted, "index":request.index, "target":request.target}), &app, Some(&recovery_path))?;
        next.undo=Some(Undo{index:request.index,target:request.expected,entries:None});
        session.current=Some(next.clone()); Ok(next)
    }).await.map_err(|e| e.to_string())?
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchChange { pub index: u8, pub expected: Vec<u8>, pub target: Vec<u8> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchRequest { pub snapshot_id: String, pub changes: Vec<BatchChange>, pub restore: bool }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub index: u8, pub status: &'static str, pub completed: usize, pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")] pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub index: u8, pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub outcome: &'static str, pub items: Vec<BatchItem>, pub snapshot: Option<Snapshot>,
    pub backup_path: Option<String>, pub error: Option<String>,
}
fn validate_batch(before: &Snapshot, request: &BatchRequest) -> Result<(), String> {
    if before.snapshot_id != request.snapshot_id {return Err("Stale preview. Read the device again".into());}
    if !is_supported_product_name(&before.product) || before.firmware != "3.2.1" || before.device_id.is_empty()
        || before.maps.len()!=11 || (1..=11).any(|i| before.maps.get(&i.to_string()).map(Vec::len)!=Some(15)) {
        return Err("Invalid source snapshot".into());
    }
    if request.changes.is_empty() || request.changes.len()>11 {return Err("Batch must contain 1 to 11 changes".into());}
    let mut seen=std::collections::BTreeSet::new();
    for change in &request.changes {
        if !(1..=11).contains(&change.index) || !seen.insert(change.index) || change.expected.len()!=15 || change.target.len()!=15
            || before.maps.get(&change.index.to_string())!=Some(&change.expected) || change.expected==change.target {
            return Err("Invalid, repeated, unchanged or stale batch entry".into());
        }
        if !request.restore {validate_apply_map(change.index,&change.target).map_err(str::to_owned)?;}
    }
    if request.restore {
        let trusted=before.undo.as_ref().ok_or("No trusted recovery available")?.all();
        if trusted.len()!=request.changes.len() || trusted.iter().any(|e| !request.changes.iter().any(|c| c.index==e.index && c.target==e.target)) {
            return Err("Restore must contain exactly the native recovery entries".into());
        }
    }
    Ok(())
}
fn validate_batch_readback(before: &Snapshot, change: &BatchChange, after: &Snapshot) -> Result<(), String> {
    let mut expected=before.maps.clone(); expected.insert(change.index.to_string(),change.target.clone());
    if after.device_id!=before.device_id || after.product!=before.product || after.firmware!=before.firmware
        || after.touch_inverted!=before.touch_inverted || after.maps!=expected || after.backup_path.is_empty() {
        return Err("Batch full snapshot readback mismatch; stop and read again".into());
    }
    Ok(())
}
// One serialized item at a time. Cancellation and channel loss never interrupt a worker.
fn execute_batch(
    mut current: Snapshot, changes: &[BatchChange], stop: &AtomicUsize,
    mut run: impl FnMut(&Snapshot, &BatchChange) -> Result<Snapshot, String>,
    mut emit: impl FnMut(BatchProgress) -> bool,
) -> BatchResult {
    let mut result=BatchResult {outcome:"complete",items:changes.iter().map(|c| BatchItem {index:c.index,status:"pending",error:None}).collect(),snapshot:None,backup_path:None,error:None};
    let mut completed=0;
    for (position,change) in changes.iter().enumerate() {
        if stop.load(Ordering::SeqCst)==2 {result.outcome="stopped";break;}
        if !emit(BatchProgress {index:change.index,status:"running",completed,total:changes.len(),backup_path:result.backup_path.clone(),error:None}) {
            result.outcome="stopped"; result.error=Some("Progress channel closed; no further writes started".into());break;
        }
        // Recheck after notification, before starting this item. A running event is not proof of a write.
        if stop.load(Ordering::SeqCst)==2 {
            result.items[position].status="not_applied";
            let _=emit(BatchProgress {index:change.index,status:"not_applied",completed,total:changes.len(),backup_path:result.backup_path.clone(),error:None});
            result.outcome="stopped";break;
        }
        match run(&current,change).and_then(|next| {validate_batch_readback(&current,change,&next)?;Ok(next)}) {
            Ok(next) => {
                if result.backup_path.is_none() {result.backup_path=Some(next.backup_path.clone());}
                current=next; completed+=1; result.items[position].status="verified";
                if !emit(BatchProgress {index:change.index,status:"verified",completed,total:changes.len(),backup_path:result.backup_path.clone(),error:None}) && completed<changes.len() {
                    result.outcome="stopped";result.error=Some("Progress channel closed; remaining changes were not attempted".into());break;
                }
            },
            Err(error) => {
                result.items[position].status="uncertain";result.items[position].error=Some(error.clone());
                result.outcome="failed";result.error=Some(error.clone());
                let _=emit(BatchProgress {index:change.index,status:"uncertain",completed,total:changes.len(),backup_path:result.backup_path.clone(),error:Some(error)});
                break;
            }
        }
    }
    if result.outcome=="complete" {result.snapshot=Some(current);}
    result
}
#[tauri::command]
pub fn device_cancel_batch(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<bool,String> {
    check_window(&window)?;
    let state=app.state::<DeviceState>();
    // Does not acquire the session mutex held by the worker.
    Ok(state.2.compare_exchange(1,2,Ordering::SeqCst,Ordering::SeqCst).is_ok() || state.2.load(Ordering::SeqCst)==2)
}
#[tauri::command]
pub async fn device_apply_batch(window: tauri::WebviewWindow, app: tauri::AppHandle, request: BatchRequest, progress: tauri::ipc::Channel<BatchProgress>) -> Result<BatchResult,String> {
    check_window(&window)?;
    let state=app.state::<DeviceState>();
    state.2.compare_exchange(0,1,Ordering::SeqCst,Ordering::SeqCst).map_err(|_| "Another batch is running")?;
    let batch=BatchOperation(state.2.clone());
    let operation={let _gate=crate::macros::ACTIVITY_GATE.lock().map_err(|_|"Activity gate unavailable")?;if crate::macros::is_running(&app){return Err("Stop the macro before device operations".into())}DeviceOperation::new(&app)};
    tauri::async_runtime::spawn_blocking(move || {
        let _batch=batch; let _operation=operation;
        if crate::host::is_active(&app) {return Err("Stop the host session before applying a batch".into());}
        let state=app.state::<DeviceState>();
        let mut session=state.0.try_lock().map_err(|_| "Another device operation is running")?;
        crate::recovery_guard::ensure_resolved(&backup_directory(&app)?)?;
        let mut before=session.current.clone().ok_or("Read and back up the device first")?;
        // Restore authorization is reconstructed from the native durable record, never frontend bytes.
        if request.restore {
            session.recovery=load_recovery(&app)?;
            before.undo=session.recovery.as_ref().and_then(|(device,undo,_,inversion)| remaining_undo(device,undo,*inversion,&before));
        }
        validate_batch(&before,&request)?;
        let mut recovery_path=if request.restore {
            Some(session.recovery.as_ref().ok_or("Missing durable recovery")?.2.clone())
        } else {None};
        session.current=None;
        let mut result=execute_batch(before,&request.changes,&state.2, |current,change| {
            // Install the new journal only after initial cancellation/channel checks.
            // A zero-attempt batch must not replace the previous batch's durable Undo.
            if recovery_path.is_none() {
                let indices=request.changes.iter().map(|c|c.index).collect::<Vec<_>>();
                let path=save_batch_recovery(&app,current,&indices)?;
                let undo=Undo::from_entries(request.changes.iter().map(|c|UndoEntry {index:c.index,target:c.expected.clone()}).collect());
                session.recovery=Some((current.device_id.clone(),undo,path.clone(),Some(current.touch_inverted)));
                recovery_path=Some(path);
            }
            // None is intentional: a later not-sent error must never resolve earlier successful items.
            run_worker(serde_json::json!({"operation":if request.restore {"restore"} else {"apply"},"deviceId":current.device_id,"expectedProduct":current.product,
                "expectedMaps":current.maps,"expectedTouchInverted":current.touch_inverted,"index":change.index,"target":change.target}),&app,None)
        }, |event| progress.send(event).is_ok());
        if result.outcome=="complete" && request.restore {
            if let Err(error)=resolve_recovery(recovery_path.as_ref().ok_or("Missing durable recovery")?) {
                result.outcome="failed"; result.error=Some(error);result.snapshot=None;
            } else {session.recovery=None;}
        }
        if let Some(next)=&mut result.snapshot {
            next.undo=session.recovery.as_ref().and_then(|(device,undo,_,inversion)| remaining_undo(device,undo,*inversion,next));
            session.current=Some(next.clone());
        }
        Ok(result)
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn device_restore_previous(window: tauri::WebviewWindow, app: tauri::AppHandle, snapshot_id: String) -> Result<Snapshot, String> {
    check_window(&window)?;
    let operation = {let _gate=crate::macros::ACTIVITY_GATE.lock().map_err(|_|"Activity gate unavailable")?;if crate::macros::is_running(&app){return Err("Stop the macro before device operations".into())}DeviceOperation::new(&app)};
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let state=app.state::<DeviceState>();
        let mut session=state.0.try_lock().map_err(|_| "Another device operation is running")?;
        crate::recovery_guard::ensure_resolved(&backup_directory(&app)?)?;
        let before=session.current.take().ok_or("Read the device first")?;
        if before.snapshot_id != snapshot_id { return Err("Stale preview. Read the device again".into()); }
        let undo=before.undo.ok_or("No previous successful write in this session")?;
        if undo.all().len() != 1 { return Err("Use batch restore for a multi-slot recovery".into()); }
        let next=run_worker(serde_json::json!({"operation":"restore", "deviceId":before.device_id,"expectedProduct":before.product,
            "expectedMaps":before.maps, "expectedTouchInverted":before.touch_inverted, "index":undo.index, "target":undo.target}), &app, None)?;
        if let Some((_, _, path, _)) = &session.recovery { resolve_recovery(path)?; }
        session.recovery=None;
        session.current=Some(next.clone()); Ok(next)
    }).await.map_err(|e| e.to_string())?
}


#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRecord {
    device_id: String, product: String, firmware: String, index: u8, target: Vec<u8>, backup_path: String,
    #[serde(default)] touch_inverted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")] entries: Option<Vec<UndoEntry>>,
}
fn backup_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir=app.path().app_data_dir().map_err(|e| e.to_string())?.join("device-backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?; Ok(dir)
}
fn save_recovery(app: &tauri::AppHandle, before: &Snapshot, index: u8) -> Result<std::path::PathBuf, String> {
    save_batch_recovery(app, before, &[index])
}
fn save_batch_recovery(app: &tauri::AppHandle, before: &Snapshot, indices: &[u8]) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let entries=indices.iter().map(|index| Ok(UndoEntry {index:*index,target:before.maps.get(&index.to_string()).ok_or("Missing original map")?.clone()})).collect::<Result<Vec<_>,String>>()?;
    let first=entries.first().ok_or("Empty recovery batch")?;
    let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let path=backup_directory(app)?.join(format!("recovery-{stamp:020}-{}.json", uuid::Uuid::new_v4()));
    let record=RecoveryRecord{device_id:before.device_id.clone(), product:before.product.clone(), firmware:before.firmware.clone(),
        touch_inverted:Some(before.touch_inverted),index:first.index,target:first.target.clone(),entries:Some(entries),backup_path:before.backup_path.clone()};
    let bytes=serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("Recovery record: {e}"))?;
    if std::fs::read(&path).map_err(|e| e.to_string())? != bytes {return Err("Recovery record readback mismatch".into());}
    Ok(path)
}
fn load_recovery(app: &tauri::AppHandle) -> Result<Option<(String, Undo, std::path::PathBuf, Option<bool>)>, String> {
    let mut paths=std::fs::read_dir(backup_directory(app)?).map_err(|e| e.to_string())?
        .filter_map(Result::ok).map(|e| e.path()).filter(|p| {
            p.file_name().and_then(|n|n.to_str()).map_or(false, |n|n.starts_with("recovery-") && n.ends_with(".json"))
        }).collect::<Vec<_>>();
    paths.sort();
    let Some(path)=paths.pop() else {return Ok(None)};
    if path.with_extension("resolved").exists() {return Ok(None)}
    let bytes=std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len()>8192 {return Err("Invalid recovery record size".into());}
    let record:RecoveryRecord=serde_json::from_slice(&bytes).map_err(|e| format!("Recovery record invalid; no write allowed: {e}"))?;
    validate_recovery(&record)?;
    Ok(Some((record.device_id,Undo{index:record.index,target:record.target,entries:record.entries},path,record.touch_inverted)))
}
fn validate_recovery(record: &RecoveryRecord) -> Result<(), String> {
    if !is_supported_product_name(&record.product) || record.firmware!="3.2.1" || record.device_id.is_empty()
        || !(1..=11).contains(&record.index) || (record.index > 4 && record.touch_inverted.is_none()) || record.target.len()!=15 {return Err("Unverified recovery record".into());}
    if let Some(entries)=&record.entries {
        let mut seen=std::collections::BTreeSet::new();
        if entries.is_empty() || entries.len()>11 || entries[0].index != record.index || entries[0].target != record.target
            || entries.iter().any(|e| !(1..=11).contains(&e.index) || !seen.insert(e.index) || e.target.len()!=15 || (e.index>4 && record.touch_inverted.is_none())) {
            return Err("Invalid batch recovery entries".into());
        }
    }
    Ok(())
}
fn resolve_recovery(path: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path.with_extension("resolved")).map_err(|e|e.to_string())?;
    file.write_all(b"Restored and read back by VANZY Manager\n").and_then(|_|file.sync_all()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod operation_tests {
    use super::*;
    #[test]
    fn queued_worker_stays_busy_before_mutex_is_taken() {
        let state = DeviceState::default();
        let operation = DeviceOperation::track(state.1.clone());
        assert!(state_busy(&state));
        let worker = move || { let _operation = operation; };
        // The worker owns the guard independently of the command future.
        assert!(state_busy(&state));
        worker();
        assert!(!state_busy(&state));
    }
    #[test]
    fn early_error_and_panic_release_only_their_operation() {
        let state = DeviceState::default();
        let outer = DeviceOperation::track(state.1.clone());
        let failure = || -> Result<(), ()> {
            let _operation = DeviceOperation::track(state.1.clone());
            Err(())
        };
        assert!(failure().is_err());
        assert_eq!(state.1.load(Ordering::SeqCst), 1);
        let _ = std::panic::catch_unwind(|| {
            let _operation = DeviceOperation::track(state.1.clone());
            panic!("fixture worker panic");
        });
        assert_eq!(state.1.load(Ordering::SeqCst), 1);
        drop(outer);
        assert!(!state_busy(&state));
    }
    #[test]
    fn locked_or_poisoned_device_state_is_busy() {
        let state = DeviceState::default();
        let lock = state.0.lock().unwrap();
        assert!(state_busy(&state));
        drop(lock);
        let _ = std::panic::catch_unwind(|| {
            let _lock = state.0.lock().unwrap();
            panic!("fixture poisoned state");
        });
        assert!(state_busy(&state));
    }
}



#[cfg(test)]
mod batch_tests {
    use super::*;
    fn key(code: u8) -> Vec<u8> { let mut bytes=vec![5,0,code];bytes.resize(15,0);bytes }
    fn snapshot() -> Snapshot {
        Snapshot {snapshot_id:"preview".into(),device_id:"fixture".into(),product:"VANZY#1-0000/A2".into(),firmware:"3.2.1".into(),captured_at:"offline".into(),maps:(1..=11).map(|i|(i.to_string(),key(4))).collect(),touch_inverted:false,backup_path:"fixture-backup".into(),undo:None}
    }
    fn changes() -> Vec<BatchChange> {(1..=3).map(|index|BatchChange {index,expected:key(4),target:key(5)}).collect()}
    fn request() -> BatchRequest {BatchRequest {snapshot_id:"preview".into(),changes:changes(),restore:false}}
    fn apply(before: &Snapshot, change: &BatchChange) -> Result<Snapshot,String> {
        let mut next=before.clone();next.maps.insert(change.index.to_string(),change.target.clone());Ok(next)
    }
    fn statuses(result: &BatchResult) -> Vec<&'static str> {result.items.iter().map(|i|i.status).collect()}
    #[test]
    fn preflights_entire_batch_before_any_worker() {
        let before=snapshot();assert!(validate_batch(&before,&request()).is_ok());
        for variant in 0..9 {
            let mut req=request();
            match variant {
                0=>req.changes.clear(),
                1=>req.changes.push(req.changes[0].clone()),
                2=>req.changes[2].index=12,
                3=>req.changes[2].target=vec![0;15],
                4=>req.changes[2].expected=key(6),
                5=>req.changes[2].target=key(4),
                6=>req.changes[2].target.pop().map(|_|()).unwrap(),
                7=>req.snapshot_id="stale".into(),
                _=>req.changes=vec![req.changes[0].clone();12],
            }
            assert!(validate_batch(&before,&req).is_err(),"variant {variant}");
        }
    }
    #[test]
    fn sequential_workers_receive_latest_full_snapshot_and_progress() {
        let stop=AtomicUsize::new(1);let mut calls=0;let mut events=vec![];
        let result=execute_batch(snapshot(),&changes(),&stop,|before,change| {
            calls+=1;
            for previous in 1..change.index {assert_eq!(before.maps[&previous.to_string()],key(5));}
            apply(before,change)
        },|event| {events.push((event.index,event.status,event.completed));true});
        assert_eq!(calls,3);assert_eq!(result.outcome,"complete");assert_eq!(statuses(&result),vec!["verified";3]);
        assert!(result.snapshot.is_some());assert_eq!(events,vec![(1,"running",0),(1,"verified",1),(2,"running",1),(2,"verified",2),(3,"running",2),(3,"verified",3)]);
    }
    #[test]
    fn failure_preserves_success_and_unreached_entries_without_retry() {
        let mut calls=0;
        let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(1),|before,change| {
            calls+=1;if change.index==2 {Err("uncertain write".into())} else {apply(before,change)}
        },|_|true);
        assert_eq!(calls,2);assert_eq!(result.outcome,"failed");assert_eq!(statuses(&result),vec!["verified","uncertain","pending"]);assert!(result.snapshot.is_none());
    }
    #[test]
    fn cancellation_waits_for_current_verification_then_stops() {
        let stop=AtomicUsize::new(1);let mut calls=0;
        let result=execute_batch(snapshot(),&changes(),&stop,|before,change| {
            calls+=1;stop.store(2,Ordering::SeqCst);apply(before,change)
        },|_|true);
        assert_eq!(calls,1);assert_eq!(result.outcome,"stopped");assert_eq!(statuses(&result),vec!["verified","pending","pending"]);assert!(result.snapshot.is_none());
    }
    #[test]
    fn cancellation_before_start_and_channel_loss_never_start_remaining_workers() {
        let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(2),|_,_|panic!("must not write"),|_|true);
        assert_eq!(statuses(&result),vec!["pending";3]);assert_eq!(result.outcome,"stopped");
        let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(1),apply,|e|e.status!="verified");
        assert_eq!(statuses(&result),vec!["verified","pending","pending"]);assert_eq!(result.outcome,"stopped");
        let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(1),|_,_|panic!("must not write"),|_|false);
        assert_eq!(statuses(&result),vec!["pending";3]);
    }
    #[test]
    fn native_readback_checks_all_slots_identity_firmware_and_inversion() {
        for variant in 0..6 {
            let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(1),|before,change| {
                let mut next=apply(before,change)?;
                match variant {
                    0=>{next.maps.insert("11".into(),key(6));},
                    1=>next.device_id="different".into(),2=>next.touch_inverted=true,
                    3=>next.firmware="other".into(),4=>next.product="other".into(),_=>next.backup_path.clear(),
                } Ok(next)
            },|_|true);
            assert_eq!(statuses(&result),vec!["uncertain","pending","pending"]);assert!(result.snapshot.is_none());
        }
    }
    #[test]
    fn restore_requires_exact_trusted_remaining_entries() {
        let mut before=snapshot();let trusted=Undo::from_entries(vec![UndoEntry {index:1,target:key(6)},UndoEntry {index:3,target:vec![0;15]}]);before.undo=Some(trusted.clone());
        let mut req=BatchRequest {snapshot_id:before.snapshot_id.clone(),changes:trusted.all().iter().map(|e|BatchChange {index:e.index,expected:key(4),target:e.target.clone()}).collect(),restore:true};
        assert!(validate_batch(&before,&req).is_ok());req.changes.reverse();assert!(validate_batch(&before,&req).is_ok());
        req.changes[0].target=key(7);assert!(validate_batch(&before,&req).is_err());req.changes.pop();assert!(validate_batch(&before,&req).is_err());
        before.maps.insert("1".into(),key(6));let remaining=remaining_undo("fixture",&trusted,Some(false),&before).unwrap();assert_eq!(remaining.all(),vec![UndoEntry {index:3,target:vec![0;15]}]);
        assert!(remaining_undo("other",&trusted,Some(false),&before).is_none());assert!(remaining_undo("fixture",&trusted,Some(true),&before).is_none());
    }
    #[test]
    fn legacy_and_batch_records_roundtrip_and_reject_invalid_entries() {
        let legacy=serde_json::json!({"deviceId":"fixture","product":"VANZY#1-0000/A2","firmware":"3.2.1","index":1,"target":key(4),"backupPath":"original"});
        let mut record:RecoveryRecord=serde_json::from_value(legacy).unwrap();assert!(validate_recovery(&record).is_ok());
        record.entries=Some(vec![UndoEntry {index:1,target:key(4)},UndoEntry {index:5,target:key(6)}]);assert!(validate_recovery(&record).is_err());
        record.touch_inverted=Some(false);assert!(validate_recovery(&record).is_ok());
        let bytes=serde_json::to_vec(&record).unwrap();let loaded:RecoveryRecord=serde_json::from_slice(&bytes).unwrap();assert_eq!(record.entries,loaded.entries);
        for entries in [vec![],vec![UndoEntry {index:2,target:key(4)}],vec![UndoEntry {index:1,target:key(4)},UndoEntry {index:1,target:key(4)}],vec![UndoEntry {index:1,target:vec![0;14]}]] {
            record.entries=Some(entries);assert!(validate_recovery(&record).is_err());
        }
    }
    #[test]
    fn zero_attempt_batches_preserve_previous_recovery() {
        for mode in 0..3 {
            let stop=AtomicUsize::new(if mode==0 {2} else {1});
            let prior=Undo::from_entries(vec![UndoEntry {index:4,target:key(6)}]);
            let mut recovery=("batch-a-journal".to_owned(),prior.clone());
            let mut attempts=0;
            let result=execute_batch(snapshot(),&changes(),&stop,|before,change| {
                // Mirrors lazy journal publication in the production worker closure.
                recovery=("batch-b-journal".into(),Undo::from_entries(vec![UndoEntry {index:1,target:key(4)}]));
                attempts+=1;apply(before,change)
            },|_| {
                if mode==2 {stop.store(2,Ordering::SeqCst);}
                mode!=1
            });
            assert_eq!(attempts,0);assert_eq!(result.outcome,"stopped");
            assert_eq!(recovery.0,"batch-a-journal");assert_eq!(recovery.1.all(),prior.all());
            assert!(result.backup_path.is_none());
        }
    }
    #[test]
    fn backup_path_is_unknown_until_first_verified_worker_then_stays_original() {
        let mut events=vec![];
        let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(1),|before,change| {
            let mut next=apply(before,change)?;
            next.backup_path=format!("full-backup-before-slot-{}",change.index);Ok(next)
        },|event| {events.push((event.status,event.backup_path));true});
        assert_eq!(events[0],("running",None));
        for (_,path) in &events[1..] {assert_eq!(path.as_deref(),Some("full-backup-before-slot-1"));}
        assert_eq!(result.backup_path.as_deref(),Some("full-backup-before-slot-1"));
        for failure_index in [1,2] {
            let mut events=vec![];
            let result=execute_batch(snapshot(),&changes(),&AtomicUsize::new(1),|before,change| {
                if change.index==failure_index {return Err("worker failed without verified backup result".into());}
                let mut next=apply(before,change)?;next.backup_path="original-full-backup".into();Ok(next)
            },|event| {events.push(event);true});
            let expected=if failure_index==1 {None} else {Some("original-full-backup")};
            assert_eq!(result.backup_path.as_deref(),expected);
            assert_eq!(events.last().unwrap().backup_path.as_deref(),expected);
            assert_eq!(events.last().unwrap().status,"uncertain");
        }
    }
    #[test]
    fn batch_guard_is_busy_while_queued_and_releases_on_error() {
        let state=DeviceState::default();state.2.store(1,Ordering::SeqCst);let batch=BatchOperation(state.2.clone());assert!(state_busy(&state));
        state.2.store(2,Ordering::SeqCst);assert!(state_busy(&state));drop(batch);assert!(!state_busy(&state));
    }
}
