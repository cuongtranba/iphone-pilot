// mirror-helper: capture, OCR and input for the macOS "iPhone Mirroring" window.
//
// Every subcommand prints ONE JSON object to stdout and exits 0, even when it refuses;
// a non-zero exit means a crash or a usage error.
//
// SAFETY INVARIANT: no input event (click, drag, scroll, type, key, menu) is posted
// unless iPhone Mirroring is frontmost AND the topmost on-screen window at the target
// point is the mirror window. Otherwise nothing is sent and the result is
// {ok:false, outcome:"not_sent", error:{code, message, user_action}}. The previously
// frontmost app is restored after every action (and after every refusal that
// activated the mirror).

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import Vision

// MARK: - JSON output

typealias JSON = [String: Any]

func emit(_ obj: JSON) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func usage(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("mirror-helper: \(msg)\n".utf8))
    exit(64)
}

func round1(_ v: Double) -> Double { (v * 10).rounded() / 10 }

func rectJSON(_ r: CGRect) -> JSON {
    ["x": round1(Double(r.minX)), "y": round1(Double(r.minY)), "w": round1(Double(r.width)), "h": round1(Double(r.height))]
}

func pump(_ seconds: TimeInterval) { RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds)) }

// MARK: - Window discovery

let mirrorOwner = "iPhone Mirroring"

struct MirrorWindow {
    var id: CGWindowID
    var pid: pid_t
    var bounds: CGRect
    var onScreen: Bool
}

func windowInfos(_ options: CGWindowListOption) -> [[String: Any]] {
    (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
}

func boundsOf(_ info: [String: Any]) -> CGRect {
    guard let d = info[kCGWindowBounds as String] as? NSDictionary,
          let r = CGRect(dictionaryRepresentation: d) else { return .zero }
    return r
}

/// The phone window: layer 0 and titled like the app (it owns several other windows, e.g. "Welcome to …").
func findMirrorWindow() -> MirrorWindow? {
    guard let app = mirrorApp() else { return nil }
    let title = app.localizedName ?? mirrorOwner
    for info in windowInfos([.optionAll]) {
        guard (info[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier),
              (info[kCGWindowLayer as String] as? Int) == 0,
              info[kCGWindowName as String] as? String == title,
              let id = info[kCGWindowNumber as String] as? Int else { continue }
        let on = (info[kCGWindowIsOnscreen as String] as? Bool) ?? false
        return MirrorWindow(id: CGWindowID(id), pid: app.processIdentifier, bounds: boundsOf(info), onScreen: on)
    }
    return nil
}

func mirrorApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.ScreenContinuity").first
        ?? NSWorkspace.shared.runningApplications.first { $0.localizedName == mirrorOwner }
}

/// Whether the window shows the phone. While it streams, its accessibility content is an empty
/// hosting view; when the session ended ("iPhone in Use", "iPhone is locked" …) it holds the app's
/// own texts and a Connect button, and a click there would press that button, not the phone.
/// Only texts decide: the hover toolbar adds buttons over a live stream.
func mirrorStreaming(pid: pid_t) -> (streaming: Bool, message: String) {
    let app = AXUIElementCreateApplication(pid)
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success,
          let wins = ref as? [AXUIElement] else { return (true, "") }
    let title = mirrorApp()?.localizedName ?? mirrorOwner
    var texts: [String] = []
    var buttons: [String] = []
    func walk(_ el: AXUIElement, _ depth: Int) {
        guard depth < 8 else { return }
        for child in axChildren(el) {
            let role = axString(child, kAXRoleAttribute)
            if role == kAXStaticTextRole as String {
                let t = axString(child, kAXValueAttribute).replacingOccurrences(of: "\n", with: " ")
                if !t.trimmingCharacters(in: .whitespaces).isEmpty { texts.append(t) }
            } else if role == kAXButtonRole as String {
                let name = axString(child, kAXDescriptionAttribute)
                if !name.isEmpty { buttons.append("[\(name)]") }
            }
            walk(child, depth + 1)
        }
    }
    for w in wins where axString(w, kAXTitleAttribute) == title { walk(w, 0) }
    return (texts.isEmpty, (texts + buttons).joined(separator: " "))
}

func isMinimized(pid: pid_t) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success,
          let wins = ref as? [AXUIElement] else { return false }
    for w in wins {
        var title: CFTypeRef?
        AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &title)
        guard (title as? String) == mirrorOwner else { continue }
        var m: CFTypeRef?
        if AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &m) == .success, let b = m as? Bool { return b }
    }
    return false
}

