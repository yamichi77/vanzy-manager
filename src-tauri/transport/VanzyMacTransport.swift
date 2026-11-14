// Fixed VANZY A2 / FW 3.2.1 transport. No scanning, pairing, reset, or firmware API.
import Foundation
import CoreBluetooth
import CoreFoundation
import Darwin

struct VanzyError: Error, CustomStringConvertible { let description: String; init(_ text: String) { description = text } }
func supportedProduct(_ value: String) -> Bool { value.range(of: "\\AVANZY#1-[0-9A-F]{4}/A2\\z", options: .regularExpression) != nil }
func slot(_ id: Int) throws -> (UInt8, UInt8) {
    if (1...7).contains(id) { return (0x44, UInt8(id)) }
    switch id { case 8: return (0x4b,0); case 9: return (0x4b,3); case 10: return (0x4b,7); case 11: return (0x4b,8); default: throw VanzyError("Unknown logical slot") }
}
func allowedApply(_ index: Int, _ bytes: [UInt8]) -> Bool {
    guard (1...11).contains(index), bytes.count == 15, bytes.dropFirst(3).allSatisfy({$0 == 0}) else { return false }
    let key = Int(bytes[2])
    if bytes[0] == 5 && bytes[1] <= 15 && ((4...56).contains(key) || (58...69).contains(key) || (73...82).contains(key) || (bytes[1] == 8 && key == 0)) { return true }
    let defaults: [[UInt8]] = [[5,0,80],[5,0,79],[5,8,43],[5,0,40],[4,1,0],[4,0,0],[4,3,0],[1,22,0],[1,24,0],[1,16,0],[1,17,0]]
    return Array(bytes.prefix(3)) == defaults[index-1]
}
func bytes(_ raw: Any?) throws -> [UInt8] {
    guard let values = raw as? [Any], values.count == 15 else { throw VanzyError("Invalid map length") }
    return try values.map { value in
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.rounded() == n.doubleValue, (0...255).contains(n.intValue) else { throw VanzyError("Invalid map byte") }
        return UInt8(n.intValue)
    }
}
func maps(_ raw: Any?) throws -> [String:[UInt8]] {
    guard let object = raw as? [String:Any], object.count == 11 else { throw VanzyError("Invalid maps") }
    var result: [String:[UInt8]] = [:]
    for id in 1...11 { result[String(id)] = try bytes(object[String(id)]) }
    return result
}
func bool(_ raw: Any?) throws -> Bool {
    guard let n = raw as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw VanzyError("Expected boolean") }
    return n.boolValue
}
func saveRecord(_ record: [String:Any], directory: String, kind: String) throws -> String {
    let dir = URL(fileURLWithPath: directory, isDirectory: true)
    var isDir: ObjCBool = false
    guard directory.hasPrefix("/"), FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { throw VanzyError("Backup directory unavailable") }
    let path = dir.appendingPathComponent("\(kind)-\(UUID().uuidString).json").path
    let data = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
    let fd = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw VanzyError("Cannot create durable backup") }
    defer { Darwin.close(fd) }
    try data.withUnsafeBytes { ptr in
        var offset = 0
        while offset < data.count {
            let n = Darwin.write(fd, ptr.baseAddress!.advanced(by: offset), data.count-offset)
            guard n > 0 else { throw VanzyError("Backup write failed") }; offset += n
        }
    }
    guard fsync(fd) == 0, try Data(contentsOf: URL(fileURLWithPath:path)) == data else { throw VanzyError("Backup verification failed") }
    let directoryFD = Darwin.open(dir.path, O_RDONLY)
    guard directoryFD >= 0 else { throw VanzyError("Backup directory cannot be synced") }
    defer { Darwin.close(directoryFD) }
    guard fsync(directoryFD) == 0 else { throw VanzyError("Backup directory durability failed") }
    return path
}
func assertHostRecoveryResolved(_ directory: String) throws {
    for name in try FileManager.default.contentsOfDirectory(atPath: directory) where name.hasPrefix("host-recovery-") && name.hasSuffix(".json") {
        let data = try Data(contentsOf: URL(fileURLWithPath:directory).appendingPathComponent(name))
        guard data.count <= 262144, let value = try JSONSerialization.jsonObject(with:data) as? [String:Any], let version = value["schemaVersion"] as? Int, [1,2].contains(version), value["source"] as? String == "vanzy-host", supportedProduct(value["product"] as? String ?? ""), value["firmware"] as? String == "3.2.1", !(value["deviceId"] as? String ?? "").isEmpty else { throw VanzyError("Invalid host recovery record") }
        guard try bool(value["resolved"]) else { throw VanzyError("Unresolved host restoration; ordinary writes blocked") }
    }
}
// Process-wide transport lock shared by normal and host workers.
final class VanzyTransportLock {
    private let fd: Int32
    init(directory: String) throws {
        fd = Darwin.open(URL(fileURLWithPath:directory).appendingPathComponent("mac-transport.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw VanzyError("Transport lock unavailable") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(fd); throw VanzyError("Another VANZY operation is running") }
    }
    deinit { flock(fd, LOCK_UN); Darwin.close(fd) }
}
final class VanzyBLE: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let service = CBUUID(string:"0000c0a1-0000-1000-8000-00805f9b34fb")
    static let receive = CBUUID(string:"d7b83c07-eae9-469c-ba5c-12db92c7cfa2")
    static let transmit = CBUUID(string:"08202fb0-fab1-4a34-86a2-8b2738ebdf9f")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var fault: Error?
    private var connected = false
    private var ready = false, serviceDone = false, characteristicDone = false, notifyDone = false, disconnected = false
    private var subscribed = false, closing = false
    private var notifications: [[UInt8]] = []
    var onNotification: (([UInt8]) -> Void)?
    private(set) var product = ""
    private(set) var deviceID = ""
    func wait(_ seconds: TimeInterval = 10, until condition: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if let error = fault { throw error }
            guard Date() < deadline else { throw VanzyError("Bluetooth operation timed out; read again before writing") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        if let error = fault { throw error }
    }
    func connect() throws {
        guard Thread.isMainThread else { throw VanzyError("BLE worker requires the main run loop") }
        if #available(macOS 10.15, *) {
            guard CBManager.authorization != .denied && CBManager.authorization != .restricted else { throw VanzyError("Bluetooth access denied. Allow VANZY Manager in macOS Privacy & Security > Bluetooth before connecting.") }
        }
        let awaitingAuthorization = CBManager.authorization == .notDetermined
        central = CBCentralManager(delegate:self, queue:nil, options:[CBCentralManagerOptionShowPowerAlertKey:false])
        try wait(awaitingAuthorization ? 60 : 10) { self.ready }
        guard central.state == .poweredOn else { throw VanzyError("Bluetooth is not powered on") }
        // CoreBluetooth cannot enumerate paired-but-disconnected units. Never scan or claim all paired devices were checked.
        let candidates = central.retrieveConnectedPeripherals(withServices:[Self.service]).filter { supportedProduct($0.name ?? "") }
        guard candidates.count == 1 else { throw VanzyError("Exactly one OS-connected VANZY A2 is required. Connect it in macOS Bluetooth settings first; no pairing or scanning was attempted.") }
        let device = candidates[0]; peripheral = device; device.delegate = self
        product = device.name ?? ""; deviceID = device.identifier.uuidString
        central.connect(device, options:nil)
        try wait { self.connected }
        device.discoverServices([Self.service]); try wait { self.serviceDone }
        guard let services = device.services?.filter({$0.uuid == Self.service}), services.count == 1 else { throw VanzyError("Expected exactly one command service") }
        device.discoverCharacteristics([Self.receive,Self.transmit], for:services[0]); try wait { self.characteristicDone }
        guard let rx = rx, let tx = tx, rx.properties.contains(.notify), tx.properties.contains(.writeWithoutResponse) else { throw VanzyError("Required command characteristics unavailable") }
        guard !rx.isNotifying else { throw VanzyError("Unexpected existing notification subscription") }
        subscribed = true; device.setNotifyValue(true, for:rx)
        try wait { self.notifyDone }
        guard rx.isNotifying else { throw VanzyError("Notification subscription failed") }
    }
    func send(_ packet: [UInt8]) throws {
        guard let device = peripheral, let tx = tx, device.state == .connected, packet.count <= device.maximumWriteValueLength(for:.withoutResponse) else { throw VanzyError("BLE transport unavailable") }
        try wait { device.canSendWriteWithoutResponse }
        device.writeValue(Data(packet), for:tx, type:.withoutResponse)
    }
    func checkHealth() throws { if let error = fault { throw error }; guard peripheral?.state == .connected else { throw VanzyError("Device disconnected") } }
    func drainNotifications() -> [[UInt8]] { let value = notifications; notifications.removeAll(); return value }
    func readCommand(_ command: UInt8, _ index: Int = -1) throws -> [UInt8] {
        guard (command == 0x12 || command == 0x25 || command == 0x16) ? index == -1 : (command == 0x44 ? (1...8).contains(index) : command == 0x4b && (0...8).contains(index)) else { throw VanzyError("Unverified read command") }
        notifications.removeAll()
        try send([0x10,0,0,command] + (index >= 0 ? [UInt8(index)] : []))
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if let error = fault { throw error }
            for bytes in drainNotifications() where bytes.count >= 4 && bytes[0] & 0xf0 == 0x20 && bytes[3] == command {
                guard bytes[0] == 0x21 && bytes[1] == 0 && bytes[2] == 0 else { throw VanzyError("Unexpected response status/header") }
                if index >= 0 {
                    guard bytes.count >= 5, bytes[4] == index else { continue }
                    guard bytes.count == 20 else { throw VanzyError("Unexpected map length") }; return Array(bytes[5...19])
                }
                if command == 0x16 { guard bytes.count == 5 else { throw VanzyError("Invalid mode response") }; return [bytes[4]] }
                if command == 0x25 { guard bytes.count == 5 && bytes[4] <= 1 else { throw VanzyError("Invalid touch inversion response") }; return [bytes[4]] }
                guard (5...36).contains(bytes.count) else { throw VanzyError("Invalid firmware response") }; return Array(bytes.dropFirst(4))
            }
            RunLoop.current.run(until:Date().addingTimeInterval(0.01))
        }
        throw VanzyError("Response timed out; read again before any further write")
    }
    func readAllMaps() throws -> [String:[UInt8]] {
        var result: [String:[UInt8]] = [:]
        for id in 1...11 { let s = try slot(id); result[String(id)] = try readCommand(s.0, Int(s.1)) }
        return result
    }
    func close() throws {
        // Remove this application's subscription only; never touch raw CCCD of another client.
        closing = true
        var cleanupError: Error?
        fault = nil
        if subscribed, let device = peripheral, let rx = rx, device.state == .connected {
            notifyDone = false; device.setNotifyValue(false,for:rx)
            do { try wait(5) { self.notifyDone }; if rx.isNotifying { throw VanzyError("Notification cleanup unconfirmed") } } catch { cleanupError = error }
        }
        if let device = peripheral, device.state != .disconnected {
            fault = nil; central.cancelPeripheralConnection(device)
            do { try wait(5) { self.disconnected } } catch { if cleanupError == nil { cleanupError = error } }
        }
        if let error = cleanupError { throw error }
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) { ready = central.state != .unknown && central.state != .resetting; if ready && central.state != .poweredOn { fault = VanzyError("Bluetooth unavailable or access denied") } }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) { connected = true }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) { fault = error ?? VanzyError("Connection failed") }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) { disconnected = true; if !closing { fault = error ?? VanzyError("Device disconnected") } }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) { fault = error; serviceDone = true }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) { fault = error; let all = service.characteristics ?? []; if all.filter({$0.uuid == Self.receive}).count == 1 { rx = all.first{$0.uuid == Self.receive} }; if all.filter({$0.uuid == Self.transmit}).count == 1 { tx = all.first{$0.uuid == Self.transmit} }; characteristicDone = true }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) { fault = error; notifyDone = true }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error { fault = error; return }
        guard characteristic.uuid == Self.receive, let data = characteristic.value else { return }
        guard data.count <= 512, notifications.count < 512 else { fault = VanzyError("Oversized BLE notification queue"); return }
        let packet = Array(data)
        if let handler = onNotification, packet.count >= 1, packet[0] & 0xf0 != 0x20 { handler(packet) } else { notifications.append(packet) }
    }
}
