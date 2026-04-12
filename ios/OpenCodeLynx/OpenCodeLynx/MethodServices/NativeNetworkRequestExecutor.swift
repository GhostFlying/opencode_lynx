import Foundation

enum NativeNetworkRequestDefaults {
    static let timeoutMs = 30_000
    static let statusServiceUnavailable = 503
    static let statusGatewayTimeout = 504
    static let statusBadGateway = 502
    static let statusClientClosed = 499
}

struct NativeNetworkRequestExecutionInput {
    let path: String
    let method: String
    let headers: [AnyHashable: Any]
    let body: NSObject?
    let timeoutMs: Int
}

struct NativeNetworkRequestExecutionOutput {
    let ok: Bool
    let statusCode: Int
    let headers: [String: String]
    let body: Any?
    let errorCode: String?
    let errorMessage: String?
}

protocol NativeNetworkRequestExecuting {
    func execute(_ input: NativeNetworkRequestExecutionInput, completion: @escaping (NativeNetworkRequestExecutionOutput) -> Void)
}

protocol NativeURLSessionDataTasking: AnyObject {
    func resume()
    func cancel()
}

extension URLSessionDataTask: NativeURLSessionDataTasking {}

protocol NativeURLSessioning {
    func dataTask(with request: URLRequest, completionHandler: @escaping (Data?, URLResponse?, Error?) -> Void) -> NativeURLSessionDataTasking
}

struct NativeURLSessionAdapter: NativeURLSessioning {
    private let session: URLSession

    init(session: URLSession) {
        self.session = session
    }

    func dataTask(with request: URLRequest, completionHandler: @escaping (Data?, URLResponse?, Error?) -> Void) -> NativeURLSessionDataTasking {
        return session.dataTask(with: request, completionHandler: completionHandler)
    }
}

final class NativeURLSessionNetworkRequestExecutor: NativeNetworkRequestExecuting {
    private let session: NativeURLSessioning
    private let timerQueue: DispatchQueue

    init(
        session: NativeURLSessioning = NativeURLSessionAdapter(session: .shared),
        timerQueue: DispatchQueue = DispatchQueue(label: "opencode.network.request.timeout", qos: .utility)
    ) {
        self.session = session
        self.timerQueue = timerQueue
    }

