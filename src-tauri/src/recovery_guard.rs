//! Fail closed before ordinary map writes when host restoration is unresolved.
use std::path::Path;
use vanzy_safety_core::protocol::is_supported_product_name;

pub fn ensure_resolved(directory: &Path) -> Result<(), String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot verify host recovery records: {error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot read host recovery records: {e}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("host-recovery-") || !name.ends_with(".json") {
            continue;
        }
        if entry.metadata().map_err(|e| e.to_string())?.len() > 262_144 {
            return Err("Host recovery record is oversized; ordinary writes blocked".into());
        }
        let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        validate(&bytes)?;
    }
    Ok(())
}

fn validate(bytes: &[u8]) -> Result<(), String> {
    let record: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("Invalid host recovery record; ordinary writes blocked: {e}"))?;
    if !matches!(record["schemaVersion"].as_u64(), Some(1 | 2))
        || record["source"] != "vanzy-host"
        || !record["product"].as_str().is_some_and(is_supported_product_name)
        || record["firmware"] != "3.2.1"
        || !record["deviceId"].as_str().is_some_and(|id| !id.is_empty())
        || record["resolved"].as_bool().is_none()
    {
        return Err("Invalid host recovery identity/state; ordinary writes blocked".into());
    }
    if record["resolved"] != true {
        return Err("Unresolved host restoration. Use host recovery before changing any device map; no settings written".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> serde_json::Value {
        serde_json::json!({"schemaVersion":2,"source":"vanzy-host","product":"VANZY#1-0000/A2","firmware":"3.2.1","deviceId":"test-device","resolved":true})
    }
    #[test]
    fn accepts_only_confirmed_supported_records() {
        for version in [1, 2] {
            let mut value = record();
            value["schemaVersion"] = version.into();
            assert!(validate(&serde_json::to_vec(&value).unwrap()).is_ok());
        }
    }
    #[test]
    fn pending_missing_malformed_and_wrong_identity_block_writes() {
        for (key, value) in [
            ("resolved", serde_json::json!(false)),
            ("resolved", serde_json::Value::Null),
            ("resolved", serde_json::json!("true")),
            ("source", serde_json::json!("other")),
            ("product", serde_json::json!("VANZY#1-0000/A3")),
            ("firmware", serde_json::json!("other")),
            ("deviceId", serde_json::json!("")),
            ("schemaVersion", serde_json::json!(3)),
        ] {
            let mut r = record();
            r[key] = value;
            assert!(validate(&serde_json::to_vec(&r).unwrap()).is_err());
        }
        assert!(validate(b"{").is_err());
    }
    #[test]
    fn checks_every_journal_not_only_the_latest() {
        let directory = std::env::temp_dir().join(format!("vanzy-recovery-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("host-recovery-new.json"), serde_json::to_vec(&record()).unwrap()).unwrap();
        let mut pending = record();
        pending["resolved"] = false.into();
        let old = directory.join("host-recovery-old.json");
        std::fs::write(&old, serde_json::to_vec(&pending).unwrap()).unwrap();
        assert!(ensure_resolved(&directory).is_err());
        std::fs::write(&old, serde_json::to_vec(&record()).unwrap()).unwrap();
        assert!(ensure_resolved(&directory).is_ok());
        std::fs::remove_file(old).unwrap();
        std::fs::remove_file(directory.join("host-recovery-new.json")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
