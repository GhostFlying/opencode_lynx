import Foundation

private let NativeNetworkSseEventPrefix = "network.sse.event."

private let NativeNetworkSseErrorInvalidPayload = "invalid_payload"
private let NativeNetworkSseErrorUnavailable = "bridge_unavailable"
private let NativeNetworkSseErrorTimeout = "bridge_timeout"
private let NativeNetworkSseErrorCancelled = "bridge_cancelled"
private let NativeNetworkSseErrorProtocol = "bridge_protocol"
private let NativeNetworkSseErrorStreamClosed = "stream_closed"

struct NativeNetworkSseOpenExecutionInput {
    let path: String
    let headers: [AnyHashable: Any]
    let eventDispatcher: NativeNetworkSseEventDispatcher?
    let eventName: String?
}

struct NativeNetworkSseOpenExecutionOutput {
    let streamID: String?
    let eventName: String?
    let errorCode: String?
    let errorMessage: String?
    let reason: String?
}

struct NativeNetworkSseCloseExecutionOutput {
    let closed: Bool
    let errorCode: String?
    let errorMessage: String?
    let reason: String?
}

protocol NativeNetworkSseManaging {
    func open(_ input: NativeNetworkSseOpenExecutionInput, completion: @escaping (NativeNetworkSseOpenExecutionOutput) -> Void)
    func close(streamID: String, completion: @escaping (NativeNetworkSseCloseExecutionOutput) -> Void)
}

struct NativeNetworkSseConfig {
    let openTimeoutMs: Int
    let defaultRetryDelayMs: Int
    let maxRetryDelayMs: Int
    let maxReconnectAttempts: Int

    static let `default` = NativeNetworkSseConfig(
        openTimeoutMs: 30_000,
        defaultRetryDelayMs: 1_000,
        maxRetryDelayMs: 30_000,
        maxReconnectAttempts: 10
    )
}

@objc protocol NativeNetworkSseEventDispatching {
    func sendGlobalEvent(_ eventName: String, withParams params: [Any]?)
}

protocol NativeNetworkSseConnection {
    func open(
        request: URLRequest,
        onResponse: @escaping (_ statusCode: Int) -> Void,
        onData: @escaping (_ data: Data) -> Void,
        onComplete: @escaping (_ error: Error?) -> Void
    )
    func cancel()
}

protocol NativeNetworkSseConnectionFactory {
    func makeConnection() -> NativeNetworkSseConnection
}

struct NativeURLSessionNetworkSseConnectionFactory: NativeNetworkSseConnectionFactory {
    func makeConnection() -> NativeNetworkSseConnection {
        return NativeURLSessionNetworkSseConnection()
    }
}

private final class NativeURLSessionNetworkSseConnection: NSObject, NativeNetworkSseConnection, URLSessionDataDelegate {
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var onResponse: ((_ statusCode: Int) -> Void)?
    private var onData: ((_ data: Data) -> Void)?
    private var onComplete: ((_ error: Error?) -> Void)?

    func open(
        request: URLRequest,
        onResponse: @escaping (_ statusCode: Int) -> Void,
        onData: @escaping (_ data: Data) -> Void,
        onComplete: @escaping (_ error: Error?) -> Void
    ) {
        lock.lock()
        self.onResponse = onResponse
        self.onData = onData
        self.onComplete = onComplete
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: request)
        self.task = task
        lock.unlock()

