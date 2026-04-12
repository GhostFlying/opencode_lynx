import Foundation
import Lynx

// LynxView already implements sendGlobalEvent(_:withParams:) from the Lynx SDK.
// This extension declares conformance to our custom protocol so the SSE manager
// can use it for event dispatch.
extension LynxView: NativeNetworkSseEventDispatching {}

/// Completion block for bridge method dispatch.
/// - code: 1 = success, 0 = failure, -3 = invalid params
/// - msg: optional error message
/// - data: result dictionary
typealias BridgeCompletion = (_ code: Int, _ msg: String?, _ data: NSDictionary?) -> Void

/// Dispatches JS bridge method calls to the matching native handler and
/// serializes the response.
@objc final class OpenCodeBridgeDispatcher: NSObject {

    private static let codeSucceeded: Int = 1
    private static let codeFailed: Int = 0
    private static let codeInvalidParam: Int = -3
    private static let codeNoHandler: Int = -2

    private weak var lynxContext: LynxContext?

    // Services (constructed once, reused)
    private lazy var requestExecutor: NativeNetworkRequestExecuting = NativeURLSessionNetworkRequestExecutor()
    private lazy var sseManager = NativeURLSessionNetworkSseManager()

    @objc init(lynxContext: LynxContext) {
        self.lynxContext = lynxContext
        super.init()
    }

    @objc func dispatchMethod(
        _ methodName: String,
        params: NSDictionary,
        completion: @escaping BridgeCompletion
    ) {
        switch methodName {
        case "network.request":
            handleNetworkRequest(params: params, completion: completion)
        case "network.sse.open":
            handleSseOpen(params: params, completion: completion)
        case "network.sse.close":
            handleSseClose(params: params, completion: completion)
        case "storage.set":
            handleStorageSet(params: params, completion: completion)
        case "storage.get":
            handleStorageGet(params: params, completion: completion)
        case "storage.remove":
            handleStorageRemove(params: params, completion: completion)
        case "diagnostic.report":
            handleDiagnosticReport(params: params, completion: completion)
        case "navigation.open":
            handleNavigationOpen(params: params, completion: completion)
        case "navigation.close":
            handleNavigationClose(completion: completion)
        default:
            completion(Self.codeNoHandler, "Method '\(methodName)' not registered", nil)
        }
    }

    // MARK: - Network

    private func handleNetworkRequest(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let path = params["path"] as? String ?? ""
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion(Self.codeInvalidParam, "Invalid network request payload", ["ok": false, "error_code": "invalid_payload"])
            return
        }

        let rawMethod = params["method"] as? String ?? ""
        let trimmedMethod = rawMethod.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedMethod = trimmedMethod.isEmpty ? "GET" : trimmedMethod.uppercased()

        let allowedMethods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        guard allowedMethods.contains(normalizedMethod) else {
            completion(Self.codeInvalidParam, "Invalid network request payload", ["ok": false, "error_code": "invalid_payload"])
            return
        }

        let input = NativeNetworkRequestExecutionInput(
            path: path.trimmingCharacters(in: .whitespacesAndNewlines),
            method: normalizedMethod,
            headers: params["headers"] as? [AnyHashable: Any] ?? [:],
            body: params["body"] as? NSObject,
            timeoutMs: 30_000
        )