    func execute(_ input: NativeNetworkRequestExecutionInput, completion: @escaping (NativeNetworkRequestExecutionOutput) -> Void) {
        guard let url = resolveAbsoluteURL(from: input.path) else {
            completion(unavailableOutput(message: "iOS network.request requires an absolute http(s) URL for URLSession transport."))
            return
        }

        let timeoutMs = max(input.timeoutMs, 1)
        let state = NativeNetworkRequestExecutionState()
        var request = URLRequest(url: url)
        request.httpMethod = input.method
        request.timeoutInterval = Double(timeoutMs) / 1_000.0

        applyHeaders(input.headers, to: &request)
        applyBody(input.body, to: &request)

        var task: NativeURLSessionDataTasking?
        let timeoutWorkItem = DispatchWorkItem {
            state.markTimedOut()
            task?.cancel()
        }

        task = session.dataTask(with: request) { [weak self] data, response, error in
            timeoutWorkItem.cancel()
            guard let self else {
                return
            }
            let output = self.mapResult(
                data: data,
                response: response,
                error: error,
                timedOut: state.isTimedOut,
                timeoutMs: timeoutMs
            )
            state.completeOnce(output, completion: completion)
        }

        timerQueue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeoutWorkItem)
        task?.resume()
    }

    private func mapResult(
        data: Data?,
        response: URLResponse?,
        error: Error?,
        timedOut: Bool,
        timeoutMs: Int
    ) -> NativeNetworkRequestExecutionOutput {
        if let urlError = error as? URLError {
            if timedOut || urlError.code == .timedOut {
                return timeoutOutput(timeoutMs: timeoutMs)
            }

            if urlError.code == .cancelled {
                return cancelledOutput(message: "URLSession request cancelled before completion")
            }

            return protocolOutput(message: urlError.localizedDescription)
        }

        if let error {
            return protocolOutput(message: error.localizedDescription)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            return protocolOutput(message: "URLSession response missing HTTP status")
        }

        let statusCode = httpResponse.statusCode
        let headers = flattenHeaders(httpResponse.allHeaderFields)
        let body: Any? = {
            guard let data else {
                return nil
            }
            return String(decoding: data, as: UTF8.self)
        }()

        return NativeNetworkRequestExecutionOutput(
            ok: (200 ..< 300).contains(statusCode),
            statusCode: statusCode,
            headers: headers,
            body: body,
            errorCode: nil,
            errorMessage: nil
        )
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

    private func applyHeaders(_ headers: [AnyHashable: Any], to request: inout URLRequest) {
        for (rawName, rawValue) in headers {
            guard let name = rawName as? String else {
                continue
            }
            let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizedName.isEmpty {
                continue
            }

            let value: String
            if let stringValue = rawValue as? String {
                value = stringValue
            } else {
                value = String(describing: rawValue)
            }

            request.setValue(value, forHTTPHeaderField: normalizedName)
        }
    }

    private func applyBody(_ body: NSObject?, to request: inout URLRequest) {
        guard let body else {
            return
        }

        if body is NSNull {
            return
        }

        if let data = body as? Data {
            request.httpBody = data
            return
        }

        if let text = body as? String {
            request.httpBody = text.data(using: .utf8)
            return
        }

        if let text = body as? NSString {
            request.httpBody = String(text).data(using: .utf8)
            return
        }

        if JSONSerialization.isValidJSONObject(body),
           let jsonData = try? JSONSerialization.data(withJSONObject: body, options: []) {
            request.httpBody = jsonData
            return
        }

        request.httpBody = String(describing: body).data(using: .utf8)
    }

    private func flattenHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        var flattened: [String: String] = [:]
        for (rawName, rawValue) in headers {
            guard let name = rawName as? String else {
                continue
            }
            let normalizedName = name
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizedName.isEmpty {
                continue
            }
            flattened[normalizedName] = String(describing: rawValue)
        }
        return flattened
    }

    private func timeoutOutput(timeoutMs: Int) -> NativeNetworkRequestExecutionOutput {
        return NativeNetworkRequestExecutionOutput(
            ok: false,
            statusCode: NativeNetworkRequestDefaults.statusGatewayTimeout,
            headers: [:],
            body: nil,
            errorCode: "bridge_timeout",
            errorMessage: "URLSession request timed out after \(timeoutMs)ms"
        )
    }

    private func cancelledOutput(message: String) -> NativeNetworkRequestExecutionOutput {
        return NativeNetworkRequestExecutionOutput(
            ok: false,
            statusCode: NativeNetworkRequestDefaults.statusClientClosed,
            headers: [:],
            body: nil,
            errorCode: "bridge_cancelled",
            errorMessage: message
        )
    }

    private func protocolOutput(message: String) -> NativeNetworkRequestExecutionOutput {
        return NativeNetworkRequestExecutionOutput(
            ok: false,
            statusCode: NativeNetworkRequestDefaults.statusBadGateway,
            headers: [:],
            body: nil,
            errorCode: "bridge_protocol",
            errorMessage: message
        )
    }

    private func unavailableOutput(message: String) -> NativeNetworkRequestExecutionOutput {
        return NativeNetworkRequestExecutionOutput(
            ok: false,
            statusCode: NativeNetworkRequestDefaults.statusServiceUnavailable,
            headers: [:],
            body: nil,
            errorCode: "bridge_unavailable",
            errorMessage: message
        )
    }
}

private final class NativeNetworkRequestExecutionState {
    private let lock = NSLock()
    private var timedOut = false
    private var completed = false

    var isTimedOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOut
    }

    func markTimedOut() {
        lock.lock()
        defer { lock.unlock() }
        timedOut = true
    }

    func completeOnce(_ output: NativeNetworkRequestExecutionOutput, completion: @escaping (NativeNetworkRequestExecutionOutput) -> Void) {
        lock.lock()
        if completed {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        completion(output)
    }
}
