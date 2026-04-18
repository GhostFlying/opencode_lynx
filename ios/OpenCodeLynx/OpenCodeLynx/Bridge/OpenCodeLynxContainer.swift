import Foundation
import UIKit
import Lynx
import SDWebImage
import SDWebImageWebPCoder
import DebugRouter

// MARK: - Template Provider

/// Loads Lynx bundle files from the app's LynxResources directory or via HTTP.
final class OpenCodeTemplateProvider: NSObject, LynxTemplateProvider {
    func loadTemplate(withUrl url: String, onComplete callback: LynxTemplateLoadBlock?) {
        NSLog("[OpenCode] TemplateProvider loading: %@", url)
        // Check if it's a local resource path (e.g., "asset:///main.lynx.bundle")
        if url.hasPrefix("asset://") {
            let resourceName = url
                .replacingOccurrences(of: "asset:///", with: "")
                .replacingOccurrences(of: "asset://", with: "")

            // Bundles are in the LynxResources subdirectory of the app bundle
            let searchDirs = [nil, "LynxResources", "Resources/Assets"]
            let path = searchDirs.lazy.compactMap { dir in
                Bundle.main.path(forResource: resourceName, ofType: nil, inDirectory: dir)
            }.first
            if let path {
                do {
                    let data = try Data(contentsOf: URL(fileURLWithPath: path))
                    callback?(data, nil)
                } catch {
                    callback?(nil, error)
                }
            } else {
                let error = NSError(domain: "OpenCodeTemplateProvider", code: 404,
                                    userInfo: [NSLocalizedDescriptionKey: "Template not found: \(resourceName)"])
                callback?(nil, error)
            }
            return
        }

        // HTTP/HTTPS URLs
        if let requestURL = URL(string: url), let scheme = requestURL.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            let task = URLSession.shared.dataTask(with: requestURL) { data, _, error in
                callback?(data, error)
            }
            task.resume()
            return
        }

        // Try as local file path
        let fileURL = URL(fileURLWithPath: url)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            do {
                let data = try Data(contentsOf: fileURL)
                callback?(data, nil)
            } catch {
                callback?(nil, error)
            }
            return
        }

        let error = NSError(domain: "OpenCodeTemplateProvider", code: 400,
                            userInfo: [NSLocalizedDescriptionKey: "Unsupported template URL: \(url)"])
        callback?(nil, error)
    }
}

// MARK: - LynxConfig Factory

/// Creates a shared LynxConfig with the bridge module registered.
enum OpenCodeLynxConfigFactory {
    private static let _shared: LynxConfig = {
        let config = LynxConfig(provider: OpenCodeTemplateProvider())
        config.register(OpenCodeBridgeModule.self)
        return config
    }()

    static var shared: LynxConfig { _shared }
}

// MARK: - Container ViewController

/// UIViewController that hosts a LynxView, loading a bundle with optional global props.
final class OpenCodeLynxViewController: UIViewController {
    private struct KeyboardEventState: Equatable {
        let status: String
        let height: CGFloat
    }

    let bundleURL: String
    private var baseGlobalProps: [String: Any]
    private(set) var lynxView: LynxView?
    private var lastViewportSize: CGSize = .zero
    private var lastSafeAreaInsets: UIEdgeInsets = .zero
    private var hasLoadedTemplate = false
    private var viewportSyncCount = 0
    private var keyboardEndFrameInScreen: CGRect = .null
    private var lastKeyboardEventState = KeyboardEventState(status: "off", height: 0)

    init(bundleURL: String, globalProps: [String: Any] = [:]) {
        self.bundleURL = bundleURL
        self.baseGlobalProps = globalProps
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        edgesForExtendedLayout = [.all]
        extendedLayoutIncludesOpaqueBars = true
        additionalSafeAreaInsets = .zero
        viewRespectsSystemMinimumLayoutMargins = false
        view.insetsLayoutMarginsFromSafeArea = false
        view.backgroundColor = .black

        NSLog("[OpenCode] LynxViewController viewDidLoad, bundleURL=%@, frame=%@", bundleURL, NSCoder.string(for: view.bounds))

        let config = OpenCodeLynxConfigFactory.shared
        registerKeyboardObservers()

        let lv = LynxView { builder in
            builder.config = config
            builder.frame = .zero
        }
        lv.enableAutoLayout = true

        NSLog("[OpenCode] LynxView created, bundleURL=%@", bundleURL)

        view.addSubview(lv)
        lv.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            lv.topAnchor.constraint(equalTo: view.topAnchor),
            lv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            lv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            lv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        self.lynxView = lv
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncLynxViewportIfNeeded()
        emitKeyboardEventIfNeeded()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationController?.setToolbarHidden(true, animated: false)
        navigationController?.additionalSafeAreaInsets = .zero
        navigationController?.view.insetsLayoutMarginsFromSafeArea = false
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        syncLynxViewportIfNeeded()
        emitKeyboardEventIfNeeded()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        syncLynxViewportIfNeeded()
        emitKeyboardEventIfNeeded()
    }