func frontmostPid() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

/// Topmost on-screen window containing `p`. Windows with alpha 0 are skipped; every other
/// window, at any layer, counts (front-to-back order from the window server).
func topmostWindowID(at p: CGPoint) -> CGWindowID? {
    for info in windowInfos([.optionOnScreenOnly, .excludeDesktopElements]) {
        let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1
        if alpha <= 0 { continue }
        let b = boundsOf(info)
        if b.width <= 0 || b.height <= 0 || !b.contains(p) { continue }
        return CGWindowID((info[kCGWindowNumber as String] as? Int) ?? 0)
    }
    return nil
}

// MARK: - Images, content rect, OCR

struct LoadedImage {
    var cg: CGImage
    var scale: Double // pixels per point (from the PNG's DPI, 72 dpi = 1x)
}

func loadImage(_ path: String) -> LoadedImage? {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let src = CGImageSourceCreateWithURL(url, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    var scale = 1.0
    if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
       let dpi = props[kCGImagePropertyDPIWidth] as? Double, dpi > 0 {
        scale = dpi / 72.0
    }
    return LoadedImage(cg: cg, scale: scale)
}

func rgba(_ img: CGImage) -> (data: [UInt8], w: Int, h: Int)? {
    let w = img.width, h = img.height
    var data = [UInt8](repeating: 0, count: w * h * 4)
    let ok = data.withUnsafeMutableBytes { buf -> Bool in
        guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    return ok ? (data, w, h) : nil
}

/// Bounding box (in pixels, top-left origin) of the opaque pixels. Fully opaque image: all of it.
func contentPixelRect(_ img: CGImage) -> CGRect {
    let whole = CGRect(x: 0, y: 0, width: img.width, height: img.height)
    guard let (data, w, h) = rgba(img) else { return whole }
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h {
        for x in 0..<w where data[(y * w + x) * 4 + 3] >= 128 {
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            if y > maxY { maxY = y }
        }
    }
    if maxX < 0 { return whole }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

func runProcess(_ path: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

func captureWindow(_ win: MirrorWindow, to path: String) -> Bool {
    try? FileManager.default.removeItem(atPath: path)
    return runProcess("/usr/sbin/screencapture", ["-l", String(win.id), "-o", "-x", path]) == 0
        && FileManager.default.fileExists(atPath: path)
}

/// Phone content rect in window points, derived from the alpha channel of a fresh capture.
func liveContentRect(_ win: MirrorWindow) -> (rect: CGRect, scale: Double)? {
    let tmp = NSTemporaryDirectory() + "mirror-helper-\(getpid())-\(win.id).png"
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    guard captureWindow(win, to: tmp), let img = loadImage(tmp) else { return nil }
    let scale = Double(img.cg.width) / Double(win.bounds.width)
    let px = contentPixelRect(img.cg)
    return (CGRect(x: px.minX / scale, y: px.minY / scale, width: px.width / scale, height: px.height / scale), scale)
}

func ocrLanguages(_ request: VNRecognizeTextRequest) -> [String] {
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    var out: [String] = []
    for prefix in ["en", "vi"] { out += supported.filter { $0.lowercased().hasPrefix(prefix) } }
    return out
}

/// Upscaling factor applied before Vision. Measured on Home Screen captures: 2x finds ~30% more
/// labels (29 -> 38 lines, Health/Wallet appear) for +50 ms; 3x adds nothing over 2x.
let ocrUpscale = Int(ProcessInfo.processInfo.environment["MIRROR_HELPER_UPSCALE"] ?? "") ?? 2

func upscaled(_ img: CGImage, factor: Int) -> CGImage {
    if factor <= 1 { return img }
    let w = img.width * factor, h = img.height * factor
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return img }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? img
}

/// Square-ish shapes the size of an app icon, as normalised Vision boxes (bottom-left origin).
func detectIcons(_ img: CGImage) -> [CGRect] {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 0
    request.minimumAspectRatio = 0.75
    request.maximumAspectRatio = 1.0
    request.quadratureTolerance = 20
    request.minimumConfidence = 0.3
    request.minimumSize = 0.08
    do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([request]) } catch { return [] }
    return (request.results ?? []).map(\.boundingBox)
}

/// The icon a label names: on the Home Screen (and in folders, App Library) the label sits just
/// under its icon and only the icon takes the tap. Matches an icon-sized square that ends at most
/// 16 pt above the label and is centred on it; the nearest one wins.
func iconAbove(_ label: CGRect, _ icons: [CGRect]) -> CGRect? {
    icons
        .filter { icon in
            let side = max(icon.width, icon.height)
            let gap = label.minY - icon.maxY
            return side >= 30 && side <= 90 && gap >= -2 && gap <= 16
                && abs(icon.midX - label.midX) <= max(8, side * 0.2) && label.width <= side * 1.8
        }
        .min { (label.minY - $0.maxY) < (label.minY - $1.maxY) }
}

func runOCR(path: String) -> JSON {
    let started = Date()
    guard let loaded = loadImage(path) else { return ["ok": false, "error": ["code": "bad_image", "message": "cannot read image \(path)"]] }
    let px = contentPixelRect(loaded.cg)
    guard let cropped = loaded.cg.cropping(to: px) else { return ["ok": false, "error": ["code": "bad_image", "message": "cannot crop image"]] }
    let widthPts = Double(px.width) / loaded.scale
    let heightPts = Double(px.height) / loaded.scale

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let langs = ocrLanguages(request)
    if !langs.isEmpty { request.recognitionLanguages = langs }
    let handler = VNImageRequestHandler(cgImage: upscaled(cropped, factor: ocrUpscale), options: [:])
    do { try handler.perform([request]) } catch {
        return ["ok": false, "error": ["code": "ocr_failed", "message": "\(error)"]]
    }
    let toPts = { (bb: CGRect) in
        CGRect(x: bb.minX * widthPts, y: (1 - bb.maxY) * heightPts, width: bb.width * widthPts, height: bb.height * heightPts)
    }
    let icons = detectIcons(cropped).map(toPts)
    var lines: [JSON] = []
    for obs in request.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let frame = toPts(obs.boundingBox) // Vision boxes are normalised with a bottom-left origin
        var line: JSON = ["text": cand.string, "confidence": (Double(cand.confidence) * 100).rounded() / 100, "frame": rectJSON(frame)]
        if let icon = iconAbove(frame, icons) { line["icon"] = rectJSON(icon) }
        lines.append(line)
    }
    return [
        "lines": lines,
        "screen": ["w": round1(widthPts), "h": round1(heightPts)],
        "languages": langs,
        "ms": Int(Date().timeIntervalSince(started) * 1000),
    ]
}

// MARK: - Safety invariant

struct Refusal: Error {
    var code: String
    var message: String
    var userAction: String
}

func refusalJSON(_ r: Refusal, restored: String?) -> JSON {
    var out: JSON = [
        "ok": false, "outcome": "not_sent",
        "error": ["code": r.code, "message": r.message, "user_action": r.userAction],
    ]
    if let restored { out["restored_front_app"] = restored }
    return out
}

func activate(_ app: NSRunningApplication) {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    app.unhide()
    app.activate(options: [])
}

func openViaLaunchServices(_ app: NSRunningApplication) {
    guard let url = app.bundleURL else { return }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: cfg, completionHandler: nil)
}

