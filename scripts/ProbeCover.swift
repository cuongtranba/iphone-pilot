// probe-cover x y w h seconds — shows an always-on-top panel over that screen rect (top-left
// origin, like CGWindow bounds) without taking focus. Used by the probe to cover the mirror.
import AppKit

let a = CommandLine.arguments.dropFirst().compactMap(Double.init)
guard a.count == 5 else { fputs("usage: probe-cover x y w h seconds\n", stderr); exit(64) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let mainHeight = NSScreen.screens.first?.frame.height ?? 0
let rect = NSRect(x: a[0], y: mainHeight - a[1] - a[3], width: a[2], height: a[3])
let panel = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.backgroundColor = NSColor.systemOrange.withAlphaComponent(0.6)
panel.isOpaque = false
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
panel.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + a[4]) { exit(0) }
app.run()