    override var childForHomeIndicatorAutoHidden: UIViewController? {
        nil
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        true
    }

    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge {
        [.bottom]
    }

    private func syncLynxViewportIfNeeded() {
        guard let lynxView else { return }

        let viewportBounds = view.bounds
        guard viewportBounds.width > 0, viewportBounds.height > 0 else { return }

        viewportSyncCount += 1
        let safeInsets = currentSafeAreaInsets()
        let safeAreaReady = isSafeAreaReady(safeInsets)
        if safeAreaReady {
            applyGlobalProps(force: !hasLoadedTemplate, safeInsets: safeInsets, to: lynxView)
        }

        let viewportSize = viewportBounds.size
        let viewportChanged = viewportSize != lastViewportSize

        if viewportChanged {
            lastViewportSize = viewportSize
            lynxView.preferredLayoutWidth = viewportSize.width
            lynxView.preferredLayoutHeight = viewportSize.height
            lynxView.updateScreenMetrics(withWidth: viewportSize.width, height: viewportSize.height)
        }

        ensureTemplateLoadedIfNeeded(on: lynxView, safeInsets: safeInsets, safeAreaReady: safeAreaReady)
        if viewportChanged {
            lynxView.setNeedsLayout()
            lynxView.layoutIfNeeded()

            NSLog(
                "[OpenCode] Lynx viewport synced full-screen: bounds=%@ safeInsets=%@",
                NSCoder.string(for: viewportBounds),
                NSCoder.string(for: view.safeAreaInsets)
            )
        }
    }

    private func applyGlobalProps(force: Bool, safeInsets: UIEdgeInsets, to lynxView: LynxView) {
        if !force && safeInsets == lastSafeAreaInsets {
            return
        }

        lastSafeAreaInsets = safeInsets
        baseGlobalProps["safeAreaInsets"] = [
            "top": safeInsets.top,
            "right": safeInsets.right,
            "bottom": safeInsets.bottom,
            "left": safeInsets.left,
        ]
        lynxView.updateGlobalProps(with: baseGlobalProps)

        NSLog(
            "[OpenCode] Applied globalProps safe area: %@",
            NSCoder.string(for: safeInsets)
        )
    }

    private func currentSafeAreaInsets() -> UIEdgeInsets {
        if let windowInsets = view.window?.safeAreaInsets {
            return windowInsets
        }
        let keyWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: \.isKeyWindow)
        if let keyWindowInsets = keyWindow?.safeAreaInsets {
            return keyWindowInsets
        }
        return view.safeAreaInsets
    }

    private func isSafeAreaReady(_ safeInsets: UIEdgeInsets) -> Bool {
        guard view.window != nil else {
            return false
        }
        return safeInsets.top > 0 || safeInsets.bottom > 0 || safeInsets.left > 0 || safeInsets.right > 0
    }

    private func ensureTemplateLoadedIfNeeded(
        on lynxView: LynxView,
        safeInsets: UIEdgeInsets,
        safeAreaReady: Bool
    ) {
        if hasLoadedTemplate {
            return
        }
        if !safeAreaReady {
            NSLog(
                "[OpenCode] Deferring template load until safe area resolves: %@ syncCount=%ld",
                NSCoder.string(for: safeInsets),
                viewportSyncCount
            )
            return
        }
        applyGlobalProps(force: true, safeInsets: safeInsets, to: lynxView)
        hasLoadedTemplate = true
        lynxView.loadTemplate(fromURL: bundleURL)
        NSLog(
            "[OpenCode] Loading template after safe area ready: %@",
            NSCoder.string(for: safeInsets)
        )
    }

    private func registerKeyboardObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleKeyboardWillShow(_:)),
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleKeyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleKeyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
    }

    @objc private func handleKeyboardWillShow(_ notification: Notification) {
        updateKeyboardFrame(from: notification)
    }

    @objc private func handleKeyboardWillHide(_ notification: Notification) {
        updateKeyboardFrame(from: notification, hidden: true)
    }

    @objc private func handleKeyboardWillChangeFrame(_ notification: Notification) {
        updateKeyboardFrame(from: notification)
    }

    private func updateKeyboardFrame(from notification: Notification, hidden: Bool = false) {
        if hidden {
            keyboardEndFrameInScreen = .null
        } else if let value = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue {
            keyboardEndFrameInScreen = value.cgRectValue
        }
        emitKeyboardEventIfNeeded()
    }

    private func emitKeyboardEventIfNeeded() {
        guard hasLoadedTemplate, let lynxView else { return }

        let effectiveHeight = currentKeyboardEffectiveHeight()
        let nextState = KeyboardEventState(
            status: effectiveHeight > 0 ? "on" : "off",
            height: effectiveHeight
        )
        if nextState == lastKeyboardEventState {
            return
        }

        lastKeyboardEventState = nextState
        lynxView.sendGlobalEvent(
            "keyboardstatuschanged",
            withParams: [nextState.status, NSNumber(value: Double(nextState.height))]
        )
    }

    private func currentKeyboardEffectiveHeight() -> CGFloat {
        guard !keyboardEndFrameInScreen.isNull,
              view.window != nil else {
            return 0
        }

        let keyboardFrameInView = view.convert(keyboardEndFrameInScreen, from: nil)
        let overlapHeight = view.bounds.intersection(keyboardFrameInView).height
        let effectiveHeight = max(0, overlapHeight - currentSafeAreaInsets().bottom)
        return effectiveHeight > 0.5 ? effectiveHeight : 0
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        lynxView?.clearForDestroy()
    }
}