/// Brings `app` to the front, polling until it is frontmost (max ~1 s). Falls back to LaunchServices.
@discardableResult
func bringToFront(_ app: NSRunningApplication, timeout: TimeInterval = 1.0) -> Bool {
    let deadline = Date(timeIntervalSinceNow: timeout)
    var fallbackTried = false
    activate(app)
    while Date() < deadline {
        pump(0.02)
        if frontmostPid() == app.processIdentifier { return true }
        if !fallbackTried && deadline.timeIntervalSinceNow < timeout * 0.6 {
            fallbackTried = true
            openViaLaunchServices(app)
        }
    }
    return frontmostPid() == app.processIdentifier
}

func mirrorIsOn(top point: CGPoint, win: MirrorWindow) -> Bool {
    frontmostPid() == win.pid && topmostWindowID(at: point) == win.id
}

/// Classifies why the mirror cannot take input right now.
func refusalFor(point: CGPoint, win: MirrorWindow) -> Refusal {
    if findMirrorWindow()?.onScreen != true {
        return Refusal(code: "mirror_hidden", message: "the iPhone Mirroring window is not on screen",
                       userAction: "show the iPhone Mirroring window (click its Dock icon or unhide the app)")
    }
    if frontmostPid() != win.pid {
        return Refusal(code: "mirror_not_front", message: "iPhone Mirroring could not be brought to the front",
                       userAction: "click the iPhone Mirroring window once, then retry")
    }
    return Refusal(code: "mirror_covered", message: "another window covers the iPhone Mirroring window at the target point",
                   userAction: "move or close the window covering iPhone Mirroring, then retry")
}

