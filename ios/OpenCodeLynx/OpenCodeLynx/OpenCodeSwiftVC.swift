// Copyright 2025 The OpenCode Authors. All rights reserved.

import Foundation
import SwiftUI
import Lynx

/// SwiftUI wrapper that creates the initial LynxView and manages navigation.
struct OpenCodeLynxRootView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> some UIViewController {
        let startupURL = DevSourceIngressCoordinator.resolveStartupURL()
        let parsed = OpenCodeSchemeParser.parse(scheme: startupURL)

        let bundleURL = parsed?.bundleURL ?? "asset:///main.lynx.bundle"
        let globalProps = parsed?.globalProps ?? [:]

        let vc = OpenCodeLynxViewController(bundleURL: bundleURL, globalProps: globalProps)
        let naviVC = UINavigationController(rootViewController: vc)
        naviVC.isNavigationBarHidden = true
        naviVC.navigationBar.isHidden = true
        naviVC.toolbar.isHidden = true
        naviVC.additionalSafeAreaInsets = .zero
        naviVC.view.insetsLayoutMarginsFromSafeArea = false

        // Set up navigation coordinator for open/close bridge calls
        let coordinator = OpenCodeNavigationCoordinator(navigationController: naviVC)
        objc_setAssociatedObject(naviVC, "navCoordinator", coordinator, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        // Bind warm route handler for deep links arriving after launch
        DevSourceIngressCoordinator.bindWarmRouteHandler { target in
            NotificationCenter.default.post(
                name: .openCodeNavigationOpen,
                object: nil,
                userInfo: ["scheme": target]
            )
        }

        return naviVC
    }

    func updateUIViewController(_ uiViewController: UIViewControllerType, context: Context) {
    }
}

struct DemoVC: View {
    var body: some View {
        OpenCodeLynxRootView()
            .ignoresSafeArea()
    }
}
