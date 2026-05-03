import Foundation

private let NativeBackendChannelErrorInvalidPayload = "invalid_payload"
private let NativeBackendChannelErrorUnavailable = "bridge_unavailable"
private let NativeBackendChannelErrorClosed = "channel_closed"
private let NativeBackendChannelErrorTransport = "transport_error"

struct NativeBackendChannelOpenInput {
    let url: URL
    let headers: [String: String]
    let messageEventName: String
    let stateEventName: String
    let pingIntervalMs: Int
    let eventDispatcher: NativeBackendChannelEventDispatcher
}

struct NativeBackendChannelOpenOutput {
    let channelID: String?
    let errorCode: String?
    let errorMessage: String?
}

struct NativeBackendChannelSendOutput {
    let sent: Bool
    let errorCode: String?
    let errorMessage: String?
}

struct NativeBackendChannelCloseOutput {
    let closed: Bool
    let errorCode: String?
    let errorMessage: String?
}

protocol NativeBackendChannelManaging {
    func open(_ input: NativeBackendChannelOpenInput, completion: @escaping (NativeBackendChannelOpenOutput) -> Void)
    func send(channelID: String, payload: Any, completion: @escaping (NativeBackendChannelSendOutput) -> Void)
    func close(channelID: String, code: Int?, reason: String?, completion: @escaping (NativeBackendChannelCloseOutput) -> Void)
}

@objc protocol NativeBackendChannelEventDispatching {
    func sendGlobalEvent(_ eventName: String, withParams params: [Any]?)
}

enum NativeBackendChannelTransportState {
    case closed(code: Int?, reason: String?)
    case failed(error: String, code: Int?, reason: String?)
}

protocol NativeBackendChannelTransport: AnyObject {
    func start(
        url: URL,
        headers: [String: String],
        pingIntervalMs: Int,
        onOpen: @escaping () -> Void,
        onText: @escaping (String) -> Void,
        onState: @escaping (NativeBackendChannelTransportState) -> Void
    )
    func send(text: String, completion: @escaping (Error?) -> Void)
    func cancel(code: Int?, reason: String?)
}

protocol NativeBackendChannelTransportFactory {
    func makeTransport() -> NativeBackendChannelTransport
}

struct URLSessionBackendChannelTransportFactory: NativeBackendChannelTransportFactory {
    func makeTransport() -> NativeBackendChannelTransport {
        return URLSessionBackendChannelTransport()
    }
}

final class NativeBackendChannelEventDispatcher {
    private weak var target: (NSObject & NativeBackendChannelEventDispatching)?
    private let queue: DispatchQueue

    init(target: NativeBackendChannelEventDispatching, queue: DispatchQueue = .main) {
        self.target = target as? (NSObject & NativeBackendChannelEventDispatching)
        self.queue = queue
    }

    func emit(eventName: String, payload: [String: Any]) {
        guard let target else { return }
        queue.async {
            target.sendGlobalEvent(eventName, withParams: [payload])
        }
    }
}

final class NativeURLSessionBackendChannelManager: NativeBackendChannelManaging {
    private let transportFactory: NativeBackendChannelTransportFactory
    private let channelIDFactory: () -> String

    private let lock = NSLock()
    private var channels: [String: ManagedBackendChannel] = [:]

    init(
        transportFactory: NativeBackendChannelTransportFactory = URLSessionBackendChannelTransportFactory(),
        channelIDFactory: (() -> String)? = nil
    ) {
        self.transportFactory = transportFactory
        self.channelIDFactory = channelIDFactory ?? { UUID().uuidString.lowercased() }
    }