func disconnected(_ message: String) -> Refusal {
    Refusal(code: "mirror_disconnected",
            message: "iPhone Mirroring is not showing the phone" + (message.isEmpty ? "" : " (it says: \(message))"),
            userAction: "lock the iPhone, then click Connect in the iPhone Mirroring window")
}

/// Runs `body` only once the invariant holds. `target` maps the live content rect to the global
/// point that must be topmost-owned by the mirror (nil = window centre). Restores the previous app.
func withMirror(target: ((CGRect, CGRect) -> CGPoint)? = nil, _ body: (_ win: MirrorWindow, _ content: CGRect) throws -> Void) -> JSON {
    guard var win = findMirrorWindow() else {
        if mirrorApp() == nil {
            return refusalJSON(Refusal(code: "mirror_not_running", message: "iPhone Mirroring is not running",
                                       userAction: "open the iPhone Mirroring app and connect your iPhone"), restored: nil)
        }
        return refusalJSON(Refusal(code: "mirror_hidden", message: "iPhone Mirroring has no phone window",
                                   userAction: "open the iPhone Mirroring app and connect your iPhone"), restored: nil)
    }
    guard let app = NSRunningApplication(processIdentifier: win.pid) else {
        return refusalJSON(Refusal(code: "mirror_not_running", message: "iPhone Mirroring is not running",
                                   userAction: "open the iPhone Mirroring app and connect your iPhone"), restored: nil)
    }
    if isMinimized(pid: win.pid) {
        return refusalJSON(Refusal(code: "mirror_hidden", message: "the iPhone Mirroring window is minimized",
                                   userAction: "un-minimize the iPhone Mirroring window"), restored: nil)
    }
    let status = mirrorStreaming(pid: win.pid)
    if !status.streaming {
        return refusalJSON(disconnected(status.message), restored: nil)
    }

    let previous = NSWorkspace.shared.frontmostApplication
    let cursor = CGEvent(source: nil)?.location
    var restoredName: String?
    func restore() {
        guard let previous, previous.processIdentifier != app.processIdentifier, !previous.isTerminated else { return }
        pump(0.12) // let queued events reach the mirror before focus moves away
        bringToFront(previous)
        restoredName = previous.localizedName
        if let cursor { CGWarpMouseCursorPosition(cursor) }
    }

    // 1. Bring the mirror forward and wait until it is front and on screen at its centre.
    var centre = CGPoint(x: win.bounds.midX, y: win.bounds.midY)
    var ok = false
    let deadline = Date(timeIntervalSinceNow: 1.0)
    if frontmostPid() != win.pid || !win.onScreen { bringToFront(app, timeout: 1.0) }
    repeat {
        if let w = findMirrorWindow() {
            win = w
            centre = CGPoint(x: w.bounds.midX, y: w.bounds.midY)
            if w.onScreen && mirrorIsOn(top: centre, win: w) { ok = true; break }
        }
        pump(0.025)
    } while Date() < deadline
    if !ok {
        let r = refusalFor(point: centre, win: win)
        restore()
        return refusalJSON(r, restored: restoredName)
    }

    // 2. Resolve the target point from the live content rect, and verify it too.
    guard let (content, _) = liveContentRect(win) else {
        restore()
        return refusalJSON(Refusal(code: "capture_failed", message: "could not capture the mirror window to locate the phone screen",
                                   userAction: "grant Screen Recording permission to the host app"), restored: restoredName)
    }
    let point = target?(win.bounds, content) ?? centre
    var pointOK = mirrorIsOn(top: point, win: win)
    let pointDeadline = Date(timeIntervalSinceNow: 0.5)
    while !pointOK && Date() < pointDeadline { pump(0.025); pointOK = mirrorIsOn(top: point, win: win) }
    if !pointOK {
        let r = refusalFor(point: point, win: win)
        restore()
        return refusalJSON(r, restored: restoredName)
    }

    // 3. Send.
    var result: JSON
    do {
        try body(win, content)
        result = ["ok": true, "outcome": "done"]
    } catch let r as Refusal {
        // Raised mid-way (focus lost while sending): part of the input may have gone out.
        result = ["ok": false, "outcome": "unknown", "error": ["code": r.code, "message": r.message, "user_action": r.userAction]]
    } catch {
        result = ["ok": false, "outcome": "unknown", "error": ["code": "input_failed", "message": "\(error)"]]
    }
    restore()
    if let restoredName { result["restored_front_app"] = restoredName }
    return result
}

