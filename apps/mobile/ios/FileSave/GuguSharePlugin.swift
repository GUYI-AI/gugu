#if os(iOS)
import Capacitor
import UIKit
import Photos
import UniformTypeIdentifiers

@objc(GuguSharePlugin)
final class GuguSharePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    let identifier = "GuguSharePlugin"
    let jsName = "GuguShare"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "stage", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)]
    private let io = DispatchQueue(label: "app.gugu.save-file")
    private var store: GuguSaveFileStore?
    private var setupError: Error?
    private var active: (CAPPluginCall, GuguSaveFileStore.Entry)?
    override func load() {
        // Plugin load precedes all staging; this directory never contains user originals.
        do { store = try GuguSaveFileStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("GuguSaveFiles", isDirectory: true)) }
        catch { setupError = error }
    }
    @objc func stage(_ call: CAPPluginCall) {
        io.async {
            let id = call.getString("id") ?? ""
            do {
                guard let store = self.store, self.setupError == nil else { throw GuguSaveFileStore.failure() }
                switch call.getString("op") {
                case "begin":
                    guard let r = call.getObject("revision"), let n = r["size_bytes"] as? NSNumber,
                          n.doubleValue.isFinite, n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991, n.doubleValue.rounded() == n.doubleValue,
                          let hash = r["sha256"] as? String, let name = call.getString("name") else { throw GuguSaveFileStore.failure() }
                    let token = try store.begin(name: name, size: n.int64Value, sha256: hash, mime: r["content_type"] as? String ?? "application/octet-stream")
                    call.resolve(["id": token]); return
                case "chunk":
                    guard let text = call.getString("bytes"), text.count <= 699_052, let bytes = Data(base64Encoded: text) else { throw GuguSaveFileStore.failure() }
                    try store.append(id: id, data: bytes)
                case "commit": try store.commit(id: id)
                case "abort": try store.remove(id: id)
                default: throw GuguSaveFileStore.failure()
                }
                call.resolve()
            } catch {
                do { try self.store?.remove(id: id) } catch { call.reject("File cleanup failed", "save_cleanup_failed"); return }
                call.reject("File verification failed", "save_verification_failed")
            }
        }
    }
    @objc func save(_ call: CAPPluginCall) {
        io.async {
            let id = call.getString("id") ?? ""
            do {
                guard let store = self.store else { throw GuguSaveFileStore.failure() }
                let entry = try store.take(id: id)
                DispatchQueue.main.async { self.presentSave(call, entry) }
            } catch {
                do { try self.store?.remove(id: id) } catch { call.reject("File cleanup failed", "save_cleanup_failed"); return }
                call.reject("File verification failed", "save_verification_failed")
            }
        }
    }
    private func presentSave(_ call: CAPPluginCall, _ entry: GuguSaveFileStore.Entry) {
        guard active == nil, UIApplication.shared.applicationState == .active else { finish(call, entry, saved: false, error: GuguSaveFileStore.failure()); return }
        active = (call, entry)
        let kind = GuguSaveFileStore.kind(mime: entry.mime, name: entry.url.lastPathComponent)
        guard kind != .file else { exportFile(entry); return }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            DispatchQueue.main.async {
                if status == .authorized || status == .limited {
                    let resource: PHAssetResourceType = kind == .video ? .video : .photo
                    PHPhotoLibrary.shared().performChanges({
                        PHAssetCreationRequest.forAsset().addResource(with: resource, fileURL: entry.url, options: nil)
                    }) { saved, error in
                        DispatchQueue.main.async { self.complete(saved: saved, error: error ?? (saved ? nil : GuguSaveFileStore.failure())) }
                    }
                } else { self.exportFile(entry) }
            }
        }
    }
    private func exportFile(_ entry: GuguSaveFileStore.Entry) {
        guard let controller = bridge?.viewController, controller.viewIfLoaded?.window != nil,
              controller.presentedViewController == nil, UIApplication.shared.applicationState == .active else { complete(saved: false, error: GuguSaveFileStore.failure()); return }
        let picker = UIDocumentPickerViewController(forExporting: [entry.url], asCopy: true)
        picker.delegate = self
        controller.present(picker, animated: true) { picker.presentationController?.delegate = self }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { complete(saved: !urls.isEmpty, error: urls.isEmpty ? GuguSaveFileStore.failure() : nil) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { complete(saved: false, error: nil) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { complete(saved: false, error: nil) }
    private func complete(saved: Bool, error: Error?) {
        guard let (call, entry) = active else { return }; active = nil
        finish(call, entry, saved: saved, error: error)
    }
    private func finish(_ call: CAPPluginCall, _ entry: GuguSaveFileStore.Entry, saved: Bool, error: Error?) {
        io.async {
            do {
                guard let store = self.store else { throw GuguSaveFileStore.failure() }
                let result = try store.finish(entry, saved: saved, error: error)
                call.resolve(["saved": result])
            } catch { call.reject("File save failed", "save_failed") }
        }
    }
}
#endif