    func open(_ input: NativeBackendChannelOpenInput, completion: @escaping (NativeBackendChannelOpenOutput) -> Void) {
        let channelID = nextChannelID()
        let transport = transportFactory.makeTransport()
        let dispatcher = input.eventDispatcher
        let messageEventName = input.messageEventName
        let stateEventName = input.stateEventName

        let channel = ManagedBackendChannel(
            channelID: channelID,
            transport: transport,
            messageEventName: messageEventName,
            stateEventName: stateEventName
        )

        lock.withLock {
            channels[channelID] = channel
        }

        let completionLock = NSLock()
        var openCompleted = false
        let invokeCompletion: (NativeBackendChannelOpenOutput) -> Void = { output in
            completionLock.lock()
            if openCompleted {
                completionLock.unlock()
                return
            }
            openCompleted = true
            completionLock.unlock()
            completion(output)
        }

        transport.start(
            url: input.url,
            headers: input.headers,
            pingIntervalMs: input.pingIntervalMs,
            onOpen: {
                dispatcher.emit(eventName: stateEventName, payload: ["state": "open"])
                invokeCompletion(NativeBackendChannelOpenOutput(channelID: channelID, errorCode: nil, errorMessage: nil))
            },
            onText: { text in
                if let data = text.data(using: .utf8),
                   let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    dispatcher.emit(eventName: messageEventName, payload: ["frame": frame])
                } else {
                    dispatcher.emit(eventName: stateEventName, payload: ["state": "error", "error": "non_json_frame"])
                }
            },
            onState: { [weak self] state in
                switch state {
                case .closed(let code, let reason):
                    var payload: [String: Any] = ["state": "closed"]
                    if let code { payload["code"] = code }
                    if let reason { payload["reason"] = reason }
                    dispatcher.emit(eventName: stateEventName, payload: payload)
                    self?.removeChannel(channelID)
                    invokeCompletion(NativeBackendChannelOpenOutput(
                        channelID: nil,
                        errorCode: NativeBackendChannelErrorClosed,
                        errorMessage: reason ?? "channel closed before open"
                    ))
                case .failed(let error, let code, let reason):
                    var payload: [String: Any] = ["state": "error", "error": error]
                    if let code { payload["code"] = code }
                    if let reason { payload["reason"] = reason }
                    dispatcher.emit(eventName: stateEventName, payload: payload)
                    self?.removeChannel(channelID)
                    invokeCompletion(NativeBackendChannelOpenOutput(
                        channelID: nil,
                        errorCode: NativeBackendChannelErrorTransport,
                        errorMessage: error
                    ))
                }
            }
        )
    }

    func send(channelID: String, payload: Any, completion: @escaping (NativeBackendChannelSendOutput) -> Void) {
        let id = channelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            completion(NativeBackendChannelSendOutput(
                sent: false,
                errorCode: NativeBackendChannelErrorInvalidPayload,
                errorMessage: "Invalid backend.channel.send payload"
            ))
            return
        }

        let channel = lock.withLock { channels[id] }
        guard let channel else {
            completion(NativeBackendChannelSendOutput(
                sent: false,
                errorCode: NativeBackendChannelErrorClosed,
                errorMessage: "channel not found"
            ))
            return
        }

        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let text = String(data: data, encoding: .utf8) else {
            completion(NativeBackendChannelSendOutput(
                sent: false,
                errorCode: NativeBackendChannelErrorInvalidPayload,
                errorMessage: "payload is not JSON serializable"
            ))
            return
        }

        channel.transport.send(text: text) { error in
            if let error {
                completion(NativeBackendChannelSendOutput(
                    sent: false,
                    errorCode: NativeBackendChannelErrorTransport,
                    errorMessage: error.localizedDescription
                ))
            } else {
                completion(NativeBackendChannelSendOutput(sent: true, errorCode: nil, errorMessage: nil))
            }
        }
    }

    func close(channelID: String, code: Int?, reason: String?, completion: @escaping (NativeBackendChannelCloseOutput) -> Void) {
        let id = channelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            completion(NativeBackendChannelCloseOutput(
                closed: false,
                errorCode: NativeBackendChannelErrorInvalidPayload,
                errorMessage: "Invalid backend.channel.close payload"
            ))
            return
        }

        let channel = lock.withLock { channels.removeValue(forKey: id) }
        let wasOpen = channel != nil
        channel?.transport.cancel(code: code, reason: reason)

        completion(NativeBackendChannelCloseOutput(closed: wasOpen, errorCode: nil, errorMessage: nil))
    }

    private func removeChannel(_ channelID: String) {
        _ = lock.withLock { channels.removeValue(forKey: channelID) }
    }

    private func nextChannelID() -> String {
        while true {
            let candidate = channelIDFactory().trimmingCharacters(in: .whitespacesAndNewlines)
            let id = candidate.isEmpty ? UUID().uuidString.lowercased() : candidate
            let exists = lock.withLock { channels[id] != nil }
            if !exists {
                return id
            }
        }
    }
}

private final class ManagedBackendChannel {
    let channelID: String
    let transport: NativeBackendChannelTransport
    let messageEventName: String
    let stateEventName: String

    init(channelID: String, transport: NativeBackendChannelTransport, messageEventName: String, stateEventName: String) {
        self.channelID = channelID
        self.transport = transport
        self.messageEventName = messageEventName
        self.stateEventName = stateEventName
    }
}