/// Mid-action re-check used by multi-event actions.
func stillFront(_ win: MirrorWindow, at p: CGPoint) throws {
    if !mirrorIsOn(top: p, win: win) {
        throw Refusal(code: "mirror_not_front", message: "iPhone Mirroring lost focus while sending input",
                      userAction: "do not touch the keyboard or mouse while iphone-pilot is sending input; check the phone state before retrying")
    }
}

// MARK: - Input events

func toGlobal(_ win: MirrorWindow, _ content: CGRect, _ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: win.bounds.minX + content.minX + CGFloat(x), y: win.bounds.minY + content.minY + CGFloat(y))
}


func mouse(_ type: CGEventType, _ p: CGPoint, delta: CGPoint = .zero) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    if type == .leftMouseDown || type == .leftMouseUp { e?.setIntegerValueField(.mouseEventClickState, value: 1) }
    if type == .leftMouseDragged {
        e?.setIntegerValueField(.mouseEventDeltaX, value: Int64(delta.x))
        e?.setIntegerValueField(.mouseEventDeltaY, value: Int64(delta.y))
        e?.setDoubleValueField(.mouseEventPressure, value: 1)
    }
    e?.post(tap: .cghidEventTap)
}

/// The mirror drops a click that arrives right after the pointer enters it: measured live, a back
/// button ignored clicks 30 ms after the move and took them 100 and 300 ms after it.
let hoverSettle: useconds_t = 200_000

/// Puts the pointer on `p` the way the mirror notices it: a warp plus a source-less move event
/// (a move from the HID-state source alone left later clicks ignored, measured live).
func hover(_ p: CGPoint) {
    CGWarpMouseCursorPosition(p)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(hoverSettle)
}

func doClick(_ p: CGPoint) {
    hover(p)
    for (type, state) in [(CGEventType.leftMouseDown, 1), (CGEventType.leftMouseUp, 1)] {
        let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        e?.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}

func doDrag(_ a: CGPoint, _ b: CGPoint, ms: Int) {
    hover(a)
    mouse(.leftMouseDown, a)
    usleep(60_000)
    let steps = max(8, ms / 16)
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let next = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        mouse(.leftMouseDragged, next, delta: CGPoint(x: (b.x - a.x) / CGFloat(steps), y: (b.y - a.y) / CGFloat(steps)))
        usleep(UInt32(max(1, ms / steps)) * 1000)
    }
    // Stay down at the end so the phone sees a stop, not a fling.
    for _ in 0..<5 { mouse(.leftMouseDragged, b); usleep(30_000) }
    mouse(.leftMouseUp, b)
}

func doScroll(vertical: Int32, horizontal: Int32) {
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "escape": 53, "tab": 48, "delete": 51, "space": 49,
    "up": 126, "down": 125, "left": 123, "right": 124,
]


func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
    // A modifier is a real key event of its own: the mirror forwards modifiers to the phone only
    // when it sees them go down before the key and up after it.
    var mods: [(CGKeyCode, CGEventFlags)] = []
    if flags.contains(.maskShift) { mods.append((56, .maskShift)) }
    if flags.contains(.maskCommand) { mods.append((55, .maskCommand)) }
    var held: CGEventFlags = []
    for (k, f) in mods {
        held.insert(f)
        let e = CGEvent(keyboardEventSource: nil, virtualKey: k, keyDown: true)
        e?.flags = held
        e?.post(tap: .cghidEventTap)
        usleep(8_000)
    }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
        e?.flags = held
        e?.post(tap: .cghidEventTap)
        usleep(8_000)
    }
    for (k, _) in mods.reversed() {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: k, keyDown: false)
        held = []
        e?.flags = held
        e?.post(tap: .cghidEventTap)
        usleep(8_000)
    }
}

