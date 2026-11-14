// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GuguPhoneCalendar",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "GuguPhoneCalendar", targets: ["GuguPhoneCalendar"])],
    targets: [
        .target(name: "GuguPhoneCalendar"),
        .testTarget(name: "GuguPhoneCalendarTests", dependencies: ["GuguPhoneCalendar"]),
    ]
)