        requestExecutor.execute(input) { output in
            var result: [String: Any] = [
                "ok": output.ok,
                "status": output.statusCode,
                "status_code": output.statusCode,
                "headers": output.headers,
            ]
            if let body = output.body {
                result["body"] = body
            }
            if let errorCode = output.errorCode {
                result["error_code"] = errorCode
                result["reason"] = errorCode
            }
            if let errorMessage = output.errorMessage {
                result["error_message"] = errorMessage
            }

            let code = output.errorCode != nil ? Self.codeFailed : Self.codeSucceeded
            completion(code, output.errorMessage, result as NSDictionary)
        }
    }

    private func handleSseOpen(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let path = params["path"] as? String ?? ""
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion(Self.codeInvalidParam, "Invalid network.sse.open payload", ["error_code": "invalid_payload"])
            return
        }

        // Create event dispatcher using the LynxContext for sendGlobalEvent
        let dispatcher: NativeNetworkSseEventDispatcher?
        if let context = lynxContext,
           let lynxView = context.getLynxView(),
           let dispatching = lynxView as? NativeNetworkSseEventDispatching {
            dispatcher = NativeNetworkSseEventDispatcher(target: dispatching)
        } else {
            dispatcher = nil
        }

        let input = NativeNetworkSseOpenExecutionInput(
            path: path.trimmingCharacters(in: .whitespacesAndNewlines),
            headers: params["headers"] as? [AnyHashable: Any] ?? [:],
            eventDispatcher: dispatcher,
            eventName: params["event_name"] as? String
        )

        sseManager.open(input) { output in
            var result: [String: Any] = [:]
            if let streamID = output.streamID { result["id"] = streamID; result["stream_id"] = streamID }
            if let eventName = output.eventName { result["event_name"] = eventName }
            if let errorCode = output.errorCode { result["error_code"] = errorCode; result["reason"] = errorCode }
            if let errorMessage = output.errorMessage { result["error_message"] = errorMessage }

            let code = output.errorCode != nil ? Self.codeFailed : Self.codeSucceeded
            completion(code, output.errorMessage, result as NSDictionary)
        }
    }

    private func handleSseClose(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let streamID = (params["id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !streamID.isEmpty else {
            completion(Self.codeInvalidParam, "Invalid network.sse.close payload", ["closed": false, "error_code": "invalid_payload"])
            return
        }

        sseManager.close(streamID: streamID) { output in
            var result: [String: Any] = ["closed": output.closed]
            if let errorCode = output.errorCode { result["error_code"] = errorCode; result["reason"] = errorCode }
            if let errorMessage = output.errorMessage { result["error_message"] = errorMessage }

            let code = output.errorCode != nil ? Self.codeFailed : Self.codeSucceeded
            completion(code, output.errorMessage, result as NSDictionary)
        }
    }

    // MARK: - Storage

    private func handleStorageSet(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let key = (params["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            completion(Self.codeInvalidParam, "storage.set requires non-empty key", ["ok": true])
            return
        }
        let value = params["value"] as? String ?? ""
        let defaults = UserDefaults.standard
        defaults.set(value, forKey: "opencodelynx." + key)
        completion(Self.codeSucceeded, nil, ["ok": true])
    }

    private func handleStorageGet(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let key = (params["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            completion(Self.codeInvalidParam, "storage.get requires non-empty key", ["value": NSNull()])
            return
        }
        let defaults = UserDefaults.standard
        let stored = defaults.string(forKey: "opencodelynx." + key)
        let result: [String: Any] = ["value": stored ?? NSNull()]
        completion(Self.codeSucceeded, nil, result as NSDictionary)
    }

    private func handleStorageRemove(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let key = (params["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            completion(Self.codeInvalidParam, "storage.remove requires non-empty key", ["ok": true])
            return
        }
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "opencodelynx." + key)
        completion(Self.codeSucceeded, nil, ["ok": true])
    }

    // MARK: - Diagnostic

    private func handleDiagnosticReport(params: NSDictionary, completion: @escaping BridgeCompletion) {
        guard NativeDiagnosticBridgeMode.isEnabled() else {
            completion(Self.codeFailed, "Diagnostic bridge disabled outside test mode", ["ok": false, "reason": "disabled"])
            return
        }

        let reportID = (params["report_id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let runID = (params["run_id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reportID.isEmpty, !runID.isEmpty else {
            completion(Self.codeInvalidParam, "Invalid diagnostic payload", ["ok": false, "reason": "invalid_payload"])
            return
        }

        let phase = (params["phase"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let status = (params["status"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = (params["reason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        guard NativeDiagnosticPhase(rawValue: phase) != nil,
              let statusEnum = NativeDiagnosticStatus(rawValue: status) else {
            completion(Self.codeInvalidParam, "Invalid diagnostic payload", ["ok": false, "reason": "invalid_payload"])
            return
        }

        if (statusEnum == .warning || statusEnum == .error) && reason.isEmpty {
            completion(Self.codeInvalidParam, "Invalid diagnostic payload", ["ok": false, "reason": "invalid_payload"])
            return
        }

        let isDuplicate = NativeDiagnosticBridgeRuntime.sharedStore.ingest(reportID: reportID)
        if isDuplicate {
            completion(Self.codeSucceeded, nil, ["ok": true, "reason": "duplicate_ignored"])
        } else {
            completion(Self.codeSucceeded, nil, ["ok": true])
        }
    }

    // MARK: - Navigation

    private func handleNavigationOpen(params: NSDictionary, completion: @escaping BridgeCompletion) {
        guard let scheme = params["scheme"] as? String, !scheme.isEmpty else {
            completion(Self.codeInvalidParam, "navigation.open requires a scheme", nil)
            return
        }

        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .openCodeNavigationOpen,
                object: nil,
                userInfo: ["scheme": scheme]
            )
            completion(Self.codeSucceeded, nil, nil)
        }
    }

    private func handleNavigationClose(completion: @escaping BridgeCompletion) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .openCodeNavigationClose,
                object: nil
            )
            completion(Self.codeSucceeded, nil, nil)
        }
    }
}

// MARK: - Navigation notification names

extension Notification.Name {
    static let openCodeNavigationOpen = Notification.Name("OpenCodeNavigationOpen")
    static let openCodeNavigationClose = Notification.Name("OpenCodeNavigationClose")
}
