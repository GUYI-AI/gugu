import Capacitor
import UIKit

@objc(GuguTextSelectionPlugin)
public final class GuguTextSelectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GuguTextSelectionPlugin"
    public let jsName = "GuguTextSelection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]
    private var active: (id: String, navigation: UINavigationController, call: CAPPluginCall)?

    @objc public func open(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, let text = call.getString("text"),
              let start = call.getInt("start"), let end = call.getInt("end"),
              let title = call.getString("title"), let closeLabel = call.getString("closeLabel"),
              start >= 0, start < end, end <= (text as NSString).length else {
            call.reject("Invalid text selection")
            return
        }
        let range = NSRange(location: start, length: end - start)
        guard (text as NSString).rangeOfComposedCharacterSequences(for: range) == range else {
            call.reject("Invalid text boundary")
            return
        }
        DispatchQueue.main.async {
            guard self.active == nil, let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else {
                call.reject("Text selection is already open or unavailable")
                return
            }
            let page = NativeTextSelectionController(text: text, range: range, title: title, closeLabel: closeLabel)
            let navigation = UINavigationController(rootViewController: page)
            navigation.modalPresentationStyle = .fullScreen
            navigation.overrideUserInterfaceStyle = call.getBool("dark") == true ? .dark : .light
            page.onClose = { [weak self] in self?.finish(id) }
            self.active = (id, navigation, call)
            presenter.present(navigation, animated: true)
        }
    }

    @objc public func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let active = self.active, active.id == call.getString("id") else { call.resolve(); return }
            active.navigation.dismiss(animated: true) {
                self.finish(active.id)
                call.resolve()
            }
        }
    }

    private func finish(_ id: String) {
        guard let active = active, active.id == id else { return }
        self.active = nil
        active.call.resolve()
    }
}

/** UIKit owns selection, draggable endpoints, the editing menu and copying. */
private final class NativeTextSelectionController: UIViewController {
    private let body = UITextView()
    private let initialText: String
    private let initialRange: NSRange
    private let closeLabel: String
    private var selected = false
    var onClose: (() -> Void)?

    init(text: String, range: NSRange, title: String, closeLabel: String) {
        initialText = text
        initialRange = range
        self.closeLabel = closeLabel
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: closeLabel, style: .plain, target: self, action: #selector(closePage))
        body.isEditable = false
        body.isSelectable = true
        body.font = UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: 16))
        body.adjustsFontForContentSizeCategory = true
        body.backgroundColor = .systemBackground
        body.textColor = .label
        body.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 24, right: 16)
        body.text = initialText
        body.accessibilityIdentifier = "message-native-text-selection"
        body.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(body)
        NSLayoutConstraint.activate([
            body.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            body.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            body.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !selected else { return }
        selected = true
        view.layoutIfNeeded()
        body.becomeFirstResponder()
        body.selectedRange = NSRange(location: initialRange.location, length: 0)
        body.select(nil)
        body.selectedRange = initialRange
        body.scrollRangeToVisible(initialRange)
        guard let selection = body.selectedTextRange else { return }
        let rect = body.firstRect(for: selection)
        if #available(iOS 16.0, *) {
            let menu = UIEditMenuInteraction(delegate: nil)
            body.addInteraction(menu)
            menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: CGPoint(x: rect.midX, y: rect.minY)))
        } else {
            UIMenuController.shared.showMenu(from: body, rect: rect)
        }
    }

    @objc private func closePage() { navigationController?.dismiss(animated: true) { self.onClose?() } }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true { onClose?() }
    }
}