private final class URLSessionBackendChannelTransport: NSObject, NativeBackendChannelTransport, URLSessionWebSocketDelegate {
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var pingIntervalMs: Int = 0
    private var onOpen: (() -> Void)?
    private var onText: ((String) -> Void)?
    private var onState: ((NativeBackendChannelTransportState) -> Void)?
    private var terminated = false

    func start(
        url: URL,
        headers: [String: String],
        pingIntervalMs: Int,
        onOpen: @escaping () -> Void,
        onText: @escaping (String) -> Void,
        onState: @escaping (NativeBackendChannelTransportState) -> Void
    ) {
        lock.lock()
        self.onOpen = onOpen
        self.onText = onText
        self.onState = onState
        self.pingIntervalMs = pingIntervalMs

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session

        var request = URLRequest(url: url)
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let task = session.webSocketTask(with: request)
        self.task = task
        lock.unlock()

        task.resume()
        receiveLoop()
    }

    func send(text: String, completion: @escaping (Error?) -> Void) {
        let task = lock.withLock { self.task }
        guard let task else {
            completion(NSError(domain: "OpenCodeBackendChannel", code: -1,
                               userInfo: [NSLocalizedDescriptionKey: "channel closed"]))
            return
        }
        task.send(.string(text)) { error in
            completion(error)
        }
    }

    func cancel(code: Int?, reason: String?) {
        let dispatch: ((NativeBackendChannelTransportState) -> Void)?
        lock.lock()
        if terminated {
            lock.unlock()
            return
        }
        terminated = true
        dispatch = onState
        let task = self.task
        let session = self.session
        let timer = pingTimer
        self.task = nil
        self.session = nil
        self.pingTimer = nil
        self.onState = nil
        self.onText = nil
        self.onOpen = nil
        lock.unlock()

        timer?.cancel()
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code ?? 1000) ?? .normalClosure
        let reasonData = reason?.data(using: .utf8)
        task?.cancel(with: closeCode, reason: reasonData)
        session?.invalidateAndCancel()

        dispatch?(.closed(code: code ?? 1000, reason: reason))
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        let onOpen = lock.withLock { self.onOpen }
        onOpen?()
        startPingTimer()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let dispatch: ((NativeBackendChannelTransportState) -> Void)?
        lock.lock()
        if terminated {
            lock.unlock()
            return
        }
        terminated = true
        dispatch = onState
        let timer = pingTimer
        self.pingTimer = nil
        self.onState = nil
        self.onText = nil
        self.onOpen = nil
        lock.unlock()

        timer?.cancel()
        let reasonString = reason.flatMap { String(data: $0, encoding: .utf8) }
        dispatch?(.closed(code: closeCode.rawValue, reason: reasonString))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        failWith(error: error)
    }

    private func receiveLoop() {
        let task = lock.withLock { self.task }
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                let onText = self.lock.withLock { self.onText }
                let onState = self.lock.withLock { self.onState }
                switch message {
                case .string(let s):
                    onText?(s)
                case .data:
                    onState?(.failed(error: "non_json_frame", code: nil, reason: nil))
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure(let error):
                self.failWith(error: error)
            }
        }
    }

    private func failWith(error: Error) {
        let dispatch: ((NativeBackendChannelTransportState) -> Void)?
        lock.lock()
        if terminated {
            lock.unlock()
            return
        }
        terminated = true
        dispatch = onState
        let task = self.task
        let session = self.session
        let timer = pingTimer
        self.task = nil
        self.session = nil
        self.pingTimer = nil
        self.onState = nil
        self.onText = nil
        self.onOpen = nil
        lock.unlock()

        timer?.cancel()
        task?.cancel(with: .abnormalClosure, reason: nil)
        session?.invalidateAndCancel()

        let nsError = error as NSError
        dispatch?(.failed(error: nsError.localizedDescription, code: nsError.code, reason: nsError.domain))
    }

    private func startPingTimer() {
        let interval = lock.withLock { self.pingIntervalMs }
        guard interval > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .milliseconds(interval), repeating: .milliseconds(interval))
        timer.setEventHandler { [weak self] in
            let task = self?.lock.withLock { self?.task }
            task?.sendPing { [weak self] error in
                if let error {
                    self?.failWith(error: error)
                }
            }
        }
        timer.resume()
        lock.withLock { self.pingTimer = timer }
    }
}