        task.resume()
    }

    func cancel() {
        lock.lock()
        let task = self.task
        let session = self.session
        self.task = nil
        self.session = nil
        self.onComplete = nil
        self.onResponse = nil
        self.onData = nil
        lock.unlock()

        task?.cancel()
        session?.invalidateAndCancel()
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let callback = lock.withLock { self.onResponse }
        if let httpResponse = response as? HTTPURLResponse {
            callback?(httpResponse.statusCode)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let callback = lock.withLock { self.onData }
        callback?(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let callback: ((Error?) -> Void)? = lock.withLock {
            let callback = self.onComplete
            self.onComplete = nil
            self.onResponse = nil
            self.onData = nil
            self.task = nil
            self.session = nil
            return callback
        }

        callback?(error)
    }
}

struct NativeNetworkSseParsedEvent {
    let event: String
    let id: String?
    let data: String
    let retryMs: Int?
}

struct NativeNetworkSseParseOutput {
    let events: [NativeNetworkSseParsedEvent]
    let retryMs: Int?
}

final class NativeNetworkSseIncrementalParser {
    private static let maxLineBufferSize = 1_048_576 // 1 MB
    private var lineBuffer = String()
    private var currentEvent: String?
    private var currentID: String?
    private var currentRetryMs: Int?
    private var currentDataLines: [String] = []

    func feed(_ chunk: String) -> NativeNetworkSseParseOutput {
        if chunk.isEmpty {
            return NativeNetworkSseParseOutput(events: [], retryMs: nil)
        }

        if lineBuffer.count + chunk.count > Self.maxLineBufferSize {
            lineBuffer.removeAll()
            return NativeNetworkSseParseOutput(
                events: [NativeNetworkSseParsedEvent(
                    event: "error",
                    id: nil,
                    data: "SSE line buffer exceeded \(Self.maxLineBufferSize) bytes",
                    retryMs: nil
                )],
                retryMs: nil
            )
        }

        lineBuffer.append(chunk)

        var cursor = lineBuffer.startIndex
        var parsedEvents: [NativeNetworkSseParsedEvent] = []
        var latestRetryMs: Int?

        while cursor < lineBuffer.endIndex,
              let newlineRange = lineBuffer[cursor...].range(of: "\n") {
            var line = String(lineBuffer[cursor ..< newlineRange.lowerBound])
            if line.hasSuffix("\r") {
                line.removeLast()
            }

            let lineOutput = processLine(line)
            if let retryMs = lineOutput.retryMs {
                latestRetryMs = retryMs
            }
            if let event = lineOutput.event {
                parsedEvents.append(event)
            }

            cursor = newlineRange.upperBound
        }

        if cursor > lineBuffer.startIndex {
            lineBuffer.removeSubrange(lineBuffer.startIndex ..< cursor)
        }

        return NativeNetworkSseParseOutput(events: parsedEvents, retryMs: latestRetryMs)
    }

    private struct NativeNetworkSseLineOutput {
        let event: NativeNetworkSseParsedEvent?
        let retryMs: Int?
    }

    private func processLine(_ line: String) -> NativeNetworkSseLineOutput {
        if line.isEmpty {
            return NativeNetworkSseLineOutput(event: dispatchEvent(), retryMs: nil)
        }

        if line.hasPrefix(":") {
            return NativeNetworkSseLineOutput(event: nil, retryMs: nil)
        }

        let separatorIndex = line.firstIndex(of: ":")
        let field = separatorIndex.map { String(line[..<($0)]) } ?? line
        var value = separatorIndex.map { String(line[line.index(after: $0)...]) } ?? ""
        if value.hasPrefix(" ") {
            value.removeFirst()
        }

        switch field {
        case "event":
            currentEvent = value
            return NativeNetworkSseLineOutput(event: nil, retryMs: nil)
        case "id":
            currentID = value
            return NativeNetworkSseLineOutput(event: nil, retryMs: nil)
        case "data":
            currentDataLines.append(value)
            return NativeNetworkSseLineOutput(event: nil, retryMs: nil)
        case "retry":
            let retryMs = parseRetryMs(value)
            if retryMs != nil {
                currentRetryMs = retryMs
            }
            return NativeNetworkSseLineOutput(event: nil, retryMs: retryMs)
        default:
            return NativeNetworkSseLineOutput(event: nil, retryMs: nil)
        }
    }

    private func parseRetryMs(_ value: String) -> Int? {
        if value.isEmpty || value.contains(where: { !$0.isNumber }) {
            return nil
        }

        guard let retryMs = Int(value) else {
            return nil
        }
        return max(retryMs, 0)
    }

    private func dispatchEvent() -> NativeNetworkSseParsedEvent? {
        if currentDataLines.isEmpty {
            currentEvent = nil
            currentRetryMs = nil
            return nil
        }

        let event = NativeNetworkSseParsedEvent(
            event: currentEvent?.isEmpty == false ? currentEvent! : "message",
            id: currentID,
            data: currentDataLines.joined(separator: "\n"),
            retryMs: currentRetryMs
        )

        currentEvent = nil
        currentRetryMs = nil
        currentDataLines.removeAll(keepingCapacity: true)

        return event
    }
}

final class NativeURLSessionNetworkSseManager: NativeNetworkSseManaging {
    private let connectionFactory: NativeNetworkSseConnectionFactory
    private let callbackQueue: DispatchQueue
    private let reconnectQueue: DispatchQueue
    private let config: NativeNetworkSseConfig
    private let streamIDFactory: () -> String

    private let lock = NSLock()
    private var streams: [String: NativeURLSessionNetworkSseStream] = [:]

    init(
        connectionFactory: NativeNetworkSseConnectionFactory = NativeURLSessionNetworkSseConnectionFactory(),
        callbackQueue: DispatchQueue = DispatchQueue(label: "opencode.network.sse.callback", qos: .utility),
        reconnectQueue: DispatchQueue = DispatchQueue(label: "opencode.network.sse.reconnect", qos: .utility),
        config: NativeNetworkSseConfig = .default,
        streamIDFactory: (() -> String)? = nil
    ) {
        self.connectionFactory = connectionFactory
        self.callbackQueue = callbackQueue
        self.reconnectQueue = reconnectQueue
        self.config = config
        self.streamIDFactory = streamIDFactory ?? {
            UUID().uuidString.lowercased()
        }
    }

    func open(_ input: NativeNetworkSseOpenExecutionInput, completion: @escaping (NativeNetworkSseOpenExecutionOutput) -> Void) {
        guard let url = resolveAbsoluteURL(from: input.path) else {
            completion(NativeNetworkSseOpenExecutionOutput(
                streamID: nil,
                eventName: nil,
                errorCode: NativeNetworkSseErrorUnavailable,
                errorMessage: "iOS network.sse.open requires an absolute http(s) URL for URLSession transport.",
                reason: NativeNetworkSseErrorUnavailable
            ))
            return
        }

        guard let dispatcher = input.eventDispatcher else {
            completion(NativeNetworkSseOpenExecutionOutput(
                streamID: nil,
                eventName: nil,
                errorCode: NativeNetworkSseErrorUnavailable,
                errorMessage: "iOS network.sse.open requires an active Lynx pipe container for event dispatch.",
                reason: NativeNetworkSseErrorUnavailable
            ))
            return
        }

        let streamID = nextStreamID()
        let jsEventName = input.eventName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let eventName = jsEventName.isEmpty ? "\(NativeNetworkSseEventPrefix)\(streamID)" : jsEventName
        let stream = NativeURLSessionNetworkSseStream(
            streamID: streamID,
            eventName: eventName,
            url: url,
            headers: normalizeHeaders(input.headers),
            connectionFactory: connectionFactory,
            callbackQueue: callbackQueue,
            reconnectQueue: reconnectQueue,
            config: config,
            eventDispatcher: dispatcher,
            onTerminal: { [weak self] terminalStreamID in
                self?.removeStream(terminalStreamID)
            }
        )

        lock.withLock {
            streams[streamID] = stream
        }

        stream.open { [weak self] output in
            if output.errorCode != nil {
                self?.removeStream(streamID)
            }
            completion(output)
        }
    }

    func close(streamID: String, completion: @escaping (NativeNetworkSseCloseExecutionOutput) -> Void) {
        let normalized = streamID.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty {
            completion(NativeNetworkSseCloseExecutionOutput(
                closed: false,
                errorCode: NativeNetworkSseErrorInvalidPayload,
                errorMessage: "Invalid network.sse.close payload",
                reason: NativeNetworkSseErrorInvalidPayload
            ))
            return
        }

        let stream = lock.withLock { streams.removeValue(forKey: normalized) }
        let wasOpen = stream != nil
        stream?.close(userInitiated: true)

        completion(NativeNetworkSseCloseExecutionOutput(
            closed: wasOpen,
            errorCode: nil,
            errorMessage: nil,
            reason: nil
        ))
    }

    private func resolveAbsoluteURL(from path: String) -> URL? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    private func normalizeHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        var normalized: [String: String] = [:]
        for (name, value) in headers {
            guard let key = name as? String else {
                continue
            }
            let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                continue
            }
            if let text = value as? String {
                normalized[trimmed] = text
            } else {
                normalized[trimmed] = String(describing: value)
            }
        }
        return normalized
    }

    private func nextStreamID() -> String {
        while true {
            let candidate = streamIDFactory().trimmingCharacters(in: .whitespacesAndNewlines)
            let streamID = candidate.isEmpty ? UUID().uuidString.lowercased() : candidate
            let exists = lock.withLock { streams[streamID] != nil }
            if !exists {
                return streamID
            }
        }
    }

    private func removeStream(_ streamID: String) {
        _ = lock.withLock {
            streams.removeValue(forKey: streamID)
        }
    }
}