/// All text goes through the pasteboard + Cmd+V. Key events are not used for text: the phone
/// reads them through its own hardware-keyboard layout, so on a Vietnamese Telex layout "wifi"
/// arrives as "ưifi" (seen live).
let envMs = { (name: String, def: Double) in (Double(ProcessInfo.processInfo.environment[name] ?? "") ?? def) / 1000 }
/// Wait after Cmd+V before giving focus back: the phone fetches the text just after the key.
let pasteAfter = envMs("MIRROR_HELPER_PASTE_MS", 500)
/// Wait between the mirror coming to the front and Cmd+V, for the new pasteboard to reach the phone.
let pasteBefore = envMs("MIRROR_HELPER_PASTE_BEFORE_MS", 600)

// The user's pasteboard is put back, but late. Restoring right after the paste made the next
// paste insert the restored contents (Universal Clipboard lagged behind the quick changes; 5/5
// pastes were right without the restore, most were wrong with it). So a detached
// `restore-pasteboard` puts it back after `restoreDelay`, unless a newer paste took over (it then
// inherits the saved contents) or the user copied something else meanwhile (then nothing is restored).
let restoreDelay = envMs("MIRROR_HELPER_RESTORE_MS", 8000)
let pendingRestorePath: String = {
    let dir = (ProcessInfo.processInfo.environment["IPHONE_PILOT_STATE_DIR"]
        ?? (NSHomeDirectory() + "/Library/Caches/iphone-pilot"))
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir + "/pasteboard-restore.plist"
}()

/// Serialised pasteboard items: one [type: data] dictionary per item.
typealias SavedItems = [[String: Data]]

func currentItems() -> SavedItems {
    (NSPasteboard.general.pasteboardItems ?? []).map { item in
        var d: [String: Data] = [:]
        for t in item.types { if let v = item.data(forType: t) { d[t.rawValue] = v } }
        return d
    }
}

func readPending() -> (token: String, changeCount: Int, items: SavedItems)? {
    guard let data = FileManager.default.contents(atPath: pendingRestorePath),
          let p = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let token = p["token"] as? String, let cc = p["changeCount"] as? Int, let items = p["items"] as? SavedItems
    else { return nil }
    return (token, cc, items)
}

func writePending(token: String, changeCount: Int, items: SavedItems) {
    let p: [String: Any] = ["token": token, "changeCount": changeCount, "items": items]
    if let data = try? PropertyListSerialization.data(fromPropertyList: p, format: .binary, options: 0) {
        FileManager.default.createFile(atPath: pendingRestorePath, contents: data, attributes: [.posixPermissions: 0o600])
    }
}

/// Puts `text` on the pasteboard, remembering what to restore (inherited from a pending restore).
func lendPasteboard(_ text: String) -> String {
    let pb = NSPasteboard.general
    // A pending restore whose text is still on the pasteboard holds the user's real contents.
    let pending = readPending()
    let saved = (pending != nil && pending!.changeCount == pb.changeCount) ? pending!.items : currentItems()
    pb.clearContents()
    pb.setString(text, forType: .string)
    let token = UUID().uuidString
    writePending(token: token, changeCount: pb.changeCount, items: saved)
    return token
}

/// Starts the detached restorer; its output is detached so the caller does not wait for it.
func scheduleRestore(_ token: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    p.arguments = ["restore-pasteboard", token]
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
}

func restorePasteboard(token: String) {
    pump(restoreDelay)
    guard let pending = readPending(), pending.token == token else { return } // a newer paste owns it
    try? FileManager.default.removeItem(atPath: pendingRestorePath)
    let pb = NSPasteboard.general
    guard pb.changeCount == pending.changeCount else { return } // the user copied something since
    pb.clearContents()
    let items = pending.items.map { d -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (t, v) in d { item.setData(v, forType: NSPasteboard.PasteboardType(t)) }
        return item
    }
    if !items.isEmpty { pb.writeObjects(items) }
}

func paste(win: MirrorWindow, centre: CGPoint) throws {
    pump(pasteBefore)
    try stillFront(win, at: centre)
    postKey(9, flags: .maskCommand) // v
    pump(pasteAfter)
}

// MARK: - Menu (AX)

struct MenuEntry {
    var element: AXUIElement
    var title: String
    var identifier: String
    var path: String
    var bar: Int   // index of the top-level menu bar item
    var depth: Int // 1 = direct item of a top-level menu
}

func axString(_ el: AXUIElement, _ attr: String) -> String {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    return (v as? String) ?? ""
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v)
    return (v as? [AXUIElement]) ?? []
}

