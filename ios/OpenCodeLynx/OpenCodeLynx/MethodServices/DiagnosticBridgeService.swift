import Foundation

enum NativeDiagnosticPhase: String {
    case reactReady = "react_ready"
    case uiReady = "ui_ready"
}

enum NativeDiagnosticStatus: String {
    case ok
    case warning
    case error
}

struct NativeDiagnosticRecord {
    let reportID: String
}

final class NativeDiagnosticBridgeStore {
    private var lock = NSLock()
    private var seenIDs: Set<String> = []

    /// Returns `true` if the reportID was already seen (duplicate).
    func ingest(reportID: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if seenIDs.contains(reportID) {
            return true
        }
        seenIDs.insert(reportID)
        return false
    }

    func reset() {
        lock.lock()
        seenIDs.removeAll()
        lock.unlock()
    }
}

enum NativeDiagnosticBridgeRuntime {
    static let sharedStore = NativeDiagnosticBridgeStore()
}

enum NativeDiagnosticBridgeMode {
    /// Returns `true` when XCTest is driving the app.
    static func isEnabled() -> Bool {
        let env = ProcessInfo.processInfo.environment

        if env["NATIVE_DIAGNOSTIC_BRIDGE_TEST_MODE"] == "1" {
            return true
        }

        return env["XCTestConfigurationFilePath"] != nil
    }
}