final class NativeNetworkSseEventDispatcher {
    private weak var target: (NSObject & NativeNetworkSseEventDispatching)?

    init(target: NativeNetworkSseEventDispatching) {
        self.target = target as? (NSObject & NativeNetworkSseEventDispatching)
    }

    func emit(eventName: String, payload: [String: Any]) {
        guard let target else {
            return
        }

        DispatchQueue.main.async {
            target.sendGlobalEvent(eventName, withParams: [payload])
        }
    }
}

private final class NativeURLSessionNetworkSseStream {
    private let streamID: String
    private let eventName: String
    private let url: URL
    private let headers: [String: String]
    private let connectionFactory: NativeNetworkSseConnectionFactory
    private let callbackQueue: DispatchQueue
    private let reconnectQueue: DispatchQueue
    private let config: NativeNetworkSseConfig
    private let eventDispatcher: NativeNetworkSseEventDispatcher
    private let onTerminal: (String) -> Void

    private let parser = NativeNetworkSseIncrementalParser()
    private let lock = NSLock()

    private var connection: NativeNetworkSseConnection?
    private var timeoutWorkItem: DispatchWorkItem?
    private var reconnectWorkItem: DispatchWorkItem?
    private var openCompletion: ((NativeNetworkSseOpenExecutionOutput) -> Void)?