func collectMenu(pid: pid_t) -> [MenuEntry] {
    let app = AXUIElementCreateApplication(pid)
    var bar: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &bar) == .success, let barEl = bar else { return [] }
    var out: [MenuEntry] = []
    func walk(_ el: AXUIElement, _ path: String, bar: Int?, depth: Int) {
        for (i, child) in axChildren(el).enumerated() {
            let role = axString(child, kAXRoleAttribute)
            let title = axString(child, kAXTitleAttribute)
            if role == kAXMenuItemRole as String || role == kAXMenuBarItemRole as String {
                let b = bar ?? i
                out.append(MenuEntry(element: child, title: title, identifier: axString(child, "AXIdentifier"),
                                     path: path.isEmpty ? title : path + " > " + title, bar: b, depth: depth))
                walk(child, path.isEmpty ? title : path + " > " + title, bar: b, depth: depth + 1)
            } else {
                walk(child, path, bar: bar, depth: depth)
            }
        }
    }
    walk(barEl as! AXUIElement, "", bar: nil, depth: 0)
    return out
}

let menuTargets: [String: (idHint: String, titles: [String], position: Int)] = [
    "home": ("home", ["Home Screen"], 0),
    "switcher": ("switcher", ["App Switcher"], 1),
    "spotlight": ("spotlight", ["Spotlight"], 2),
]

/// Identifier match first, then title. On this macOS every View item shares the identifier
/// "menuAction:", so for other languages the last resort is position: the first three titled
/// items of the View menu (4th menu bar item: Apple, app, Edit, View).

func findMenuEntry(_ entries: [MenuEntry], _ name: String) -> MenuEntry? {
    guard let t = menuTargets[name] else { return nil }
    if let hit = entries.first(where: { !$0.identifier.isEmpty && $0.identifier.lowercased().contains(t.idHint) }) { return hit }
    if let hit = entries.first(where: { t.titles.contains($0.title) }) { return hit }
    let view = entries.filter { $0.bar == 3 && $0.depth == 1 && !$0.title.isEmpty }
    return t.position < view.count ? view[t.position] : nil
}

// MARK: - Commands

