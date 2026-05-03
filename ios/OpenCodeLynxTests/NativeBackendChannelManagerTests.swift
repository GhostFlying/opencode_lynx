import Foundation
import Testing

@testable import OpenCodeLynx

private final class FakeBackendChannelTransport: NativeBackendChannelTransport {
    var startedURL: URL?
    var startedHeaders: [String: String] = [:]
    var startedPingIntervalMs: Int = 0
    var sentTexts: [String] = []
    var cancelCalls: [(code: Int?, reason: String?)] = []

    private var onOpen: (() -> Void)?
    private var onText: ((String) -> Void)?
    private var onState: ((NativeBackendChannelTransportState) -> Void)?

    func start(
        url: URL,
        headers: [String: String],
        pingIntervalMs: Int,
        onOpen: @escaping () -> Void,
        onText: @escaping (String) -> Void,
        onState: @escaping (NativeBackendChannelTransportState) -> Void
    ) {
        self.startedURL = url
        self.startedHeaders = headers
        self.startedPingIntervalMs = pingIntervalMs
        self.onOpen = onOpen
        self.onText = onText
        self.onState = onState
    }

    func send(text: String, completion: @escaping (Error?) -> Void) {
        sentTexts.append(text)
        completion(nil)
    }

    func cancel(code: Int?, reason: String?) {
        cancelCalls.append((code, reason))
    }

    // Test driver hooks
    func triggerOpen() { onOpen?() }
    func triggerText(_ text: String) { onText?(text) }
    func triggerState(_ state: NativeBackendChannelTransportState) { onState?(state) }
}

private struct FakeTransportFactory: NativeBackendChannelTransportFactory {
    let transports: [FakeBackendChannelTransport]
    private let cursor = NSLock()
    private var index: Int { _index.value }
    private let _index: AtomicInt = AtomicInt()

    init(transports: [FakeBackendChannelTransport]) {
        self.transports = transports
    }

    func makeTransport() -> NativeBackendChannelTransport {
        let i = _index.incrementAndGet() - 1
        return transports[i]
    }
}

private final class AtomicInt {
    private let lock = NSLock()
    private var v: Int = 0
    var value: Int { lock.withLock { v } }
    func incrementAndGet() -> Int {
        lock.lock(); defer { lock.unlock() }
        v += 1
        return v
    }
}

private final class CapturingDispatcherTarget: NSObject, NativeBackendChannelEventDispatching {
    private let lock = NSLock()
    private var calls: [(eventName: String, payload: [String: Any])] = []

    func sendGlobalEvent(_ eventName: String, withParams params: [Any]?) {
        let payload = (params?.first as? [String: Any]) ?? [:]
        lock.withLock { calls.append((eventName, payload)) }
    }

    func snapshot() -> [(eventName: String, payload: [String: Any])] {
        lock.withLock { calls }
    }
}

private func makeDispatcher(_ target: CapturingDispatcherTarget) -> NativeBackendChannelEventDispatcher {
    // Use a synchronous queue so emits land before the test inspects state.
    let q = DispatchQueue(label: "test.backend.channel.events")
    return NativeBackendChannelEventDispatcher(target: target, queue: q)
}

private func waitForEvents(_ target: CapturingDispatcherTarget, atLeast count: Int, timeout: TimeInterval = 1.0) {
    let deadline = Date(timeIntervalSinceNow: timeout)
    while target.snapshot().count < count, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.01)
    }
}