    private var opened = false
    private var closed = false
    private var timedOut = false
    private var retryAttempt = 0
    private var retryDelayMs: Int?
    private var lastEventID: String?

    init(
        streamID: String,
        eventName: String,
        url: URL,
        headers: [String: String],
        connectionFactory: NativeNetworkSseConnectionFactory,
        callbackQueue: DispatchQueue,
        reconnectQueue: DispatchQueue,
        config: NativeNetworkSseConfig,
        eventDispatcher: NativeNetworkSseEventDispatcher,
        onTerminal: @escaping (String) -> Void
    ) {
        self.streamID = streamID
        self.eventName = eventName
        self.url = url
        self.headers = headers
        self.connectionFactory = connectionFactory
        self.callbackQueue = callbackQueue
        self.reconnectQueue = reconnectQueue
        self.config = config
        self.eventDispatcher = eventDispatcher
        self.onTerminal = onTerminal
    }

    func open(_ completion: @escaping (NativeNetworkSseOpenExecutionOutput) -> Void) {
        lock.withLock {
            openCompletion = completion
        }
        startRequest()
    }

    func close(userInitiated: Bool) {
        let completion: ((NativeNetworkSseOpenExecutionOutput) -> Void)? = lock.withLock {
            if closed {
                return nil
            }

            closed = true
            let completion = openCompletion
            openCompletion = nil

            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            reconnectWorkItem?.cancel()
            reconnectWorkItem = nil

            let connection = self.connection
            self.connection = nil
            connection?.cancel()

            return completion
        }

        if let completion {
            callbackQueue.async {
                completion(NativeNetworkSseOpenExecutionOutput(
                    streamID: nil,
                    eventName: nil,
                    errorCode: NativeNetworkSseErrorCancelled,
                    errorMessage: "URLSession SSE stream cancelled before open completed",
                    reason: NativeNetworkSseErrorCancelled
                ))
            }
        }

        if userInitiated {
            emitLifecycleEvent(name: "closed")
        }
    }

