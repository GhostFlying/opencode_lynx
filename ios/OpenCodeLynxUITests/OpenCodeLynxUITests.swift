// Copyright 2025 The OpenCode Authors. All rights reserved.


import Foundation
import XCTest

private enum ReadinessValidationError: Error, Equatable {
    case markerTimeout(String)
    case malformedSignal(String)
    case outOfOrder
    case runIDMismatch
}

private enum DeepLinkIngressError: Error, Equatable {
    case malformedURL(String)
    case appDidNotForeground
}

private struct ReadySignal: Equatable {
    let phase: String
    let seq: Int
    let runID: String
}

private struct ChatExpectation {
    let sessionTitle: String
    let visibleMessageSnippet: String
}

final class OpenCodeLynxUITests: XCTestCase {
    private let mainReadyMarker = "qa_main_ready_marker_v1"
    private let secondReadyMarker = "qa_second_ready_marker_v1"
    private let secondCloseActionMarker = "qa_second_close_action_v1"
    private let mainReadySignalMarkerPrefix = "qa_main_ready_signal_v1"
    private let deeplinkScheme = "opencode-lynx://dev-source?target="
    /// Visible text that only the real main page's landing hero renders
    /// (`hero__title` in src/pages/main/App.tsx). Used to assert the app
    /// landed on the real main page after deep-link fallback, without
    /// coupling the production UI to QA markers.
    private let mainPageIdentityText = "OpenCode"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Launch arguments that force the saved-connection storage read to return
    /// nothing for the next launch, regardless of what a previous test wrote
    /// into the simulator's persistent defaults. NSArgumentDomain overrides
    /// UserDefaults persistent domains, and `readSavedConnection` treats empty
    /// strings as "no saved connection". NOTE: only effective for `launch()`
    /// — `XCUIApplication.open(_:)` launches without honoring launchArguments,
    /// so deep-link tests rely on `waitForMainPageReady` instead.
    private var blankConnectionLaunchArgs: [String] {
        ["-opencodelynx.opencode_connection", ""]
    }

    /// Wait for any deterministic sign that the real main page mounted, in
    /// either the `landing` state (no saved connection → "OpenCode" hero
    /// title visible) or the `connected` state (saved connection present and
    /// auto-connect succeeded → native tabbar exposes "Sessions" /
    /// "Settings"). Used by fallback-to-main deeplink tests, which can't use
    /// `blankConnectionLaunchArgs` because `app.open(_:)` ignores launchArgs.
    private func waitForMainPageReady(_ app: XCUIApplication, timeout: TimeInterval) throws {
        let candidates = ["OpenCode", "Sessions"]
        let predicate = NSPredicate(format: "label IN %@", candidates)
        let match = app.staticTexts.matching(predicate).firstMatch
        guard match.waitForExistence(timeout: timeout) else {
            throw ReadinessValidationError.markerTimeout("main-page-ready(\(candidates.joined(separator: "|")))")
        }
    }

    @MainActor
    func testSmokeCorePathLaunchSecondCloseAndOrderedReadiness() throws {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments += blankConnectionLaunchArgs

        let qaTestTarget = "hybrid://lynxview_page?bundle=qa-test.lynx.bundle"
        let qaTestDeepLink = try wrapAsOuterDeepLink(qaTestTarget)
        try triggerRealURLIngress(qaTestDeepLink, app: app, timeout: 15)

        _ = try waitForStaticText(app, marker: mainReadyMarker, timeout: 10)

        let reactReadySignal = try waitForReadySignal(
            app,
            phase: "react_ready",
            seq: 1,
            timeout: 5
        )
        let uiReadySignal = try waitForReadySignal(
            app,
            phase: "ui_ready",
            seq: 2,
            timeout: 10
        )

        try assertOrderedReadiness(reactReadySignal, uiReadySignal)

        _ = try waitForStaticText(app, marker: mainReadyMarker, timeout: 5)
    }