struct NativeBackendChannelManagerTests {
    @Test func openReturnsChannelIDSynchronouslyAndOpenStateArrivesAsync() async throws {
        let fake = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fake]),
            channelIDFactory: { "channel-fixed" }
        )

        var output: NativeBackendChannelOpenOutput?
        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://example.com/socket")!,
                headers: ["Authorization": "Bearer xyz"],
                messageEventName: "msg-evt",
                stateEventName: "state-evt",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { output = $0 }
        )

        // Completion fires synchronously with a channelID — no need to wait
        // for the socket handshake.
        #expect(output?.channelID == "channel-fixed")
        #expect(output?.errorCode == nil)
        #expect(fake.startedHeaders["Authorization"] == "Bearer xyz")
        #expect(fake.startedURL?.absoluteString == "ws://example.com/socket")
        #expect(target.snapshot().isEmpty) // no state events yet

        // The handshake outcome is delivered later, asynchronously.
        fake.triggerOpen()
        waitForEvents(target, atLeast: 1)

        let calls = target.snapshot()
        #expect(calls.count == 1)
        #expect(calls[0].eventName == "state-evt")
        #expect(calls[0].payload["state"] as? String == "open")
    }

    @Test func textFrameDispatchesMessageEvent() async throws {
        let fake = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fake]),
            channelIDFactory: { "channel-1" }
        )

        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://example.com")!,
                headers: [:],
                messageEventName: "msg-evt",
                stateEventName: "state-evt",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { _ in }
        )
        fake.triggerOpen()
        waitForEvents(target, atLeast: 1)

        fake.triggerText("{\"hello\":\"world\"}")
        waitForEvents(target, atLeast: 2)

        let messageCall = target.snapshot().first { $0.eventName == "msg-evt" }
        let frame = messageCall?.payload["frame"] as? [String: Any]
        #expect(frame?["hello"] as? String == "world")
    }

    @Test func nonJsonFrameEmitsErrorState() async throws {
        let fake = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fake]),
            channelIDFactory: { "channel-1" }
        )

        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://example.com")!,
                headers: [:],
                messageEventName: "msg-evt",
                stateEventName: "state-evt",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { _ in }
        )
        fake.triggerOpen()
        fake.triggerText("not json")
        waitForEvents(target, atLeast: 2)

        let errorCall = target.snapshot().first {
            $0.eventName == "state-evt" && ($0.payload["state"] as? String) == "error"
        }
        #expect(errorCall != nil)
        #expect(errorCall?.payload["error"] as? String == "non_json_frame")
    }

    @Test func sendForwardsJsonText() async throws {
        let fake = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fake]),
            channelIDFactory: { "channel-1" }
        )

        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://example.com")!,
                headers: [:],
                messageEventName: "msg-evt",
                stateEventName: "state-evt",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { _ in }
        )
        fake.triggerOpen()
        waitForEvents(target, atLeast: 1)

        var sendOutput: NativeBackendChannelSendOutput?
        manager.send(channelID: "channel-1", payload: ["ping": 1]) { sendOutput = $0 }

        #expect(sendOutput?.sent == true)
        #expect(fake.sentTexts.count == 1)
        let body = try JSONSerialization.jsonObject(with: Data(fake.sentTexts[0].utf8)) as? [String: Any]
        #expect((body?["ping"] as? NSNumber)?.intValue == 1)
    }

    @Test func sendOnUnknownChannelFails() async throws {
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: []),
            channelIDFactory: { "unused" }
        )

        var sendOutput: NativeBackendChannelSendOutput?
        manager.send(channelID: "ghost", payload: ["x": 1]) { sendOutput = $0 }

        #expect(sendOutput?.sent == false)
        #expect(sendOutput?.errorCode == "channel_closed")
    }

    @Test func closeCancelsTransportAndDropsRegistry() async throws {
        let fake = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fake]),
            channelIDFactory: { "channel-1" }
        )

        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://example.com")!,
                headers: [:],
                messageEventName: "msg-evt",
                stateEventName: "state-evt",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { _ in }
        )
        fake.triggerOpen()
        waitForEvents(target, atLeast: 1)

        var closeOutput: NativeBackendChannelCloseOutput?
        manager.close(channelID: "channel-1", code: 1000, reason: "bye") { closeOutput = $0 }

        #expect(closeOutput?.closed == true)
        #expect(fake.cancelCalls.count == 1)
        #expect(fake.cancelCalls[0].code == 1000)
        #expect(fake.cancelCalls[0].reason == "bye")

        // Subsequent send on the closed channel reports channel_closed.
        var sendOutput: NativeBackendChannelSendOutput?
        manager.send(channelID: "channel-1", payload: ["x": 1]) { sendOutput = $0 }
        #expect(sendOutput?.errorCode == "channel_closed")
    }

    @Test func transportFailureEmitsErrorStateAfterSyncOpen() async throws {
        let fake = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fake]),
            channelIDFactory: { "channel-1" }
        )

        var output: NativeBackendChannelOpenOutput?
        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://example.com")!,
                headers: [:],
                messageEventName: "msg-evt",
                stateEventName: "state-evt",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { output = $0 }
        )

        // Completion already returned the channelID; the failure is surfaced
        // through the state event channel, not through the open completion.
        #expect(output?.channelID == "channel-1")
        #expect(output?.errorCode == nil)

        fake.triggerState(.failed(error: "tcp reset", code: 54, reason: "ECONNRESET"))
        waitForEvents(target, atLeast: 1)

        let errorCall = target.snapshot().first { $0.eventName == "state-evt" }
        #expect(errorCall?.payload["state"] as? String == "error")
        #expect(errorCall?.payload["error"] as? String == "tcp reset")

        // After the failure the channel is dropped from the registry, so a
        // subsequent send returns channel_closed.
        var sendOutput: NativeBackendChannelSendOutput?
        manager.send(channelID: "channel-1", payload: ["x": 1]) { sendOutput = $0 }
        #expect(sendOutput?.errorCode == "channel_closed")
    }

    @Test func concurrentChannelsAreIsolated() async throws {
        let fakeA = FakeBackendChannelTransport()
        let fakeB = FakeBackendChannelTransport()
        let target = CapturingDispatcherTarget()
        var ids = ["channel-A", "channel-B"]
        let manager = NativeURLSessionBackendChannelManager(
            transportFactory: FakeTransportFactory(transports: [fakeA, fakeB]),
            channelIDFactory: { ids.removeFirst() }
        )

        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://a")!,
                headers: [:],
                messageEventName: "msgA",
                stateEventName: "stateA",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { _ in }
        )
        manager.open(
            NativeBackendChannelOpenInput(
                url: URL(string: "ws://b")!,
                headers: [:],
                messageEventName: "msgB",
                stateEventName: "stateB",
                pingIntervalMs: 0,
                eventDispatcher: makeDispatcher(target)
            ),
            completion: { _ in }
        )
        fakeA.triggerOpen()
        fakeB.triggerOpen()
        waitForEvents(target, atLeast: 2)

        manager.close(channelID: "channel-A", code: nil, reason: nil) { _ in }
        #expect(fakeA.cancelCalls.count == 1)
        #expect(fakeB.cancelCalls.isEmpty)

        // B can still send.
        var sendOutput: NativeBackendChannelSendOutput?
        manager.send(channelID: "channel-B", payload: ["k": "v"]) { sendOutput = $0 }
        #expect(sendOutput?.sent == true)
    }
}
