// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GuguPushNotifications",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "GuguPushNotifications", targets: ["GuguPushNotifications"])],
    targets: [
        .target(name: "GuguPushNotifications"),
        .testTarget(name: "GuguPushNotificationsTests", dependencies: ["GuguPushNotifications"]),
    ]
)
