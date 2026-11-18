import Capacitor
import UIKit
import WebKit

final class GuguViewController: CAPBridgeViewController {
    private var imageViewerActive = false
    private var normalBackground: UIColor?
    private var textScaleScript: WKUserScript?
    override var preferredStatusBarStyle: UIStatusBarStyle {
        imageViewerActive ? .lightContent : super.preferredStatusBarStyle
    }

    func setImageViewerActive(_ active: Bool) {
        if active == imageViewerActive { return }
        if active { normalBackground = view.backgroundColor }
        imageViewerActive = active
        view.backgroundColor = active ? .black : normalBackground
        setNeedsStatusBarAppearanceUpdate()
    }

    override func capacitorDidLoad() {
        do {
            let runtime = try GuguIOSAppRuntime.open()
            for plugin in try runtime.plugins() { bridge?.registerPluginInstance(plugin) }
        } catch {
            // A shell without validated packaged configuration cannot publish a
            // native owner or expose calendar access. Keep shared login usable.
            bridge?.registerPluginInstance(GuguAuthStoragePlugin())
            let code = (error as? GuguHostFailure)?.code ?? "native_setup_failed"
            NSLog("Gugu native identity unavailable (%@)", code)
        }
        bridge?.registerPluginInstance(GuguSharePlugin())
        bridge?.registerPluginInstance(GuguImageViewerChromePlugin())
        installTextScale()
        NotificationCenter.default.addObserver(forName: UIContentSizeCategory.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.installTextScale()
        }
    }

    // @@@text-scale - Dynamic Type reaches the page the way Android's font scale does (GuguPageScale.java): a number set
    // before the page's first script, which mobile/textScale.ts turns into text sizes. Body text at the default size is
    // 17 pt, so the scale is the body style's size over 17. A change while the app runs replaces the script for later
    // loads and tells the live page, which reloads itself.
    private func installTextScale() {
        guard let controller = webView?.configuration.userContentController else { return }
        let assign = "window.__guguFontScale=\(UIFontMetrics(forTextStyle: .body).scaledValue(for: 17) / 17);"
        if let old = textScaleScript {
            let others = controller.userScripts.filter { $0 !== old }
            controller.removeAllUserScripts()
            others.forEach(controller.addUserScript)
        }
        let script = WKUserScript(source: assign, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        controller.addUserScript(script)
        textScaleScript = script
        webView?.evaluateJavaScript(assign + "window.dispatchEvent(new Event('gugu:font-scale'))")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let content = webView else { return }
        // Capacitor uses the WebView as its root view. Give it a container rather than changing
        // that root's own frame on every layout pass. The phone shell then fills a safe viewport.
        let container = UIView(frame: content.frame)
        container.backgroundColor = .systemBackground
        view = container
        container.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            content.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor),
        ])
    }
}

// iOS-only capability: the shared viewer never changes Android or desktop chrome.
@objc(GuguImageViewerChromePlugin)
public final class GuguImageViewerChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GuguImageViewerChromePlugin"
    public let jsName = "GuguImageViewerChrome"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "setActive", returnType: CAPPluginReturnPromise)]

    @objc public func setActive(_ call: CAPPluginCall) {
        guard let active = call.getBool("active") else { call.reject("Missing active state"); return }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController as? GuguViewController else {
                call.reject("Image viewer controller unavailable")
                return
            }
            controller.setImageViewerActive(active)
            call.resolve()
        }
    }
}
