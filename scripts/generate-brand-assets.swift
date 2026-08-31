import AppKit
import CoreGraphics
import Foundation

private let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

private func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
  CGColor(
    red: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: alpha
  )
}

private func makeContext(size: Int, opaque: Bool) -> CGContext {
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard let context = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: size * 4,
    space: colorSpace,
    bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast).rawValue
  ) else {
    fatalError("Could not create a bitmap context.")
  }
  context.interpolationQuality = .high
  return context
}

private func drawMark(
  in context: CGContext,
  size: CGFloat,
  ringOpacity: CGFloat,
  markScale: CGFloat = 1
) {
  let scale = size / 1024 * markScale
  let offset = (size - 1024 * scale) / 2
  func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: offset + x * scale, y: offset + y * scale)
  }

  context.saveGState()
  context.setStrokeColor(color(0xffffff, alpha: ringOpacity))
  context.setLineWidth(48 * scale)
  context.strokeEllipse(in: CGRect(
    x: offset + (512 - 284) * scale,
    y: offset + (1024 - 492 - 284) * scale,
    width: 568 * scale,
    height: 568 * scale
  ))

  context.setStrokeColor(color(0xffffff))
  context.setLineWidth(76 * scale)
  context.setLineCap(.round)
  context.setLineJoin(.round)

  let letter = CGMutablePath()
  letter.move(to: point(600, 1024 - 604))
  letter.addCurve(
    to: point(498, 1024 - 644),
    control1: point(574, 1024 - 630),
    control2: point(540, 1024 - 644)
  )
  letter.addCurve(
    to: point(328, 1024 - 464),
    control1: point(400, 1024 - 644),
    control2: point(328, 1024 - 570)
  )
  letter.addCurve(
    to: point(498, 1024 - 284),
    control1: point(328, 1024 - 358),
    control2: point(400, 1024 - 284)
  )
  letter.addCurve(
    to: point(668, 1024 - 464),
    control1: point(596, 1024 - 284),
    control2: point(668, 1024 - 358)
  )
  letter.addCurve(
    to: point(650, 1024 - 548),
    control1: point(668, 1024 - 496),
    control2: point(662, 1024 - 524)
  )
  context.addPath(letter)
  context.strokePath()

  context.move(to: point(636, 1024 - 664))
  context.addLine(to: point(752, 1024 - 780))
  context.strokePath()
  context.restoreGState()
}

private func writeImage(
  size: Int,
  destination: String,
  opaque: Bool = false,
  draw: (CGContext, CGFloat) -> Void
) {
  let context = makeContext(size: size, opaque: opaque)
  draw(context, CGFloat(size))
  guard let image = context.makeImage() else {
    fatalError("Could not create \(destination).")
  }
  let representation = NSBitmapImageRep(cgImage: image)
  guard let data = representation.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode \(destination).")
  }
  let url = root.appendingPathComponent(destination)
  try! FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  try! data.write(to: url, options: .atomic)
}

private func drawAppIcon(context: CGContext, size: CGFloat) {
  let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [color(0x7c86ff), color(0x3f4ccf)] as CFArray,
    locations: [0, 1]
  )!
  context.drawLinearGradient(
    gradient,
    start: CGPoint(x: size * 0.14, y: size * 0.92),
    end: CGPoint(x: size * 0.86, y: size * 0.08),
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
  )
  drawMark(in: context, size: size, ringOpacity: 0.2)
}

writeImage(size: 1024, destination: "assets/images/icon.png", opaque: true, draw: drawAppIcon)
writeImage(size: 48, destination: "assets/images/favicon.png", opaque: true, draw: drawAppIcon)
writeImage(size: 512, destination: "public/qashy-icon-512.png", opaque: true, draw: drawAppIcon)
writeImage(size: 512, destination: "assets/images/splash-icon.png") { context, size in
  drawMark(in: context, size: size, ringOpacity: 0.24, markScale: 0.78)
}
writeImage(size: 512, destination: "assets/images/android-icon-foreground.png") { context, size in
  drawMark(in: context, size: size, ringOpacity: 0.24, markScale: 0.72)
}
writeImage(size: 432, destination: "assets/images/android-icon-monochrome.png") { context, size in
  drawMark(in: context, size: size, ringOpacity: 1, markScale: 0.72)
}
