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
    private var active: (id: String, controller: NativeTextSelectionController, call: CAPPluginCall)?

    @objc public func open(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, let text = call.getString("text"),
              let start = call.getInt("start"), let end = call.getInt("end"),
              let title = call.getString("title"), let closeLabel = call.getString("closeLabel"),
              let appearance = call.getObject("appearance"),
              let width = appearance["width"] as? Double, width > 0,
              let height = appearance["height"] as? Double, height > 0,
              let viewportWidth = appearance["viewportWidth"] as? Double, viewportWidth > 0,
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
            let page = NativeTextSelectionController(text: text, range: range, title: title, closeLabel: closeLabel, appearance: appearance)
            page.modalPresentationStyle = .overFullScreen
            page.overrideUserInterfaceStyle = call.getBool("dark") == true ? .dark : .light
            page.onClose = { [weak self] in self?.finish(id) }
            self.active = (id, page, call)
            presenter.present(page, animated: false)
        }
    }

    @objc public func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let active = self.active, active.id == call.getString("id") else { call.resolve(); return }
            active.controller.dismiss(animated: false) {
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
private final class NativeSelectionTextView: UITextView {
    var onCopy: (() -> Void)?
    override func copy(_ sender: Any?) { super.copy(sender); onCopy?() }
}

private final class NativeTextSelectionController: UIViewController, UIGestureRecognizerDelegate {
    private let body = NativeSelectionTextView()
    private let initialText: String
    private let initialRange: NSRange
    private let closeLabel: String
    private let appearance: [String: Any]
    private var selected = false
    var onClose: (() -> Void)?

    init(text: String, range: NSRange, title: String, closeLabel: String, appearance: [String: Any]) {
        initialText = text
        initialRange = range
        self.closeLabel = closeLabel
        self.appearance = appearance
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let outside = UITapGestureRecognizer(target: self, action: #selector(closePage))
        outside.delegate = self
        view.addGestureRecognizer(outside)
        body.isEditable = false
        body.isSelectable = true
        let fontSize = appearance["fontSize"] as? Double ?? 16
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = appearance["lineHeight"] as? Double ?? 24
        paragraph.maximumLineHeight = paragraph.minimumLineHeight
        let hex = (appearance["color"] as? String ?? "#181818").dropFirst()
        let rgb = UInt32(hex, radix: 16) ?? 0x181818
        body.attributedText = NSAttributedString(string: initialText, attributes: [
            .font: UIFont.systemFont(ofSize: fontSize), .paragraphStyle: paragraph,
            .foregroundColor: UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1),
        ])
        body.backgroundColor = .clear
        body.textContainerInset = .zero
        body.textContainer.lineFragmentPadding = 0
        body.onCopy = { [weak self] in _ = self?.closePage() }
        body.accessibilityCustomActions = [UIAccessibilityCustomAction(name: closeLabel, target: self, selector: #selector(closePage))]
        body.accessibilityIdentifier = "message-native-text-selection"
        view.addSubview(body)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let scale = view.bounds.width / (appearance["viewportWidth"] as? Double ?? view.bounds.width)
        let width = (appearance["width"] as? Double ?? view.bounds.width) * scale
        let height = max(1, (appearance["height"] as? Double ?? view.bounds.height) * scale)
        body.frame = CGRect(x: (appearance["x"] as? Double ?? 0) * scale,
                            y: view.safeAreaInsets.top + (appearance["y"] as? Double ?? 0) * scale,
                            width: width, height: height)
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
        body.layoutIfNeeded()
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

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let target = touch.view else { return true }
        return !target.isDescendant(of: body)
    }

    @objc private func closePage() -> Bool {
        dismiss(animated: false) { self.onClose?() }
        return true
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed { onClose?() }
    }
}
