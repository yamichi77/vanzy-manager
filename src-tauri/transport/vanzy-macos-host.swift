import Foundation
import CoreFoundation
import Darwin

private struct HostError: Error, CustomStringConvertible { let description: String; init(_ s: String) { description = s } }
// A dead parent closes stdout. Never let SIGPIPE bypass durable restoration.
@discardableResult
private func emitHost(_ value: [String: Any], to output: FileHandle = .standardOutput) -> Bool {
    do {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        data.append(10)
        try output.write(contentsOf: data)
        return true
    } catch { return false }
}
private func hostDate() -> String { ISO8601DateFormatter().string(from: Date()) }
private func integer(_ value: Any?) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.intValue) else { return nil }; return n.intValue
}
private func boolean(_ value: Any?) -> Bool? {
    guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
}
private func hostMaps(_ value: Any?) throws -> [String: [UInt8]] {
    guard let raw = value as? [String: Any], raw.count == 11 else { throw HostError("Expected all eleven maps") }
    var result: [String: [UInt8]] = [:]
    for index in 1...11 {
        guard let bytes = raw[String(index)] as? [Any], bytes.count == 15 else { throw HostError("Invalid map length") }
        result[String(index)] = try bytes.map { value in
            guard let n = integer(value), (0...255).contains(n) else { throw HostError("Map byte is not an integer byte") }; return UInt8(n)
        }
    }
    return result
}
private func eventID(_ bytes: [UInt8], allowed: Set<Int>) -> Int? {
    guard bytes.count == 7, Array(bytes[0...3]) == [0x31, 0, 0, 0xc0], bytes[5] == 0, bytes[6] == 0, allowed.contains(Int(bytes[4])) else { return nil }
    return Int(bytes[4])
}
private func restorePreflight(_ observed: [String: [UInt8]], original: [String: [UInt8]], installed: [String: [UInt8]]) throws {
    guard observed.count == 11 else { throw HostError("Incomplete restoration snapshot") }
    for i in 1...11 {
        let key = String(i)
        guard observed[key] == original[key] || (installed[key] != nil && observed[key] == installed[key]) else { throw HostError("External map change detected; restoration blocked") }
    }
}
private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock(); private var value = false
    func stop() { lock.lock(); value = true; lock.unlock() }
    var stopped: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private final class HostSession {
    let ble = VanzyBLE(); let stop = StopFlag()
    var output: FileHandle = .standardOutput
    func emit(_ value: [String: Any]) {
        if !emitHost(value, to: output) { stop.stop() }
    }
    var original: [String: [UInt8]] = [:], installed: [String: [UInt8]] = [:]
    var plan: [[String: Int]] = [], attempted = Set<Int>()
    var inversion = false, armed = false
    var journal: String?, evidence: Data?, record: [String: Any] = [:]
    var signals: [DispatchSourceSignal] = []
    var transportLock: VanzyTransportLock?
    func checkStop() throws { if stop.stopped { throw HostError("Host stop requested") } }
    func readMap(_ i: Int) throws -> [UInt8] { let (c, r) = try slot(i); return try ble.readCommand(c, Int(r)) }
    func checkInversion() throws {
        let value = try ble.readCommand(0x25)
        guard value == [inversion ? 1 : 0] else { throw HostError("Touch inversion changed; no further map writes allowed") }
    }
    func writeMap(_ i: Int, _ value: [UInt8]) throws {
        let key = String(i)
        guard value.count == 15, installed[key] != nil, value == installed[key] || value == original[key] else { throw HostError("Map outside authorized install/restore plan") }
        try checkInversion()
        let (c, r) = try slot(i)
        try ble.send([0x90, 0, 0, c, UInt8(r)] + value)
        let until = Date().addingTimeInterval(0.4)
        while Date() < until { RunLoop.current.run(until: min(until, Date().addingTimeInterval(0.02))) }
        guard try readMap(i) == value else { throw HostError("Map write readback mismatch; no automatic reapply") }
    }
    func runtimeMode() throws {
        let value = try ble.readCommand(0x16)
        guard value.count == 1 else { throw HostError("Invalid runtime mode") }
        emit(["type": "HOST_MODE", "runtimeMode": Int(value[0]), "modeReadAt": hostDate()])
        guard value[0] == 2 else { throw HostError("Gesture mode (2) required; read runtime mode \(value[0]). Runtime mode was not changed.") }
    }
    func receive(_ bytes: [UInt8]) {
        guard armed, !stop.stopped, let id = eventID(bytes, allowed: Set(plan.compactMap { $0["id"] })),
              let binding = plan.first(where: { $0["id"] == id }) else { return }
        emit(["type": "HOST_EVENT", "id": id, "index": binding["index"]!, "receivedAt": hostDate()])
    }
    func drain() throws {
        try ble.checkHealth()
        for bytes in ble.drainNotifications() { receive(bytes) }
    }
    func resolveJournal() throws {
        guard let path = journal, let evidence else { return }
        let url = URL(fileURLWithPath: path)
        guard try Data(contentsOf: url) == evidence else { throw HostError("Journal changed; not marking resolved") }
        var resolved = record; resolved["resolved"] = true; resolved["resolvedAt"] = hostDate()
        let data = try JSONSerialization.data(withJSONObject: resolved, options: [.sortedKeys, .prettyPrinted])
        let temporary = path + "." + UUID().uuidString + ".tmp"
        let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw HostError("Cannot create resolved journal") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: data); try handle.synchronize(); try handle.close()
        guard try Data(contentsOf: URL(fileURLWithPath: temporary)) == data, try Data(contentsOf: url) == evidence else { throw HostError("Journal verification failed") }
        guard Darwin.rename(temporary, path) == 0 else { throw HostError("Atomic journal resolution failed") }
        let directory = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
        guard directory >= 0 else { throw HostError("Journal directory durability unavailable") }
        defer { Darwin.close(directory) }
        guard fsync(directory) == 0, try Data(contentsOf: url) == data else { throw HostError("Resolved journal verification failed") }
    }
    func restore() throws {
        try checkInversion()
        // Preflight the complete plan before any restoration write; never overwrite an external edit.
        try restorePreflight(ble.readAllMaps(), original: original, installed: installed)
        for binding in plan where attempted.contains(binding["index"]!) {
            let i = binding["index"]!, key = String(i), current = try readMap(i)
            if current == original[key] { continue }
            guard current == installed[key] else { throw HostError("External edit during restoration; stopped") }
            try writeMap(i, original[key]!)
        }
        // Verify every original slot, not merely the last write.
        guard try ble.readAllMaps() == original else { throw HostError("Full restoration readback mismatch") }
        try checkInversion()
    }
    func run(_ request: [String: Any]) {
        var failure: String?, restoreError: String?, cleanup: [String] = []
        var restoration = "not-needed"
        do {
            guard let id = request["deviceId"] as? String, !id.isEmpty, let directory = request["backupDirectory"] as? String else { throw HostError("Missing device identity/backup directory") }
            let operation = request["operation"] as? String ?? "start"
            guard ["start", "recover"].contains(operation) else { throw HostError("Operation rejected") }
            let recover = operation == "recover"
            var product: String
            if recover {
                restoration = "recovery-not-started"
                guard let path = request["recoveryPath"] as? String else { throw HostError("Missing recovery path") }
                let url = URL(fileURLWithPath: path).standardizedFileURL, dir = URL(fileURLWithPath: directory).standardizedFileURL
                guard url.deletingLastPathComponent() == dir, url.lastPathComponent.range(of: "^host-recovery-[A-Za-z0-9-]+\\.json$", options: .regularExpression) != nil,
                      url.resolvingSymlinksInPath() == url, dir.resolvingSymlinksInPath() == dir else { throw HostError("Recovery path invalid or traverses symlink") }
                let data = try Data(contentsOf: url)
                guard data.count <= 262144, let saved = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      integer(saved["schemaVersion"]) == 2, saved["source"] as? String == "vanzy-host", saved["firmware"] as? String == "3.2.1", saved["deviceId"] as? String == id,
                      boolean(saved["resolved"]) == false, let inv = boolean(saved["touchInverted"]), let p = saved["product"] as? String else { throw HostError("Recovery identity/schema/state mismatch (Mac requires v2)") }
                record = saved; evidence = data; journal = path; inversion = inv; product = p
                original = try hostMaps(saved["originalMaps"])
            } else {
                guard let inv = boolean(request["expectedTouchInverted"]), let p = request["expectedProduct"] as? String else { throw HostError("Missing expected product/inversion") }
                inversion = inv; product = p; original = try hostMaps(request["expectedMaps"])
            }
            guard product.range(of: "^VANZY#1-[0-9A-F]{4}/A2$", options: .regularExpression) != nil else { throw HostError("Unsupported product") }
            let rawPlan = recover ? record["plan"] : request["bindings"]
            guard let bindings = rawPlan as? [[String: Any]], (1...11).contains(bindings.count) else { throw HostError("Invalid binding count") }
            for binding in bindings {
                guard let i = integer(binding["index"]), let marker = integer(binding["id"]), (1...11).contains(i), marker == i, installed[String(i)] == nil else { throw HostError("Invalid/duplicate binding") }
                let value: [UInt8] = [8, UInt8(marker)] + Array(repeating: 0, count: 13)
                installed[String(i)] = value; plan.append(["index": i, "id": marker])
            }
            if recover {
                guard let rawMarkers = record["markerMaps"] as? [String: Any], rawMarkers.count == installed.count else { throw HostError("Recovery marker plan mismatch") }
                for (key, marker) in installed { guard try bytes(rawMarkers[key]) == marker else { throw HostError("Recovery marker bytes mismatch") } }
            } else { try assertHostRecoveryResolved(directory) }
            ble.onNotification = { [weak self] packet in self?.receive(packet) }
            transportLock = try VanzyTransportLock(directory: directory)
            try ble.connect()
            guard ble.deviceID == id, ble.product == product else { throw HostError("Device identity changed") }
            guard String(bytes: try ble.readCommand(0x12), encoding: .utf8) == "3.2.1" else { throw HostError("Unsupported firmware; no settings written") }
            try checkInversion()
            if recover {
                guard try Data(contentsOf: URL(fileURLWithPath: journal!)) == evidence else { throw HostError("Recovery journal changed") }
                attempted = Set(plan.map { $0["index"]! })
            } else {
                try assertHostRecoveryResolved(directory)
                try runtimeMode()
                guard try ble.readAllMaps() == original else { throw HostError("Settings changed since preview; nothing written") }
                var candidates = original.filter { installed[$0.key] == nil }.map { $0.value }
                candidates.append(try ble.readCommand(0x44, 8))
                for i in [1, 2, 4, 5, 6] { candidates.append(try ble.readCommand(0x4b, i)) }
                for map in candidates {
                    for offset in stride(from: 0, to: 15, by: 3) {
                        if map[offset] == 0 { break }
                        if map[offset] == 8 && plan.contains(where: { $0["id"] == Int(map[offset + 1]) }) { throw HostError("Unselected gesture uses reserved marker ID; nothing written") }
                    }
                }
                let flag = stop
                DispatchQueue.global().async { while let line = readLine() { if line.trimmingCharacters(in: .whitespacesAndNewlines) == "STOP" { break } }; flag.stop() }
                for sig in [SIGTERM, SIGINT] {
                    signal(sig, SIG_IGN)
                    let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
                    source.setEventHandler { flag.stop() }; source.resume(); signals.append(source)
                }
                try checkStop()
                record = ["schemaVersion": 2, "source": "vanzy-host", "deviceId": id, "product": product, "firmware": "3.2.1", "capturedAt": hostDate(), "touchInverted": inversion, "originalMaps": original, "markerMaps": installed, "plan": plan, "maps": original, "installedMaps": installed, "bindings": plan, "resolved": false]
                journal = try saveRecord(record, directory: directory, kind: "host-recovery")
                evidence = try Data(contentsOf: URL(fileURLWithPath: journal!))
                for binding in plan {
                    try checkStop()
                    let i = binding["index"]!, key = String(i)
                    guard try readMap(i) == original[key] else { throw HostError("Settings changed before installation") }
                    if original[key] != installed[key] { attempted.insert(i); try writeMap(i, installed[key]!) }
                }
                var expected = original
                for (key, value) in installed { expected[key] = value }
                guard try ble.readAllMaps() == expected else { throw HostError("Installed map changed before arming") }
                try checkStop(); try runtimeMode(); _ = ble.drainNotifications(); armed = true
                emit(["type": "HOST_READY", "deviceId": id, "backupPath": journal!, "bindings": plan, "touchInverted": inversion])
                var nextMode = Date().addingTimeInterval(1)
                while !stop.stopped {
                    try drain()
                    if Date() >= nextMode { try runtimeMode(); nextMode = Date().addingTimeInterval(1) }
                    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
                }
            }
        } catch { failure = String(describing: error) }
        armed = false
        if !attempted.isEmpty {
            restoration = "unverified"
            do { try restore(); restoration = "restored" } catch { restoreError = String(describing: error) }
        }
        if restoration == "restored" || restoration == "not-needed" {
            do { try resolveJournal() } catch { cleanup.append(String(describing: error)) }
        }
        do { try ble.close() } catch { cleanup.append(String(describing: error)) }
        emitHost(["type": "HOST_END", "ok": failure == nil && restoreError == nil && cleanup.isEmpty, "error": failure as Any? ?? NSNull(), "restoration": restoration, "restorationError": restoreError as Any? ?? NSNull(), "cleanupErrors": cleanup, "backupPath": journal as Any? ?? NSNull(), "attemptedIndices": attempted.sorted()])
    }
}
@main private enum VanzyMacHost {
    static func selfTest() throws {
        func expect(_ value: @autoclosure () -> Bool) throws { if !value() { throw HostError("Assertion failed") } }
        try expect(integer(true) == nil && integer(1.5) == nil && integer(11) == 11)
        try expect(boolean(1) == nil && boolean(true) == true)
        try expect(eventID([0x31,0,0,0xc0,2,0,0], allowed: [2]) == 2)
        for packet: [UInt8] in [[0x31,0,0,0xc0,3,0,0], [0x21,0,0,0xc0,2,0,0], [0x31,0,0,0xc0,2,1,0], [0x31,0,0,0xc0,2,0]] {
            try expect(eventID(packet, allowed: [2]) == nil)
        }
        // Closed output pipe must stop the session without terminating this process.
        let closedPipe = Pipe()
        try closedPipe.fileHandleForReading.close()
        let disconnected = HostSession()
        disconnected.output = closedPipe.fileHandleForWriting
        disconnected.emit(["type": "HOST_EVENT", "id": 1])
        try expect(disconnected.stop.stopped)
        try expect(!emitHost(["type": "HOST_END"], to: closedPipe.fileHandleForWriting))
        try closedPipe.fileHandleForWriting.close()
        let original = Dictionary(uniqueKeysWithValues: (1...11).map { (String($0), [UInt8](repeating: 0, count: 15)) })
        let installed: [String: [UInt8]] = ["1": [8,1] + Array(repeating: 0, count: 13)]
        var observed = original; observed["1"] = installed["1"]
        try restorePreflight(observed, original: original, installed: installed)
        for key in ["1", "11"] {
            var edited = observed; edited[key] = [5,0,4] + Array(repeating: 0, count: 12)
            do { try restorePreflight(edited, original: original, installed: installed); throw HostError("Accepted external edit") }
            catch let error as HostError { if error.description == "Accepted external edit" { throw error } }
        }
        let parsed = try hostMaps(original); try expect(parsed == original)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vanzy-host-self-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = HostSession()
        session.record = ["resolved": false, "source": "vanzy-host"]
        session.journal = try saveRecord(session.record, directory: directory.path, kind: "host-recovery")
        let path = URL(fileURLWithPath: session.journal!)
        session.evidence = try Data(contentsOf: path)
        try session.resolveJournal()
        let resolved = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
        try expect(boolean(resolved["resolved"]) == true)
        do { try session.resolveJournal(); throw HostError("Accepted altered journal") }
        catch let error as HostError { if error.description == "Accepted altered journal" { throw error } }
    }
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        if CommandLine.arguments.contains("--self-test") {
            do { try selfTest(); print("Mac host offline self-tests passed"); return }
            catch { fputs("Mac host self-test failed: \(error)\n", stderr); exit(1) }
        }
        do {
            guard let text = ProcessInfo.processInfo.environment["VANZY_HOST_REQUEST"], let data = text.data(using: .utf8), data.count <= 262144,
                  let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw HostError("Invalid host request") }
            HostSession().run(request)
        } catch { emitHost(["type": "HOST_END", "ok": false, "error": String(describing: error), "restoration": "not-needed", "cleanupErrors": []]) }
    }
}