func number(_ s: String, _ what: String) -> Double {
    guard let v = Double(s) else { usage("\(what) must be a number, got \(s)") }
    return v
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { usage("usage: mirror-helper window|capture|ocr|menu|click|drag|scroll|type|key|perms") }
let rest = Array(args.dropFirst())

switch cmd {
case "perms":
    emit(["accessibility": AXIsProcessTrusted(), "screen_recording": CGPreflightScreenCaptureAccess()])

case "window":
    guard let w = findMirrorWindow() else { emit(["found": false, "running": mirrorApp() != nil]) }
    let status = mirrorStreaming(pid: w.pid)
    emit(["found": true, "id": Int(w.id), "bounds": rectJSON(w.bounds), "on_screen": w.onScreen, "pid": Int(w.pid),
          "frontmost": frontmostPid() == w.pid, "minimized": isMinimized(pid: w.pid),
          "streaming": status.streaming, "message": status.message])

case "capture":
    guard rest.count == 1 else { usage("capture <png>") }
    guard let w = findMirrorWindow() else { emit(["ok": false, "error": ["code": "mirror_not_running", "message": "no iPhone Mirroring window", "user_action": "open the iPhone Mirroring app and connect your iPhone"]]) }
    guard captureWindow(w, to: rest[0]), let img = loadImage(rest[0]) else {
        emit(["ok": false, "error": ["code": "capture_failed", "message": "screencapture failed", "user_action": "grant Screen Recording permission to the host app and make sure the iPhone Mirroring window is not minimized"]])
    }
    let scale = Double(img.cg.width) / Double(w.bounds.width)
    let px = contentPixelRect(img.cg)
    let content = CGRect(x: px.minX / scale, y: px.minY / scale, width: px.width / scale, height: px.height / scale)
    let status = mirrorStreaming(pid: w.pid)
    emit(["ok": true, "path": rest[0], "window": ["id": Int(w.id), "bounds": rectJSON(w.bounds)], "content": rectJSON(content), "scale": scale,
          "streaming": status.streaming, "message": status.message])

case "ocr":
    guard rest.count == 1 else { usage("ocr <png>") }
    emit(runOCR(path: rest[0]))

case "menu":
    guard rest.count == 1 else { usage("menu home|switcher|spotlight|--list") }
    guard let app = mirrorApp() else {
        emit(refusalJSON(Refusal(code: "mirror_not_running", message: "iPhone Mirroring is not running", userAction: "open the iPhone Mirroring app and connect your iPhone"), restored: nil))
    }
    if rest[0] == "--list" {
        let items = collectMenu(pid: app.processIdentifier).map { ["path": $0.path, "title": $0.title, "identifier": $0.identifier] }
        emit(["ok": true, "items": items])
    }
    guard menuTargets[rest[0]] != nil else { usage("menu home|switcher|spotlight|--list") }
    let name = rest[0]
    // Resolve before touching focus: a missing item sends nothing and changes nothing.
    guard let entry = findMenuEntry(collectMenu(pid: app.processIdentifier), name) else {
        emit(refusalJSON(Refusal(code: "menu_item_missing", message: "no \(name) item found in the iPhone Mirroring menus",
                                 userAction: "run: mirror-helper menu --list and report the identifiers"), restored: nil))
    }
    emit(withMirror { _, _ in
        if AXUIElementPerformAction(entry.element, kAXPressAction as CFString) != .success {
            throw Refusal(code: "menu_press_failed", message: "pressing \(entry.path) failed", userAction: "retry; check the phone state first")
        }
    })

case "click":
    guard rest.count == 2 else { usage("click x y") }
    let (x, y) = (number(rest[0], "x"), number(rest[1], "y"))
    emit(withMirror(target: { b, c in
        CGPoint(x: b.minX + c.minX + CGFloat(x), y: b.minY + c.minY + CGFloat(y))
    }) { win, content in
        doClick(toGlobal(win, content, x, y))
    })

case "drag":
    // Verified live: iPhone Mirroring ignores synthetic mouse drags (scroll wheel events do move
    // content), so iphone-pilot does not use this for swipes. Kept for diagnostics.
    guard rest.count == 4 || rest.count == 5 else { usage("drag x1 y1 x2 y2 [ms]") }
    let v = rest.prefix(4).enumerated().map { number($0.element, "arg\($0.offset + 1)") }
    let ms = rest.count == 5 ? Int(number(rest[4], "ms")) : 300
    // Both ends must be on the mirror; the start is the verified target point.
    emit(withMirror(target: { b, c in CGPoint(x: b.minX + c.minX + CGFloat(v[0]), y: b.minY + c.minY + CGFloat(v[1])) }) { win, content in
        let a = toGlobal(win, content, v[0], v[1]), b = toGlobal(win, content, v[2], v[3])
        try stillFront(win, at: b)
        doDrag(a, b, ms: ms)
    })

case "scroll":
    guard rest.count == 1 || rest.count == 2, ["up", "down", "left", "right"].contains(rest[0]) else { usage("scroll up|down|left|right [steps, default 3]") }
    let steps = rest.count == 2 ? Int(number(rest[1], "steps")) : 3
    emit(withMirror { win, content in
        // "down" shows what is further down: a negative wheel delta. The mirror moves the content
        // ~100 pt per wheel event whatever the delta, so a longer scroll is several events.
        let at = CGPoint(x: win.bounds.minX + content.midX, y: win.bounds.minY + content.midY)
        hover(at)
        for _ in 0..<max(1, steps) {
            // Direction names the content to reveal: "right" shows what lies further right.
            switch rest[0] {
            case "down": doScroll(vertical: -300, horizontal: 0)
            case "up": doScroll(vertical: 300, horizontal: 0)
            case "right": doScroll(vertical: 0, horizontal: -300)
            default: doScroll(vertical: 0, horizontal: 300)
            }
            usleep(120_000)
        }
    })

case "type":
    guard rest.count == 1 else { usage("type <text>") }
    let text = rest[0]
    // On the pasteboard before the mirror is raised, so it is there when the mirror takes focus.
    let token = lendPasteboard(text)
    let result = withMirror { win, _ in
        try paste(win: win, centre: CGPoint(x: win.bounds.midX, y: win.bounds.midY))
    }
    scheduleRestore(token)
    emit(result)

case "restore-pasteboard":
    guard rest.count == 1 else { usage("restore-pasteboard <token>") }
    restorePasteboard(token: rest[0])
    exit(0)

case "key":
    guard rest.count == 1, let code = keyCodes[rest[0]] else { usage("key return|escape|tab|delete|up|down|left|right|space") }
    emit(withMirror { _, _ in postKey(code) })

default:
    usage("unknown subcommand \(cmd)")
}
