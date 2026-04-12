// All pods are guaranteed present

// Copyright 2025 The OpenCode Authors. All rights reserved.

import SwiftUI
import Lynx
import SDWebImage
import SDWebImageWebPCoder
import DebugRouter

private enum DevSourceDeepLinkDecisionReason: String {
    case disabled
    case invalid_outer
    case invalid_target
    case forbidden_target
    case accepted
}

private struct DevSourceDeepLinkDecision {
    let reason: DevSourceDeepLinkDecisionReason
    let target: String?
}

final class DevSourceStartupOverrideState {
    static let shared = DevSourceStartupOverrideState()

    private let lock = NSLock()
    private var pendingTarget: String?

    private init() {}

    fileprivate func setPendingIfAccepted(_ decision: DevSourceDeepLinkDecision) {
        guard decision.reason == .accepted, let target = decision.target else {
            return
        }
        lock.lock()
        pendingTarget = target
        lock.unlock()
    }

    func consumePending() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let value = pendingTarget
        pendingTarget = nil
        return value
    }
}

enum DevSourceIngressCoordinator {
    static let defaultStartupURL = "hybrid://lynxview?bundle=.%2Fmain.lynx.bundle&hide_status_bar=1&hide_nav_bar=1"

    private static let startupState = DevSourceStartupOverrideState.shared
    private static let routeHandlerLock = NSLock()
    private static var warmRouteHandler: ((String) -> Void)?

    static func bindWarmRouteHandler(_ handler: @escaping (String) -> Void) {
        routeHandlerLock.lock()
        warmRouteHandler = handler
        routeHandlerLock.unlock()
    }

    static func resolveStartupURL() -> String {
        startupState.consumePending() ?? defaultStartupURL
    }

    @discardableResult
    static func handleIncomingURL(_ url: URL, preferWarmRoute: Bool) -> Bool {
        let decision = DevSourceDeepLinkParser.parse(url)
        guard decision.reason != .invalid_outer else {
            return false
        }

        guard decision.reason == .accepted, let target = decision.target else {
            return true
        }

        if preferWarmRoute {
            routeHandlerLock.lock()
            let handler = warmRouteHandler
            routeHandlerLock.unlock()
            if let handler {
                DispatchQueue.main.async {
                    handler(target)
                }
                return true
            }
        }

        startupState.setPendingIfAccepted(decision)
        return true
    }
}

private enum DevSourceDeepLinkParser {
    private static let outerScheme = "opencode-lynx"
    private static let outerHost = "dev-source"
    private static let allowedInnerHosts: Set<String> = ["lynxview_page", "lynxview"]
    private static let allowedCarrierKeys: Set<String> = ["bundle", "url"]
    private static let maxTargetLength = 2048

    static func parse(_ url: URL) -> DevSourceDeepLinkDecision {
#if DEBUG
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return DevSourceDeepLinkDecision(reason: .invalid_outer, target: nil)
        }

        guard components.scheme == outerScheme,
              components.host == outerHost,
              components.user == nil,
              components.password == nil,
              (components.path.isEmpty || components.path == "/"),
              components.fragment == nil else {
            return DevSourceDeepLinkDecision(reason: .invalid_outer, target: nil)
        }

        guard let rawQuery = components.percentEncodedQuery,
              let targetEncoded = parseSingleTargetQuery(rawQuery) else {
            return DevSourceDeepLinkDecision(reason: .invalid_outer, target: nil)
        }

        guard targetEncoded.count <= maxTargetLength,
              !targetEncoded.isEmpty,
              isValidPercentEncoding(targetEncoded),
              let decodedTarget = targetEncoded.removingPercentEncoding,
              !decodedTarget.isEmpty,
              decodedTarget.count <= maxTargetLength else {
            return DevSourceDeepLinkDecision(reason: .invalid_target, target: nil)
        }

        components = URLComponents(string: decodedTarget) ?? URLComponents()
        guard components.scheme == "hybrid",
              let host = components.host,
              allowedInnerHosts.contains(host),
              components.user == nil,
              components.password == nil,
              components.fragment == nil else {
            return DevSourceDeepLinkDecision(reason: .forbidden_target, target: nil)
        }

        let hasAllowedCarrier = (components.queryItems ?? []).contains { item in
            guard allowedCarrierKeys.contains(item.name.lowercased()) else {
                return false
            }
            guard let value = item.value else {
                return false
            }
            return !value.isEmpty
        }

        guard hasAllowedCarrier else {
            return DevSourceDeepLinkDecision(reason: .forbidden_target, target: nil)
        }

        return DevSourceDeepLinkDecision(reason: .accepted, target: decodedTarget)
#else
        return DevSourceDeepLinkDecision(reason: .disabled, target: nil)
#endif
    }

    private static func parseSingleTargetQuery(_ rawQuery: String) -> String? {
        let pairs = rawQuery.split(separator: "&", omittingEmptySubsequences: false)
        guard pairs.count == 1,
              let pair = pairs.first else {
            return nil
        }

        let keyValue = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        guard keyValue.count == 2,
              keyValue[0] == "target" else {
            return nil
        }

        return String(keyValue[1])
    }

    private static func isValidPercentEncoding(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        var index = 0

        while index < scalars.count {
            if scalars[index] == "%" {
                guard index + 2 < scalars.count,
                      isHexDigit(scalars[index + 1]),
                      isHexDigit(scalars[index + 2]) else {
                    return false
                }
                index += 3
            } else {
                index += 1
            }
        }

        return true
    }

    private static func isHexDigit(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 48...57, 65...70, 97...102:
            return true
        default:
            return false
        }
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let firstURL = connectionOptions.urlContexts.first?.url else {
            return
        }
        DevSourceIngressCoordinator.handleIncomingURL(firstURL, preferWarmRoute: false)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            DevSourceIngressCoordinator.handleIncomingURL(context.url, preferWarmRoute: true)
        }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)

        NSLog("[OpenCode] AppDelegate didFinishLaunching")
        // Initialize Lynx environment
        OpenCodeLynxBootstrap.initialize()
        NSLog("[OpenCode] Bootstrap complete")

        if let launchURL = launchOptions?[.url] as? URL {
            DevSourceIngressCoordinator.handleIncomingURL(launchURL, preferWarmRoute: false)
        }

        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey : Any] = [:]
    ) -> Bool {
        DevSourceIngressCoordinator.handleIncomingURL(url, preferWarmRoute: true)
    }
}

@main
struct OpenCodeLynxApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    var body: some Scene {
        WindowGroup {
            DemoVC()
        }
    }
}