    private func startRequest() {
        let request: URLRequest? = lock.withLock {
            if closed {
                return nil
            }

            timedOut = false
            timeoutWorkItem?.cancel()
            reconnectWorkItem?.cancel()

            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = TimeInterval(max(config.openTimeoutMs, 1)) / 1_000.0

            for (headerName, headerValue) in headers {
                request.setValue(headerValue, forHTTPHeaderField: headerName)
            }

            if let lastEventID,
               !lastEventID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")
            }

            return request
        }

        guard let request else {
            return
        }

        let connection = connectionFactory.makeConnection()
        lock.withLock {
            self.connection = connection
            let timeoutWorkItem = DispatchWorkItem { [weak self] in
                self?.handleOpenTimeout()
            }
            self.timeoutWorkItem = timeoutWorkItem
            callbackQueue.asyncAfter(deadline: .now() + .milliseconds(max(config.openTimeoutMs, 1)), execute: timeoutWorkItem)
        }

        connection.open(
            request: request,
            onResponse: { [weak self] statusCode in
                self?.handleResponseStatus(statusCode)
            },
            onData: { [weak self] data in
                self?.handleData(data)
            },
            onComplete: { [weak self] error in
                self?.handleCompletion(error)
            }
        )
    }

    private func handleOpenTimeout() {
        let connection: NativeNetworkSseConnection? = lock.withLock {
            if closed || opened {
                return nil
            }
            timedOut = true
            return self.connection
        }

        connection?.cancel()
    }

    private func handleResponseStatus(_ statusCode: Int) {
        if isClosed() {
            return
        }

        if !(200 ..< 300).contains(statusCode) {
            failOpen(
                errorCode: NativeNetworkSseErrorProtocol,
                errorMessage: "URLSession SSE response failed with HTTP \(statusCode)"
            )
            lock.withLock {
                self.connection?.cancel()
            }
            return
        }

        lock.withLock {
            opened = true
            timedOut = false
            retryAttempt = 0
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
        }

        completeOpenIfNeeded(NativeNetworkSseOpenExecutionOutput(
            streamID: streamID,
            eventName: eventName,
            errorCode: nil,
            errorMessage: nil,
            reason: nil
        ))
        emitLifecycleEvent(name: "open")
    }

    private func handleData(_ data: Data) {
        if isClosed() {
            return
        }

        let chunk = String(decoding: data, as: UTF8.self)
        let output = parser.feed(chunk)

        if let retryMs = output.retryMs {
            lock.withLock {
                retryDelayMs = min(max(retryMs, 0), max(config.maxRetryDelayMs, 1))
            }
        }

        for event in output.events {
            if isClosed() {
                return
            }

            if let id = event.id {
                lock.withLock {
                    lastEventID = id
                }
            }

            var payload: [String: Any] = [
                "stream_id": streamID,
                "event_name": eventName,
                "event": event.event,
                "data": event.data,
            ]
            if let id = event.id {
                payload["id"] = id
            }
            if let retryMs = event.retryMs {
                payload["retry"] = retryMs
            }

            eventDispatcher.emit(eventName: eventName, payload: payload)
        }
    }

    private func handleCompletion(_ error: Error?) {
        let snapshot = lock.withLock {
            let snapshot = (
                opened: opened,
                closed: closed,
                timedOut: timedOut,
                retryAttempt: retryAttempt,
                retryDelayMs: retryDelayMs
            )
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            connection = nil
            return snapshot
        }

        if snapshot.closed {
            return
        }

        let mapped = mapError(error: error, timedOut: snapshot.timedOut)

        if !snapshot.opened {
            failOpen(errorCode: mapped.code, errorMessage: mapped.message)
            closeTerminal(errorCode: mapped.code, errorMessage: mapped.message)
            return
        }

        scheduleReconnect(errorCode: mapped.code, errorMessage: mapped.message, retryAttempt: snapshot.retryAttempt + 1)
    }

    private func scheduleReconnect(errorCode: String, errorMessage: String, retryAttempt: Int) {
        let delayMs: Int = lock.withLock {
            self.retryAttempt = retryAttempt
            if retryAttempt > max(config.maxReconnectAttempts, 0) {
                return -1
            }

            if let retryDelayMs {
                return min(max(retryDelayMs, 0), max(config.maxRetryDelayMs, 1))
            }

            var delay = max(config.defaultRetryDelayMs, 1)
            var currentAttempt = 1
            while currentAttempt < retryAttempt {
                if delay >= config.maxRetryDelayMs {
                    break
                }
                delay = min(delay * 2, max(config.maxRetryDelayMs, 1))
                currentAttempt += 1
            }
            return delay
        }

        if delayMs < 0 {
            closeTerminal(errorCode: NativeNetworkSseErrorStreamClosed, errorMessage: "SSE reconnect retry budget exhausted")
            return
        }

        emitLifecycleEvent(name: "error", extra: [
            "error_code": errorCode,
            "error_message": errorMessage,
            "retry_attempt": retryAttempt,
            "retry_in_ms": delayMs,
        ])

        let reconnectWorkItem = DispatchWorkItem { [weak self] in
            self?.startRequest()
        }

        lock.withLock {
            self.reconnectWorkItem?.cancel()
            self.reconnectWorkItem = reconnectWorkItem
        }

        reconnectQueue.asyncAfter(deadline: .now() + .milliseconds(max(delayMs, 0)), execute: reconnectWorkItem)
    }

    private func closeTerminal(errorCode: String, errorMessage: String) {
        let shouldProceed: Bool = lock.withLock {
            if closed {
                return false
            }
            closed = true
            openCompletion = nil
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            reconnectWorkItem?.cancel()
            reconnectWorkItem = nil
            let connection = self.connection
            self.connection = nil
            connection?.cancel()
            return true
        }

        guard shouldProceed else { return }

        emitLifecycleEvent(name: "closed", extra: [
            "error_code": errorCode,
            "error_message": errorMessage,
        ])
        onTerminal(streamID)
    }

    private func completeOpenIfNeeded(_ output: NativeNetworkSseOpenExecutionOutput) {
        let completion = lock.withLock { () -> ((NativeNetworkSseOpenExecutionOutput) -> Void)? in
            let completion = openCompletion
            openCompletion = nil
            timeoutWorkItem?.cancel()
            timeoutWorkItem = nil
            return completion
        }

        guard let completion else {
            return
        }

        callbackQueue.async {
            completion(output)
        }
    }

    private func failOpen(errorCode: String, errorMessage: String) {
        completeOpenIfNeeded(NativeNetworkSseOpenExecutionOutput(
            streamID: nil,
            eventName: nil,
            errorCode: errorCode,
            errorMessage: errorMessage,
            reason: errorCode
        ))
    }

    private func emitLifecycleEvent(name: String, extra: [String: Any] = [:]) {
        var payload: [String: Any] = [
            "stream_id": streamID,
            "event_name": eventName,
            "event": name,
        ]

        for (key, value) in extra {
            payload[key] = value
        }

        eventDispatcher.emit(eventName: eventName, payload: payload)
    }

    private func mapError(error: Error?, timedOut: Bool) -> (code: String, message: String) {
        if timedOut {
            return (
                code: NativeNetworkSseErrorTimeout,
                message: "URLSession SSE open timed out after \(config.openTimeoutMs)ms"
            )
        }

        guard let error else {
            return (
                code: NativeNetworkSseErrorStreamClosed,
                message: "URLSession SSE stream closed by remote host"
            )
        }

        if let urlError = error as? URLError {
            if urlError.code == .timedOut {
                return (
                    code: NativeNetworkSseErrorTimeout,
                    message: "URLSession SSE open timed out after \(config.openTimeoutMs)ms"
                )
            }

            if urlError.code == .cancelled {
                return (
                    code: NativeNetworkSseErrorCancelled,
                    message: "URLSession SSE stream cancelled"
                )
            }

            return (
                code: NativeNetworkSseErrorProtocol,
                message: urlError.localizedDescription
            )
        }

        return (
            code: NativeNetworkSseErrorProtocol,
            message: error.localizedDescription
        )
    }

    private func isClosed() -> Bool {
        return lock.withLock { closed }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
