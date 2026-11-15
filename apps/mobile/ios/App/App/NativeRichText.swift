import UIKit

enum NativeRichTextError: Error { case invalidStyle }

/** A text snapshot with UIKit attributes; selection and editing remain entirely UIKit's. */
struct NativeRichText {
    struct Run {
        let range: NSRange
        let size: CGFloat
        let weight: CGFloat
        let italic: Bool
        let monospace: Bool
        let underline: Bool
        let color: UIColor
        let background: UIColor?
    }
    struct Paragraph {
        let range: NSRange
        let height: CGFloat
        let before: CGFloat
        let after: CGFloat
        let indent: CGFloat
        let first: CGFloat
        let marker: Bool
    }
    struct Block {
        let range: NSRange
        let color: UIColor
        let left: CGFloat
        let right: CGFloat
        let top: CGFloat
        let bottom: CGFloat
        let radius: CGFloat
    }
    let text: String
    let runs: [Run]
    let paragraphs: [Paragraph]
    let blocks: [Block]

    private static func number(_ value: Any?, positive: Bool = false) throws -> CGFloat {
        guard let value = value as? NSNumber, value.doubleValue.isFinite,
              value.doubleValue >= 0, !positive || value.doubleValue > 0 else { throw NativeRichTextError.invalidStyle }
        return CGFloat(value.doubleValue)
    }
    private static func range(_ value: [String: Any], length: Int) throws -> NSRange {
        guard let start = value["start"] as? Int, let end = value["end"] as? Int,
              start >= 0, end > start, end <= length else { throw NativeRichTextError.invalidStyle }
        return NSRange(location: start, length: end - start)
    }
    private static func color(_ value: Any?) throws -> UIColor {
        guard let value = value as? [String: Any] else { throw NativeRichTextError.invalidStyle }
        let red = try number(value["red"]), green = try number(value["green"]), blue = try number(value["blue"]), alpha = try number(value["alpha"])
        guard red <= 255, green <= 255, blue <= 255, alpha <= 1 else { throw NativeRichTextError.invalidStyle }
        return UIColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
    }

    init(text: String, runs: [[String: Any]], paragraphs: [[String: Any]], blocks: [[String: Any]]) throws {
        let length = (text as NSString).length
        guard !runs.isEmpty else { throw NativeRichTextError.invalidStyle }
        self.text = text
        self.runs = try runs.map { value in
            guard let italic = value["italic"] as? Bool, let monospace = value["monospace"] as? Bool else { throw NativeRichTextError.invalidStyle }
            let weight = try Self.number(value["weight"], positive: true)
            guard weight <= 1000 else { throw NativeRichTextError.invalidStyle }
            return Run(range: try Self.range(value, length: length), size: try Self.number(value["fontSize"], positive: true), weight: weight,
                       italic: italic, monospace: monospace, underline: value["underline"] as? Bool == true,
                       color: try Self.color(value["color"]), background: try value["background"].map { try Self.color($0) })
        }
        self.paragraphs = try paragraphs.map { value in
            Paragraph(range: try Self.range(value, length: length), height: try Self.number(value["lineHeight"], positive: true),
                      before: try Self.number(value["before"]), after: try Self.number(value["after"]),
                      indent: try Self.number(value["indent"]), first: try Self.number(value["firstLineIndent"]), marker: value["marker"] != nil)
        }
        self.blocks = try blocks.map { value in
            Block(range: try Self.range(value, length: length), color: try Self.color(value["background"]),
                  left: try Self.number(value["insetLeft"]), right: try Self.number(value["insetRight"]),
                  top: try Self.number(value["paddingTop"]), bottom: try Self.number(value["paddingBottom"]), radius: try Self.number(value["radius"]))
        }
    }

    private func fontWeight(_ value: CGFloat) -> UIFont.Weight {
        let weights: [(CGFloat, UIFont.Weight)] = [(100, .ultraLight), (200, .thin), (300, .light), (400, .regular), (500, .medium), (600, .semibold), (700, .bold), (800, .heavy), (900, .black)]
        if value <= 100 { return .ultraLight }
        for index in 1..<weights.count where value <= weights[index].0 {
            let lower = weights[index - 1], upper = weights[index]
            let fraction = (value - lower.0) / (upper.0 - lower.0)
            return UIFont.Weight(rawValue: lower.1.rawValue + fraction * (upper.1.rawValue - lower.1.rawValue))
        }
        return .black
    }

    func attributed(appearance: [String: Any], scale: CGFloat) throws -> NSAttributedString {
        let size = try Self.number(appearance["fontSize"], positive: true)
        guard let color = appearance["color"] as? String, color.count == 7, color.first == "#",
              let rgb = UInt32(color.dropFirst(), radix: 16) else { throw NativeRichTextError.invalidStyle }
        let base = UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
        let result = NSMutableAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: size * scale), .foregroundColor: base])
        for run in runs {
            var font = run.monospace ? UIFont.monospacedSystemFont(ofSize: run.size * scale, weight: fontWeight(run.weight))
                                    : UIFont.systemFont(ofSize: run.size * scale, weight: fontWeight(run.weight))
            if run.italic {
                guard let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) else { throw NativeRichTextError.invalidStyle }
                font = UIFont(descriptor: descriptor, size: font.pointSize)
            }
            result.addAttributes([.font: font, .foregroundColor: run.color], range: run.range)
            if run.underline { result.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: run.range) }
            if let background = run.background { result.addAttribute(.backgroundColor, value: background, range: run.range) }
        }
        for paragraph in paragraphs {
            let string = text as NSString
            let entire = string.paragraphRange(for: paragraph.range)
            var at = entire.location
            while at < NSMaxRange(entire) {
                let line = string.paragraphRange(for: NSRange(location: at, length: 0))
                let style = NSMutableParagraphStyle()
                style.minimumLineHeight = paragraph.height * scale
                style.maximumLineHeight = style.minimumLineHeight
                style.paragraphSpacingBefore = at == entire.location ? paragraph.before * scale : 0
                style.paragraphSpacing = NSMaxRange(line) == NSMaxRange(entire) ? paragraph.after * scale : 0
                style.headIndent = paragraph.indent * scale
                style.firstLineHeadIndent = (at == entire.location ? paragraph.first : paragraph.indent) * scale
                if paragraph.marker { style.tabStops = [NSTextTab(textAlignment: .left, location: paragraph.indent * scale)] }
                result.addAttribute(.paragraphStyle, value: style, range: line)
                at = NSMaxRange(line)
            }
        }
        return result
    }
}

/** Rounded code block decoration is drawn below UIKit's own selection backgrounds and glyphs. */
final class NativeRichLayoutManager: NSLayoutManager {
    var blocks: [NativeRichText.Block] = []
    var scale: CGFloat = 1

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        if let container = textContainers.first {
            for block in blocks {
                let glyphs = glyphRange(forCharacterRange: block.range, actualCharacterRange: nil)
                if NSIntersectionRange(glyphs, glyphsToShow).length == 0 { continue }
                var bounds = CGRect.null
                enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, _, _ in bounds = bounds.union(rect) }
                if bounds.isNull { continue }
                let rect = CGRect(x: origin.x + block.left * scale, y: origin.y + bounds.minY - block.top * scale,
                                  width: max(0, container.size.width - (block.left + block.right) * scale), height: bounds.height + (block.top + block.bottom) * scale)
                block.color.setFill()
                UIBezierPath(roundedRect: rect, cornerRadius: block.radius * scale).fill()
            }
        }
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    }
}