    @MainActor
    func testMarkerFailurePathFailsClosedOnMissingMarker() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertThrowsError(
            try waitForStaticText(app, marker: "qa_missing_marker_v1", timeout: 1)
        ) { error in
            XCTAssertEqual(error as? ReadinessValidationError, .markerTimeout("qa_missing_marker_v1"))
        }
    }

    func testOrderFailurePathFailsClosedOnOutOfOrderSignals() throws {
        let events = [
            ReadySignal(phase: "ui_ready", seq: 2, runID: "run-order-1"),
            ReadySignal(phase: "react_ready", seq: 1, runID: "run-order-1"),
        ]

        XCTAssertThrowsError(
            try assertOrderedReadiness(events[0], events[1])
        ) { error in
            XCTAssertEqual(error as? ReadinessValidationError, .outOfOrder)
        }
    }

    @MainActor
    func testDeepLinkStartupHappyPathAndConsumeOnceFallbacksToDefaultOnSecondLaunch() throws {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments += blankConnectionLaunchArgs

        let startupTarget = "hybrid://lynxview_page?bundle=second.lynx.bundle&title=Second%20Page&screen_orientation=portrait"
        let startupDeepLink = try wrapAsOuterDeepLink(startupTarget)
        try triggerRealURLIngress(startupDeepLink, app: app, timeout: 15)

        _ = try waitForStaticText(app, marker: secondReadyMarker, timeout: 10)

        app.terminate()
        app.launch()

        try waitForMainPageReady(app, timeout: 10)
        XCTAssertFalse(
            app.staticTexts[secondReadyMarker].waitForExistence(timeout: 1),
            "consume-once assertion failed: second-page startup route unexpectedly persisted across relaunch"
        )
    }

    @MainActor
    func testDeepLinkStartupInvalidTargetFailsClosedToMainPath() throws {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments += blankConnectionLaunchArgs

        try triggerRealURLIngress("opencode-lynx://dev-source?target=%", app: app, timeout: 15)

        try waitForMainPageReady(app, timeout: 10)
        XCTAssertFalse(
            app.staticTexts[secondReadyMarker].waitForExistence(timeout: 1),
            "invalid-target assertion failed: app should fail closed to default main path"
        )
    }

    @MainActor
    func testDeepLinkChatRouteParamsPopulateTitleAndSessionID() throws {
        let app = XCUIApplication()
        app.terminate()

        let startupTarget = "hybrid://lynxview?bundle=.%2Fchat.lynx.bundle&route_params=%7B%22sessionId%22%3A%22ses_e2e%22%2C%22sessionTitle%22%3A%22Route%20Params%20OK%22%2C%22connection%22%3A%7B%22ip%22%3A%22127.0.0.1%22%2C%22port%22%3A%223000%22%2C%22password%22%3A%22%22%7D%7D"
        let startupDeepLink = try wrapAsOuterDeepLink(startupTarget)
        try triggerRealURLIngress(startupDeepLink, app: app, timeout: 15)

        _ = try waitForStaticText(app, marker: "Route Params OK", timeout: 10)
        XCTAssertFalse(
            app.staticTexts["No session ID provided."].waitForExistence(timeout: 1),
            "route_params assertion failed: chat page should not report a missing session id"
        )
    }

    @MainActor
    func testMainFlowOpensChatWithSavedConnectionAndRouteParams() throws {
        // This test requires an OpenCode-shaped HTTP server on 127.0.0.1:3000.
        // Locally, if the server is absent, skip so a bare `xcodebuild test`
        // run stays green.
        guard isLocalTestServerAvailable() else {
            throw XCTSkip("Local test server on 127.0.0.1:3000 is not available")
        }

        let app = XCUIApplication()
        app.terminate()
        // NSArgumentDomain overrides UserDefaults per launch; the bridge reads
        // `opencodelynx.<key>` from UserDefaults.
        app.launchArguments += [
            "-opencodelynx.opencode_connection",
            #"{"ip":"127.0.0.1","port":"3000","password":""}"#,
        ]
        app.launch()

        let chatExpectation = try fetchFirstSessionChatExpectation()
        _ = try waitForStaticText(app, marker: "Sessions", timeout: 20)
        let sessionTitleElement = try waitForStaticText(app, marker: chatExpectation.sessionTitle, timeout: 20)
        sessionTitleElement.tap()

        _ = try waitForStaticText(app, marker: chatExpectation.sessionTitle, timeout: 10)
        _ = try waitForStaticText(app, marker: chatExpectation.visibleMessageSnippet, timeout: 10)
        XCTAssertFalse(
            app.staticTexts["No session ID provided."].waitForExistence(timeout: 1),
            "main-flow assertion failed: chat page should receive a session id"
        )
        XCTAssertFalse(
            app.staticTexts["No connection payload provided. Go back and reconnect first."].waitForExistence(timeout: 1),
            "main-flow assertion failed: chat page should receive the connection payload through route params"
        )
    }

    private func isLocalTestServerAvailable() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:3000/session") else { return false }
        var available = false
        let semaphore = DispatchSemaphore(value: 0)
        let task = URLSession.shared.dataTask(with: url) { _, response, _ in
            available = (response as? HTTPURLResponse)?.statusCode == 200
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + .seconds(3))
        task.cancel()
        return available
    }

    @MainActor
    func testKeyboardAvoidanceKeepsSettingsFieldAndChatComposerAboveKeyboard() throws {
        let app = XCUIApplication()
        app.terminate()
        app.launch()

        let settingsField = try focusSettingsConnectionField(app)
        let settingsKeyboard = try waitForKeyboard(app, timeout: 5)
        assertElementFrame(settingsField, above: settingsKeyboard, description: "settings connection field")
        dismissKeyboard(app)
        waitForKeyboardToDisappear(app, timeout: 5)

        let startupTarget = "hybrid://lynxview?bundle=.%2Fchat.lynx.bundle&route_params=%7B%22sessionId%22%3A%22ses_e2e%22%2C%22sessionTitle%22%3A%22Route%20Params%20OK%22%2C%22connection%22%3A%7B%22ip%22%3A%22127.0.0.1%22%2C%22port%22%3A%223000%22%2C%22password%22%3A%22%22%7D%7D"
        let startupDeepLink = try wrapAsOuterDeepLink(startupTarget)
        try triggerRealURLIngress(startupDeepLink, app: app, timeout: 15)

        _ = try waitForStaticText(app, marker: "Route Params OK", timeout: 10)
        let chatComposer = try focusChatComposer(app)
        let chatKeyboard = try waitForKeyboard(app, timeout: 5)
        assertElementFrame(chatComposer, above: chatKeyboard, description: "chat composer")
        dismissKeyboard(app)
        waitForKeyboardToDisappear(app, timeout: 5)
    }

    private func waitForStaticText(_ app: XCUIApplication, marker: String, timeout: TimeInterval) throws -> XCUIElement {
        let markerElement = app.staticTexts[marker]
        guard markerElement.waitForExistence(timeout: timeout) else {
            throw ReadinessValidationError.markerTimeout(marker)
        }
        return markerElement
    }

    private func waitForKeyboard(_ app: XCUIApplication, timeout: TimeInterval) throws -> XCUIElement {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.waitForExistence(timeout: timeout) else {
            throw ReadinessValidationError.markerTimeout("keyboard")
        }
        return keyboard
    }

    private func waitForKeyboardToDisappear(_ app: XCUIApplication, timeout: TimeInterval) {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, "Keyboard should disappear within \(timeout)s")
    }

    private func dismissKeyboard(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
    }

    private func focusSettingsConnectionField(_ app: XCUIApplication) throws -> XCUIElement {
        let settingsTab = app.staticTexts["Settings"]
        if settingsTab.waitForExistence(timeout: 5) {
            settingsTab.tap()
        }

        let secureField = app.secureTextFields["Optional"]
        if secureField.waitForExistence(timeout: 5) {
            secureField.tap()
            return secureField
        }

        throw ReadinessValidationError.markerTimeout("settings connection input")
    }

    private func focusChatComposer(_ app: XCUIApplication) throws -> XCUIElement {
        let placeholderText = app.staticTexts["输入消息..."]
        if placeholderText.waitForExistence(timeout: 5) {
            placeholderText.tap()
            return placeholderText
        }

        let textView = app.textViews.element(boundBy: 0)
        if textView.waitForExistence(timeout: 5) {
            textView.tap()
            return textView
        }

        throw ReadinessValidationError.markerTimeout("chat composer")
    }

    private func assertElementFrame(_ element: XCUIElement, above keyboard: XCUIElement, description: String, slack: CGFloat = 6) {
        let elementBottom = element.frame.maxY
        let keyboardTop = keyboard.frame.minY
        XCTAssertLessThanOrEqual(
            elementBottom,
            keyboardTop + slack,
            "\(description) should stay above the keyboard (elementBottom=\(elementBottom), keyboardTop=\(keyboardTop))"
        )
    }

    private func waitForReadySignal(_ app: XCUIApplication, phase: String, seq: Int, timeout: TimeInterval) throws -> ReadySignal {
        let signalPrefix = "\(mainReadySignalMarkerPrefix)|phase=\(phase)|seq=\(seq)|run_id="
        let matchingSignal = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", signalPrefix)).firstMatch

        guard matchingSignal.waitForExistence(timeout: timeout) else {
            throw ReadinessValidationError.markerTimeout(signalPrefix)
        }

        return try parseReadySignal(matchingSignal.label)
    }

    private func parseReadySignal(_ label: String) throws -> ReadySignal {
        let expectedPrefix = "\(mainReadySignalMarkerPrefix)|"
        guard label.hasPrefix(expectedPrefix) else {
            throw ReadinessValidationError.malformedSignal(label)
        }

        let segments = label
            .split(separator: "|")
            .dropFirst()
            .map(String.init)

        var values = [String: String]()
        for segment in segments {
            let pair = segment.split(separator: "=", maxSplits: 1).map(String.init)
            guard pair.count == 2 else {
                throw ReadinessValidationError.malformedSignal(label)
            }
            values[pair[0]] = pair[1]
        }

        guard let phase = values["phase"],
              let seqRaw = values["seq"],
              let seq = Int(seqRaw),
              let runID = values["run_id"],
              !runID.isEmpty else {
            throw ReadinessValidationError.malformedSignal(label)
        }

        return ReadySignal(phase: phase, seq: seq, runID: runID)
    }

    private func assertOrderedReadiness(_ first: ReadySignal, _ second: ReadySignal) throws {
        if first.phase != "react_ready" || first.seq != 1 {
            throw ReadinessValidationError.outOfOrder
        }

        if second.phase != "ui_ready" || second.seq != 2 {
            throw ReadinessValidationError.outOfOrder
        }

        if first.runID != second.runID {
            throw ReadinessValidationError.runIDMismatch
        }
    }

    private func waitForDisappearance(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func fetchFirstSessionChatExpectation() throws -> ChatExpectation {
        let sessionsURL = URL(string: "http://127.0.0.1:3000/session")!
        let sessionsData = try Data(contentsOf: sessionsURL)
        guard let sessions = try JSONSerialization.jsonObject(with: sessionsData) as? [[String: Any]],
              let firstSession = sessions.first,
              let sessionID = firstSession["id"] as? String,
              !sessionID.isEmpty,
              let sessionTitle = firstSession["title"] as? String,
              !sessionTitle.isEmpty else {
            throw NSError(domain: "OpenCodeLynxUITests", code: 2, userInfo: [NSLocalizedDescriptionKey: "failed to read first session from local server"])
        }

        let messagesURL = URL(string: "http://127.0.0.1:3000/session/\(sessionID)/message")!
        let messagesData = try Data(contentsOf: messagesURL)
        guard let messages = try JSONSerialization.jsonObject(with: messagesData) as? [[String: Any]] else {
            throw NSError(domain: "OpenCodeLynxUITests", code: 3, userInfo: [NSLocalizedDescriptionKey: "failed to read message list from local server"])
        }

        let visibleText = try firstVisibleMessageText(in: messages)
        return ChatExpectation(
            sessionTitle: sessionTitle,
            visibleMessageSnippet: visibleSnippet(from: visibleText)
        )
    }

    private func firstVisibleMessageText(in messages: [[String: Any]]) throws -> String {
        for message in messages {
            guard let parts = message["parts"] as? [[String: Any]] else {
                continue
            }
            for part in parts {
                guard let type = part["type"] as? String, type == "text",
                      let text = part["text"] as? String else {
                    continue
                }
                let normalized = text
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if normalized.count >= 12 {
                    return normalized
                }
            }
        }

        throw NSError(domain: "OpenCodeLynxUITests", code: 4, userInfo: [NSLocalizedDescriptionKey: "failed to find a stable visible text message in the first session"])
    }

    private func visibleSnippet(from text: String) -> String {
        let maxLength = 80
        if text.count <= maxLength {
            return text
        }
        let index = text.index(text.startIndex, offsetBy: maxLength)
        return String(text[..<index]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func wrapAsOuterDeepLink(_ target: String) throws -> String {
        let allowedTargetValueCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        guard let encoded = target.addingPercentEncoding(withAllowedCharacters: allowedTargetValueCharacters) else {
            throw NSError(domain: "OpenCodeLynxUITests", code: 1, userInfo: [NSLocalizedDescriptionKey: "failed to encode deeplink target"])
        }
        return "\(deeplinkScheme)\(encoded)"
    }

    @MainActor
    private func triggerRealURLIngress(_ deeplink: String, app: XCUIApplication, timeout: TimeInterval) throws {
        guard let deepLinkURL = URL(string: deeplink) else {
            throw DeepLinkIngressError.malformedURL(deeplink)
        }

        app.open(deepLinkURL)

        guard app.wait(for: .runningForeground, timeout: timeout) else {
            throw DeepLinkIngressError.appDidNotForeground
        }
    }
}
