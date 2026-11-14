import Foundation
import CoreFoundation

@main struct VanzyWorker {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            do { try selfTest(); print("VANZY_SELF_TEST:ok"); exit(0) } catch { fputs("\(error)\n",stderr); exit(1) }
        }
        var result: [String:Any] = [:], backupPath: String? = nil
        var settingWriteSent = false
        let ble = VanzyBLE()
        var lock: VanzyTransportLock?
        do {
            guard let raw = ProcessInfo.processInfo.environment["VANZY_MANAGER_REQUEST"], raw.utf8.count <= 65536,
                  let data = raw.data(using:.utf8), let request = try JSONSerialization.jsonObject(with:data) as? [String:Any],
                  let operation = request["operation"] as? String, ["read","apply","restore"].contains(operation),
                  let directory = request["backupDirectory"] as? String else { throw VanzyError("Invalid worker request") }
            lock = try VanzyTransportLock(directory:directory)
            if operation != "read" { try assertHostRecoveryResolved(directory) }
            try ble.connect()
            if operation != "read" { guard request["deviceId"] as? String == ble.deviceID, request["expectedProduct"] as? String == ble.product else { throw VanzyError("Device identity changed") } }
            let firmware = String(bytes:try ble.readCommand(0x12), encoding:.utf8)
            guard firmware == "3.2.1" else { throw VanzyError("Unverified firmware; no settings written") }
            let inversion = try ble.readCommand(0x25)[0] == 1
            var live = try ble.readAllMaps()
            guard try ble.readCommand(0x25)[0] == (inversion ? 1 : 0) else { throw VanzyError("Touch inversion changed while reading") }
            var record: [String:Any] = ["schemaVersion":2,"source":"vanzy-live","deviceId":ble.deviceID,"product":ble.product,"firmware":"3.2.1","capturedAt":ISO8601DateFormatter().string(from:Date()),"maps":live,"touchInverted":inversion]
            backupPath = try saveRecord(record,directory:directory,kind:"before")
            if operation != "read" {
                guard try bool(request["expectedTouchInverted"]) == inversion, try maps(request["expectedMaps"]) == live else { throw VanzyError("Settings changed since preview; nothing written") }
                guard let number = request["index"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.rounded() == number.doubleValue else { throw VanzyError("Invalid slot") }
                let index = number.intValue, target = try bytes(request["target"]), address = try slot(index)
                if operation == "apply" && !allowedApply(index,target) { throw VanzyError("Only verified keyboard actions or exact FW defaults are supported") }
                guard live[String(index)] != target else { throw VanzyError("No change to write") }
                guard try ble.readCommand(0x25)[0] == (inversion ? 1 : 0) else { throw VanzyError("Touch inversion changed before write") }
                settingWriteSent = true // conservative even if transport then fails
                try ble.send([0x90,0,0,address.0,address.1] + target)
                RunLoop.current.run(until:Date().addingTimeInterval(0.4))
                guard try ble.readCommand(address.0,Int(address.1)) == target else { throw VanzyError("Readback mismatch; outcome uncertain, backup preserved") }
                live[String(index)] = target
                guard try ble.readCommand(0x25)[0] == (inversion ? 1 : 0), try ble.readAllMaps() == live, try ble.readCommand(0x25)[0] == (inversion ? 1 : 0) else { throw VanzyError("Full snapshot verification failed; stop and read again") }
                record["maps"] = live; record["capturedAt"] = ISO8601DateFormatter().string(from:Date())
                _ = try saveRecord(record,directory:directory,kind:"verified")
            }
            result = ["ok":true,"snapshot":record,"settingWriteSent":settingWriteSent,"backupPath":backupPath!]
        } catch { result = ["ok":false,"error":String(describing:error),"settingWriteSent":settingWriteSent,"backupPath":backupPath as Any? ?? NSNull()] }
        do { try ble.close() } catch { result = ["ok":false,"error":"Notification cleanup failed: \(error)","settingWriteSent":settingWriteSent,"backupPath":backupPath as Any? ?? NSNull()] }
        withExtendedLifetime(lock) {
            if let data = try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]), let json = String(data:data,encoding:.utf8) { print("VANZY_RESULT:" + json) }
        }
    }
    static func selfTest() throws {
        func expect(_ ok: Bool) throws { if !ok { throw VanzyError("Self test failed") } }
        try expect(supportedProduct("VANZY#1-ABCD/A2") && !supportedProduct("VANZY#1-abcd/A2"))
        try expect(!supportedProduct("VANZY#1-ABCD/A2\n"))
        for id in 1...11 {
            let address = try slot(id); try expect(address.0 == (id <= 7 ? 0x44 : 0x4b))
            try expect(allowedApply(id,[5,0,4]+Array(repeating:0,count:12)))
            try expect(!allowedApply(id,[5,16,4]+Array(repeating:0,count:12)))
        }
        try expect(!allowedApply(1,[4,1,0]+Array(repeating:0,count:12)))
        try expect(allowedApply(5,[4,1,0]+Array(repeating:0,count:12)))
        for raw: Any in [[true]+Array(repeating:0,count:14), [1.1]+Array(repeating:0.0,count:14), Array(repeating:256,count:15)] {
            do { _ = try bytes(raw); throw VanzyError("Invalid bytes accepted") } catch let e as VanzyError { if e.description == "Invalid bytes accepted" { throw e } }
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vanzy-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:false)
        defer { try? FileManager.default.removeItem(at:dir) }
        let record: [String:Any] = ["source":"fixture","maps":["1":[5,0,4]]]
        let path = try saveRecord(record,directory:dir.path,kind:"before")
        try expect(FileManager.default.fileExists(atPath:path))
        let lock = try VanzyTransportLock(directory:dir.path)
        do { _ = try VanzyTransportLock(directory:dir.path); throw VanzyError("Duplicate lock accepted") } catch let e as VanzyError { if e.description == "Duplicate lock accepted" { throw e } }
        withExtendedLifetime(lock) {}
    }
}
