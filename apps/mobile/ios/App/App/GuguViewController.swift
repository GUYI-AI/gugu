import Capacitor
import UIKit

final class GuguViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        do {
            let runtime = try GuguIOSAppRuntime.open()
            for plugin in runtime.plugins() { bridge?.registerPluginInstance(plugin) }
        } catch {
            // A shell without validated packaged configuration cannot publish a
            // native owner or expose calendar access. Keep shared login usable.
            bridge?.registerPluginInstance(GuguAuthStoragePlugin())
            let code = (error as? GuguHostFailure)?.code ?? "native_setup_failed"
            NSLog("Gugu native identity unavailable (%@)", code)
        }
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
