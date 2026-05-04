import Foundation
import Lynx

// LynxView already implements sendGlobalEvent(_:withParams:) from the Lynx SDK.
// This extension declares conformance to our custom protocol so the SSE manager
// can use it for event dispatch.
extension LynxView: NativeNetworkSseEventDispatching {}

// Same selector, separate protocol so the channel manager doesn't depend on
// the SSE-flavored type name.
extension LynxView: NativeBackendChannelEventDispatching {}

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
    private lazy var channelManager: NativeBackendChannelManaging = NativeURLSessionBackendChannelManager()

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
        case "backend.channel.open":
            handleBackendChannelOpen(params: params, completion: completion)
        case "backend.channel.send":
            handleBackendChannelSend(params: params, completion: completion)
        case "backend.channel.close":
            handleBackendChannelClose(params: params, completion: completion)
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

        // Create event dispatcher using the LynxContext for sendGlobalEvent.
        // `LynxView` conforms to `NativeNetworkSseEventDispatching` via the
        // extension at the top of this file, so the cast that was here before
        // was unconditional — pass lynxView directly.
        let dispatcher: NativeNetworkSseEventDispatcher?
        if let context = lynxContext, let lynxView = context.getLynxView() {
            dispatcher = NativeNetworkSseEventDispatcher(target: lynxView)
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

    // MARK: - Backend Channel (WebSocket)

    private func handleBackendChannelOpen(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let urlString = (params["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let messageEventName = (params["message_event_name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let stateEventName = (params["state_event_name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        guard !urlString.isEmpty,
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              !messageEventName.isEmpty,
              !stateEventName.isEmpty else {
            completion(Self.codeInvalidParam, "Invalid backend.channel.open payload", ["error_code": "invalid_payload"])
            return
        }

        guard let context = lynxContext, let lynxView = context.getLynxView() else {
            completion(Self.codeFailed, "Lynx view unavailable for backend.channel.open", ["error_code": "bridge_unavailable"])
            return
        }

        // `LynxView` conforms to `NativeBackendChannelEventDispatching` via
        // the extension at the top of this file — pass it directly.
        let dispatcher = NativeBackendChannelEventDispatcher(target: lynxView)
        let headers = (params["headers"] as? [AnyHashable: Any] ?? [:]).reduce(into: [String: String]()) { acc, kv in
            guard let key = kv.key as? String else { return }
            let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            if let v = kv.value as? String {
                acc[trimmed] = v
            } else {
                acc[trimmed] = String(describing: kv.value)
            }
        }
        let pingIntervalMs = (params["ping_interval_ms"] as? NSNumber)?.intValue ?? 30_000

        let input = NativeBackendChannelOpenInput(
            url: url,
            headers: headers,
            messageEventName: messageEventName,
            stateEventName: stateEventName,
            pingIntervalMs: pingIntervalMs,
            eventDispatcher: dispatcher
        )

        channelManager.open(input) { output in
            var result: [String: Any] = [:]
            if let id = output.channelID { result["channel_id"] = id }
            if let errorCode = output.errorCode { result["error_code"] = errorCode; result["reason"] = errorCode }
            if let errorMessage = output.errorMessage { result["error_message"] = errorMessage }
            let code = output.errorCode != nil ? Self.codeFailed : Self.codeSucceeded
            completion(code, output.errorMessage, result as NSDictionary)
        }
    }

    private func handleBackendChannelSend(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let channelID = (params["channel_id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !channelID.isEmpty, let payload = params["payload"] else {
            completion(Self.codeInvalidParam, "Invalid backend.channel.send payload", ["error_code": "invalid_payload"])
            return
        }

        channelManager.send(channelID: channelID, payload: payload) { output in
            var result: [String: Any] = ["sent": output.sent]
            if let errorCode = output.errorCode { result["error_code"] = errorCode; result["reason"] = errorCode }
            if let errorMessage = output.errorMessage { result["error_message"] = errorMessage }
            let code = output.errorCode != nil ? Self.codeFailed : Self.codeSucceeded
            completion(code, output.errorMessage, result as NSDictionary)
        }
    }

    private func handleBackendChannelClose(params: NSDictionary, completion: @escaping BridgeCompletion) {
        let channelID = (params["channel_id"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !channelID.isEmpty else {
            completion(Self.codeInvalidParam, "Invalid backend.channel.close payload", ["error_code": "invalid_payload"])
            return
        }
        let code = (params["code"] as? NSNumber)?.intValue
        let reason = params["reason"] as? String

        channelManager.close(channelID: channelID, code: code, reason: reason) { output in
            var result: [String: Any] = ["closed": output.closed]
            if let errorCode = output.errorCode { result["error_code"] = errorCode; result["reason"] = errorCode }
            if let errorMessage = output.errorMessage { result["error_message"] = errorMessage }
            let respCode = output.errorCode != nil ? Self.codeFailed : Self.codeSucceeded
            completion(respCode, output.errorMessage, result as NSDictionary)
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
