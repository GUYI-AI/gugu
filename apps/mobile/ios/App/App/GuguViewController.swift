import Capacitor
import UIKit

final class GuguViewController: CAPBridgeViewController {
    private var imageViewerActive = false
    private var normalBackground: UIColor?
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
        bridge?.registerPluginInstance(GuguAuthStoragePlugin())
        bridge?.registerPluginInstance(GuguImageViewerChromePlugin())
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
