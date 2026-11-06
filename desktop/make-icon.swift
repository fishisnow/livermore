import AppKit

let directory = CommandLine.arguments[1]
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let rect = NSRect(x: 0, y: 0, width: pixels, height: pixels)
        let inset = CGFloat(pixels) * 0.05
        let background = NSBezierPath(roundedRect: rect.insetBy(dx: inset, dy: inset), xRadius: CGFloat(pixels) * 0.22, yRadius: CGFloat(pixels) * 0.22)
        NSColor(calibratedRed: 0.06, green: 0.23, blue: 0.21, alpha: 1).setFill()
        background.fill()
        let label = "L" as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: CGFloat(pixels) * 0.67, weight: .medium),
            .foregroundColor: NSColor(calibratedRed: 0.94, green: 0.94, blue: 0.87, alpha: 1)
        ]
        let dimensions = label.size(withAttributes: attributes)
        label.draw(at: NSPoint(x: (CGFloat(pixels) - dimensions.width) / 2 - CGFloat(pixels) * 0.03,
                               y: (CGFloat(pixels) - dimensions.height) / 2), withAttributes: attributes)
        NSColor(calibratedRed: 0.78, green: 0.64, blue: 0.39, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: CGFloat(pixels) * 0.65, y: CGFloat(pixels) * 0.24,
                                   width: CGFloat(pixels) * 0.09, height: CGFloat(pixels) * 0.09)).fill()
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let data = bitmap.representation(using: .png, properties: [:])!
        let suffix = scale == 2 ? "@2x" : ""
        try data.write(to: URL(fileURLWithPath: "\(directory)/icon_\(size)x\(size)\(suffix).png"))
    }
}