// MARK: - Scheme Parsing

/// Parses a `hybrid://lynxview?bundle=...&route_params=...` scheme into a resolved
/// bundle URL and globalProps dictionary used to launch a new Lynx page.
///
/// Contract:
///   - `route_params` query value is URL-decoded, then JSON-parsed into a dictionary,
///     then stored as `globalProps["routeParams"]` (object, NOT string).
///   - All query items are collected into `globalProps["queryItems"]` as a `[String:String]` dict.
///   - A unique `containerID` is generated for each page.
enum OpenCodeSchemeParser {
    struct Result {
        let bundleURL: String
        let globalProps: [String: Any]
    }

    static func parse(scheme: String) -> Result? {
        guard let components = URLComponents(string: scheme),
              let queryItems = components.queryItems else { return nil }

        var bundleName = ""
        var queryItemsDict: [String: String] = [:]
        var routeParamsObject: Any?

        for item in queryItems {
            let value = item.value ?? ""
            queryItemsDict[item.name] = value

            if item.name == "bundle" {
                bundleName = value
            } else if item.name == "route_params" {
                if let decoded = value.removingPercentEncoding,
                   let data = decoded.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) {
                    routeParamsObject = json
                } else {
                    // Fallback: store as raw string if not valid JSON
                    routeParamsObject = value.removingPercentEncoding ?? value
                }
            }
        }

        guard !bundleName.isEmpty else { return nil }

        // Resolve bundle URL
        let resolvedURL: String
        if bundleName.hasPrefix("./") {
            resolvedURL = "asset:///" + String(bundleName.dropFirst(2))
        } else if bundleName.hasPrefix("asset://") || bundleName.hasPrefix("http") {
            resolvedURL = bundleName
        } else {
            resolvedURL = "asset:///" + bundleName
        }

        var globalProps: [String: Any] = [:]
        globalProps["queryItems"] = queryItemsDict
        globalProps["containerID"] = UUID().uuidString.lowercased()
        if let routeParams = routeParamsObject {
            globalProps["routeParams"] = routeParams
        }

        return Result(bundleURL: resolvedURL, globalProps: globalProps)
    }
}

// MARK: - Navigation Coordinator

/// Listens for navigation.open / navigation.close bridge calls and manages the navigation stack.
final class OpenCodeNavigationCoordinator {
    weak var navigationController: UINavigationController?

    init(navigationController: UINavigationController) {
        self.navigationController = navigationController
        setupObservers()
    }

    private func setupObservers() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleOpen(_:)),
            name: .openCodeNavigationOpen, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleClose(_:)),
            name: .openCodeNavigationClose, object: nil)
    }

    @objc private func handleOpen(_ notification: Notification) {
        guard let scheme = notification.userInfo?["scheme"] as? String else { return }
        guard let nav = navigationController else { return }
        guard let parsed = OpenCodeSchemeParser.parse(scheme: scheme) else { return }

        let vc = OpenCodeLynxViewController(bundleURL: parsed.bundleURL, globalProps: parsed.globalProps)
        vc.navigationItem.hidesBackButton = true
        nav.pushViewController(vc, animated: true)
        nav.setNavigationBarHidden(true, animated: false)
    }

    @objc private func handleClose(_ notification: Notification) {
        guard let nav = navigationController else { return }
        if nav.viewControllers.count > 1 {
            nav.popViewController(animated: true)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

// MARK: - App Initialization

/// Sets up the Lynx environment. Call from AppDelegate.didFinishLaunchingWithOptions.
enum OpenCodeLynxBootstrap {
    static func initialize() {
        // Image decoders
        let webPCoder = SDImageWebPCoder.shared
        SDImageCodersManager.shared.addCoder(webPCoder)

        // Lynx DevTool
        LynxEnv.sharedInstance().lynxDebugEnabled = true
        LynxEnv.sharedInstance().devtoolEnabled = true
        DebugRouter.instance().enableAllSessions()
    }
}
