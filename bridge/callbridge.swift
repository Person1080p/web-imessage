// callbridge: macOS helper that lets web-imessage pass phone/FaceTime calls through to a browser.
//
//   callbridge devices                          list audio devices as JSON
//   callbridge audio --capture NAME --play NAME [--rate 24000] [--state FILE]
//       Makes NAME(capture) the default output and NAME(play) the default input, so the call's audio
//       lands in a virtual device we can record and the browser's mic is what the call hears.
//       stdout: call audio, 16-bit mono PCM.  stdin: browser mic audio, same format.
//       Restores the previous default devices on exit (EOF, SIGTERM or SIGINT).
//   callbridge restore FILE                     restore defaults saved by a crashed `audio` run
//   callbridge watch                            watch the call UI via Accessibility; JSON lines out,
//                                               commands in (accept, decline, end, confirm, dump)
//   callbridge video [--fps 12]                 JPEG frames of the FaceTime window: [u32 BE length][jpeg]...
//   callbridge look X Y W H                     debug: the buttons and text found in a call banner at that rectangle

import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import ImageIO
import ScreenCaptureKit
import Vision

signal(SIGPIPE, SIG_IGN)

// MARK: - output

let outQueue = DispatchQueue(label: "stdout")

func writeAll(_ data: Data) {
    data.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
            let n = Darwin.write(1, raw.baseAddress! + off, raw.count - off)
            if n <= 0 { cleanupAndExit(0) }
            off += n
        }
    }
}

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
    outQueue.async { writeAll(d + Data([0x0A])) }
}

var cleanupHooks: [() -> Void] = []
func cleanupAndExit(_ code: Int32) {
    for h in cleanupHooks { h() }
    cleanupHooks = []
    exit(code)
}

var signalSources: [DispatchSourceSignal] = []
func handleSignals() {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler { cleanupAndExit(0) }
        src.resume()
        signalSources.append(src)
    }
}

func arg(_ name: String, _ def: String? = nil) -> String? {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return def
}

// MARK: - Core Audio devices

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func address(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func deviceIDs() -> [AudioDeviceID] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func stringProp(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
    var addr = address(sel)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return "" }
    return v.takeRetainedValue() as String
}

func channelCount(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func getDefault(_ sel: AudioObjectPropertySelector) -> AudioDeviceID {
    var addr = address(sel)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    _ = AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &id)
    return id
}

@discardableResult
func setDefault(_ sel: AudioObjectPropertySelector, _ id: AudioDeviceID) -> Bool {
    var addr = address(sel)
    var v = id
    return AudioObjectSetPropertyData(systemObject, &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v) == noErr
}

func findDevice(_ name: String, needInput: Bool = false, needOutput: Bool = false) -> AudioDeviceID? {
    let ids = deviceIDs().filter {
        (!needInput || channelCount($0, kAudioObjectPropertyScopeInput) > 0)
            && (!needOutput || channelCount($0, kAudioObjectPropertyScopeOutput) > 0)
    }
    if let exact = ids.first(where: { stringProp($0, kAudioObjectPropertyName) == name || stringProp($0, kAudioDevicePropertyDeviceUID) == name }) {
        return exact
    }
    return ids.first { stringProp($0, kAudioObjectPropertyName).lowercased().contains(name.lowercased()) }
}

func listDevices() {
    let defIn = getDefault(kAudioHardwarePropertyDefaultInputDevice)
    let defOut = getDefault(kAudioHardwarePropertyDefaultOutputDevice)
    let list: [[String: Any]] = deviceIDs().map { id in
        [
            "id": Int(id), "name": stringProp(id, kAudioObjectPropertyName), "uid": stringProp(id, kAudioDevicePropertyDeviceUID),
            "inputs": channelCount(id, kAudioObjectPropertyScopeInput), "outputs": channelCount(id, kAudioObjectPropertyScopeOutput),
            "defaultInput": id == defIn, "defaultOutput": id == defOut,
        ]
    }
    let d = try! JSONSerialization.data(withJSONObject: list)
    FileHandle.standardOutput.write(d)
}

let defaultSelectors: [String: AudioObjectPropertySelector] = [
    "output": kAudioHardwarePropertyDefaultOutputDevice,
    "input": kAudioHardwarePropertyDefaultInputDevice,
    "system": kAudioHardwarePropertyDefaultSystemOutputDevice,
]

func restoreDefaults(from path: String) {
    guard let data = FileManager.default.contents(atPath: path),
          let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return }
    for (key, uid) in saved {
        guard let sel = defaultSelectors[key], let id = findDevice(uid) else { continue }
        setDefault(sel, id)
    }
    try? FileManager.default.removeItem(atPath: path)
}

// MARK: - audio bridge

final class RingBuffer {
    private var buf: [Float]
    private var readPos = 0, writePos = 0, count = 0, primed = false
    private let lock = NSLock()
    private let capacity: Int, prime: Int

    init(capacity: Int, prime: Int) {
        self.capacity = capacity
        self.prime = prime
        buf = [Float](repeating: 0, count: capacity)
    }

    func push(_ samples: UnsafeBufferPointer<Int16>) {
        lock.lock()
        for s in samples {
            if count == capacity { readPos = (readPos + 1) % capacity; count -= 1 }  // drop oldest: keeps latency bounded
            buf[writePos] = Float(s) / 32768
            writePos = (writePos + 1) % capacity
            count += 1
        }
        lock.unlock()
    }

    func pull(into dst: UnsafeMutablePointer<Float>, frames: Int) {
        lock.lock()
        if !primed && count >= prime { primed = true }
        var i = 0
        if primed {
            while i < frames && count > 0 {
                dst[i] = buf[readPos]
                readPos = (readPos + 1) % capacity
                count -= 1
                i += 1
            }
            if count == 0 { primed = false }  // underrun: rebuild a small cushion before playing again
        }
        while i < frames { dst[i] = 0; i += 1 }
        lock.unlock()
    }
}

func setIODevice(_ unit: AudioUnit?, _ id: AudioDeviceID) -> Bool {
    guard let unit = unit else { return false }
    var dev = id
    return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                &dev, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
}

var keepAlive: [AnyObject] = []

func runAudio() {
    let capName = arg("--capture", "BlackHole 2ch")!
    let playName = arg("--play", "BlackHole 16ch")!
    let rate = Double(arg("--rate", "24000")!) ?? 24000
    let statePath = arg("--state")
    guard let cap = findDevice(capName, needInput: true, needOutput: true) else {
        FileHandle.standardError.write("callbridge: capture device '\(capName)' not found\n".data(using: .utf8)!)
        exit(2)
    }
    guard let play = findDevice(playName, needInput: true, needOutput: true) else {
        FileHandle.standardError.write("callbridge: mic device '\(playName)' not found\n".data(using: .utf8)!)
        exit(2)
    }

    // Remember the user's devices, then point the system (and so FaceTime) at the virtual ones.
    var saved: [String: String] = [:]
    for (key, sel) in defaultSelectors { saved[key] = stringProp(getDefault(sel), kAudioDevicePropertyDeviceUID) }
    if let p = statePath, let d = try? JSONSerialization.data(withJSONObject: saved) { try? d.write(to: URL(fileURLWithPath: p)) }
    setDefault(kAudioHardwarePropertyDefaultOutputDevice, cap)
    setDefault(kAudioHardwarePropertyDefaultSystemOutputDevice, cap)
    setDefault(kAudioHardwarePropertyDefaultInputDevice, play)
    cleanupHooks.append {
        for (key, uid) in saved {
            if let sel = defaultSelectors[key], let id = findDevice(uid) { setDefault(sel, id) }
        }
        if let p = statePath { try? FileManager.default.removeItem(atPath: p) }
    }
    handleSignals()

    // Call audio -> stdout. Separate engines because one AVAudioEngine can't use two devices on macOS.
    let capEngine = AVAudioEngine()
    let input = capEngine.inputNode
    if !setIODevice(input.audioUnit, cap) { FileHandle.standardError.write("callbridge: could not open capture device\n".data(using: .utf8)!) }
    let inFormat = input.inputFormat(forBus: 0)
    let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
    guard let converter = AVAudioConverter(from: inFormat, to: pcmFormat) else { cleanupAndExit(3); return }
    converter.downmix = true
    input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { buffer, _ in
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * rate / inFormat.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let data = Data(bytes: ch[0], count: Int(out.frameLength) * 2)
        outQueue.async { writeAll(data) }
    }

    // stdin -> browser mic -> the virtual device the call uses as its microphone.
    let ring = RingBuffer(capacity: Int(rate * 0.4), prime: Int(rate * 0.06))
    let playEngine = AVAudioEngine()
    if !setIODevice(playEngine.outputNode.audioUnit, play) { FileHandle.standardError.write("callbridge: could not open mic device\n".data(using: .utf8)!) }
    let floatFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
    let source = AVAudioSourceNode(format: floatFormat) { _, _, frameCount, abl -> OSStatus in
        for b in UnsafeMutableAudioBufferListPointer(abl) {
            if let p = b.mData?.assumingMemoryBound(to: Float.self) { ring.pull(into: p, frames: Int(frameCount)) }
        }
        return noErr
    }
    playEngine.attach(source)
    playEngine.connect(source, to: playEngine.mainMixerNode, format: floatFormat)

    do {
        try capEngine.start()
        try playEngine.start()
    } catch {
        FileHandle.standardError.write("callbridge: audio engine failed: \(error)\n".data(using: .utf8)!)
        cleanupAndExit(4)
    }
    keepAlive += [capEngine, playEngine, source, converter]
    cleanupHooks.insert({ capEngine.stop(); playEngine.stop() }, at: 0)

    Thread.detachNewThread {
        var leftover: UInt8? = nil
        let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: 8192)
        while true {
            let n = Darwin.read(0, chunk, 8192)
            if n <= 0 { DispatchQueue.main.async { cleanupAndExit(0) }; return }
            var bytes = Data(bytes: chunk, count: n)
            if let l = leftover { bytes.insert(l, at: 0); leftover = nil }
            if bytes.count % 2 == 1 { leftover = bytes.removeLast() }
            bytes.withUnsafeBytes { raw in
                ring.push(UnsafeBufferPointer(start: raw.bindMemory(to: Int16.self).baseAddress, count: raw.count / 2))
            }
        }
    }
    dispatchMain()
}

// MARK: - call UI watcher (Accessibility)

struct Hit {
    let element: AXUIElement
    let label: String
    let action: String
    let texts: [String]
    let app: String
    var point: CGPoint? = nil  // set for buttons that can only be clicked, not pressed through Accessibility
    var frame: CGRect? = nil   // set for call banners (action "banner")
}

// MARK: - call banners (macOS 26)
//
// Since macOS 26, call banners (incoming calls, the "Click to Call" prompt for tel: links, calls in progress) are
// drawn by FaceTimeNotificationViewBridgeService. Accessibility sees only an empty AXNotificationCenterBanner, so
// the watcher screenshots the banner, finds its green (call / accept) and red (decline / end) buttons by colour,
// reads its text with Vision, and clicks the buttons with real mouse events.

let clickToCallLabel = "click to call"

struct BannerLook {
    var green: CGPoint?  // screen coordinates
    var red: CGPoint?
    var texts: [String]
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let v = axValue(el, "AXFrame"), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var rect = CGRect.zero
    return AXValueGetValue(v as! AXValue, .cgRect, &rect) ? rect : nil
}

func isCallBanner(_ el: AXUIElement, label: String) -> Bool {
    guard axString(el, kAXSubroleAttribute) == "AXNotificationCenterBanner" else { return false }
    let id = (axString(el, kAXIdentifierAttribute) ?? label).lowercased()
    return id.contains("facetime") || id.contains("phone") || id.contains("call")
}

func captureScreen(_ r: CGRect) -> CGImage? {
    let path = NSTemporaryDirectory() + "callbridge-banner-\(getpid()).png"
    defer { try? FileManager.default.removeItem(atPath: path) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-R", "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))", path]
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    // Read the file now: an image source decodes lazily, after the deferred delete.
    guard p.terminationStatus == 0, let data = FileManager.default.contents(atPath: path),
          let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
}

/// Centre (in image pixels) of the largest blob of pixels matching `test`, if it is big enough to be a button.
func largestBlob(_ px: [UInt8], _ w: Int, _ h: Int, minArea: Int, _ test: (Int, Int, Int) -> Bool) -> CGPoint? {
    var mask = [Bool](repeating: false, count: w * h)
    for i in 0..<(w * h) { mask[i] = test(Int(px[i * 4]), Int(px[i * 4 + 1]), Int(px[i * 4 + 2])) }
    var seen = [Bool](repeating: false, count: w * h)
    var best: (area: Int, sx: Int, sy: Int) = (0, 0, 0)
    for start in 0..<(w * h) where mask[start] && !seen[start] {
        var stack = [start], area = 0, sx = 0, sy = 0
        seen[start] = true
        while let i = stack.popLast() {
            area += 1; sx += i % w; sy += i / w
            let x = i % w, y = i / w
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < w && ny < h {
                let j = ny * w + nx
                if mask[j] && !seen[j] { seen[j] = true; stack.append(j) }
            }
        }
        if area > best.area { best = (area, sx, sy) }
    }
    guard best.area > 0, best.area >= minArea else { return nil }
    return CGPoint(x: CGFloat(best.sx) / CGFloat(best.area), y: CGFloat(best.sy) / CGFloat(best.area))
}

func lookAtBanner(_ frame: CGRect) -> BannerLook? {
    guard let img = captureScreen(frame) else { return nil }
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let scale = CGFloat(w) / max(frame.width, 1)
    let minArea = max(20, Int(150 * scale * scale))
    let toScreen = { (p: CGPoint) in CGPoint(x: frame.minX + p.x / scale, y: frame.minY + p.y / scale) }
    let green = largestBlob(px, w, h, minArea: minArea) { r, g, b in g > 140 && g > r + 60 && g > b + 30 }.map(toScreen)
    let red = largestBlob(px, w, h, minArea: minArea) { r, g, b in r > 170 && r > g + 90 && r > b + 80 }.map(toScreen)

    // Text left of the buttons, top line first: the caller, then e.g. "iPhone" / "FaceTime Audio" / "Click to Call".
    var texts: [String] = []
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    if (try? VNImageRequestHandler(cgImage: img).perform([request])) != nil {
        let buttonsX = [green, red].compactMap { $0?.x }.min().map { ($0 - frame.minX - 20) / frame.width } ?? 1
        texts = (request.results ?? [])
            // Right of the avatar, left of the buttons: the banner's transparent corners show what's behind it.
            .filter { $0.boundingBox.minX > 0.12 && $0.boundingBox.midX < buttonsX }
            .sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
            .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces) }
            .filter { $0.count >= 2 }
    }
    return BannerLook(green: green, red: red, texts: texts)
}

/// Turns what a call banner shows into the button hits the watcher already understands.
func bannerHits(_ banner: Hit, _ look: BannerLook?) -> [Hit] {
    let f = banner.frame!
    let make = { (label: String, p: CGPoint, texts: [String]) in
        Hit(element: banner.element, label: label, action: "click", texts: texts, app: banner.app, point: p)
    }
    guard let look = look, look.green != nil || look.red != nil else {
        // Couldn't see the buttons (no Screen Recording permission?): the call button of the "Click to Call"
        // banner sits at the top right.
        return [make(clickToCallLabel, CGPoint(x: f.maxX - 62, y: f.minY + 33), [])]
    }
    let isPrompt = look.texts.contains { $0.lowercased().contains(clickToCallLabel) } || f.height < 150
    let noise: Set<String> = ["block", "waiting...", "waiting…"]
    let texts = look.texts
        .filter { !$0.lowercased().contains(clickToCallLabel) && !noise.contains($0.lowercased()) }
        .map { $0.replacingOccurrences(of: #"\s*[-·•]\s*\d+:\d{2}$"#, with: "", options: .regularExpression) }  // ring timer
    switch (look.green, look.red) {
    case let (g?, r?): return [make("accept", g, texts), make("decline", r, texts)]
    case let (g?, nil) where isPrompt: return [make(clickToCallLabel, g, texts)]
    case let (g?, nil):
        // Incoming call: green Accept bottom right, grey ✕ (Decline) mirrored at the bottom left.
        return [make("accept", g, texts), make("decline", CGPoint(x: f.minX + (f.maxX - g.x), y: g.y), texts)]
    case let (nil, r?): return [make("end", r, texts)]
    default: return []
    }
}

func click(at point: CGPoint) -> Bool {
    let back = CGEvent(source: nil)?.location
    let source = CGEventSource(stateID: .hidSystemState)
    // Hover first so the banner reacts, and leave the pointer there until the click has been delivered.
    for (type, pause) in [(CGEventType.mouseMoved, 150_000), (.leftMouseDown, 80_000), (.leftMouseUp, 250_000)] {
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return false }
        if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: 1) }
        e.post(tap: .cghidEventTap)
        usleep(useconds_t(pause))
    }
    if let back = back { CGWarpMouseCursorPosition(back) }
    return true
}

func axValue(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
    if let s = axValue(el, name) as? String, !s.isEmpty { return s }
    return nil
}

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
    return list
}

/// Notification actions are exposed as "Name:Accept\nTarget:0x0\nSelector:(null)".
func actionLabel(_ raw: String) -> String {
    if raw.hasPrefix("Name:") { return String(raw.dropFirst(5).split(separator: "\n").first ?? "") }
    return raw
}

func collectTexts(_ el: AXUIElement, depth: Int = 0, into out: inout [String]) {
    if depth > 6 || out.count > 12 { return }
    let role = axString(el, kAXRoleAttribute) ?? ""
    if role == kAXStaticTextRole as String || role == "AXTextField" {
        if let v = axString(el, kAXValueAttribute) ?? axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute) { out.append(v) }
    }
    for c in (axValue(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { collectTexts(c, depth: depth + 1, into: &out) }
}

let ignoredActions: Set<String> = ["AXPress", "AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI", "AXCancel", "AXRaise", "AXConfirm", "AXPick", "AXIncrement", "AXDecrement"]

func scanApp(_ app: NSRunningApplication, hits: inout [Hit], dump: inout [[String: Any]]?) {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let appName = app.bundleIdentifier ?? app.localizedName ?? "?"
    var visited = 0
    func walk(_ el: AXUIElement, _ path: [AXUIElement], _ depth: Int) {
        visited += 1
        if depth > 16 || visited > 5000 { return }
        let role = axString(el, kAXRoleAttribute) ?? ""
        let label = axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute) ?? ""
        let actions = axActions(el)
        if dump != nil {
            var entry: [String: Any] = ["app": appName, "depth": depth, "role": role]
            if !label.isEmpty { entry["label"] = label }
            if let v = axString(el, kAXValueAttribute) { entry["value"] = String(v.prefix(120)) }
            let custom = actions.filter { !ignoredActions.contains($0) }.map(actionLabel)
            if !custom.isEmpty { entry["actions"] = custom }
            dump!.append(entry)
        }
        func containerTexts() -> [String] {
            var texts: [String] = []
            let container = path.count >= 2 ? path[path.count - 2] : (path.last ?? el)
            collectTexts(container, into: &texts)
            return texts
        }
        if role == kAXButtonRole as String, !label.isEmpty {
            hits.append(Hit(element: el, label: label, action: kAXPressAction as String, texts: containerTexts(), app: appName))
        }
        // Skip banners sliding in or out past the screen edge: half a banner can't be read or clicked reliably.
        // (A banner at rest can still overhang the edge by a pixel.)
        if isCallBanner(el, label: label), let f = axFrame(el), f.width > 40, f.height > 20,
           NSScreen.screens.contains(where: { s in
               let top = (NSScreen.screens.first?.frame.height ?? 0) - s.frame.maxY  // AppKit → top-left coordinates
               let visible = CGRect(x: s.frame.minX, y: top, width: s.frame.width, height: s.frame.height).intersection(f)
               return !visible.isNull && visible.width * visible.height >= 0.9 * f.width * f.height
           }) {
            hits.append(Hit(element: el, label: "", action: "banner", texts: [], app: appName, frame: f))
        }
        for raw in actions where !ignoredActions.contains(raw) {
            let l = actionLabel(raw)
            if !l.isEmpty { hits.append(Hit(element: el, label: l, action: raw, texts: containerTexts(), app: appName)) }
        }
        for c in (axValue(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(c, path + [el], depth + 1) }
    }
    walk(root, [], 0)
}

func callApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { app in
        let id = (app.bundleIdentifier ?? "").lowercased()
        return id == "com.apple.notificationcenterui" || id.contains("facetime") || id.contains("telephony") || id.contains("incall")
    }
}

let acceptWords: Set<String> = ["accept", "answer"]
let declineWords: Set<String> = ["decline"]
let endWords: Set<String> = ["end", "end call", "leave", "hang up"]
let confirmWords: Set<String> = ["call", clickToCallLabel]

func runWatch() {
    let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    emit(["event": "perm", "ax": trusted, "screen": CGPreflightScreenCaptureAccess()])
    let queue = DispatchQueue(label: "watch")
    var lastState = ""
    var lastCaller = ""
    var idleStreak = 0
    var confirmUntil = Date.distantPast
    var pending: [String] = []
    var lastBanners: [CGRect] = []
    var looks: [String: (at: Date, look: BannerLook?)] = [:]
    var lastPerm = Date()
    let key = { (r: CGRect) in "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))" }

    func press(_ words: Set<String>, in hits: [Hit]) -> Bool {
        guard let h = hits.first(where: { words.contains($0.label.lowercased()) }) else { return false }
        if let p = h.point {
            looks.removeAll()  // the banner changes once clicked
            return click(at: p)
        }
        return AXUIElementPerformAction(h.element, h.action as CFString) == .success
    }

    func tick() {
        if Date().timeIntervalSince(lastPerm) > 10 {
            lastPerm = Date()
            emit(["event": "perm", "ax": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()])
        }
        guard AXIsProcessTrusted() else { return }
        var hits: [Hit] = []
        var noDump: [[String: Any]]? = nil
        for app in callApps() { scanApp(app, hits: &hits, dump: &noDump) }

        let banners = hits.filter { $0.action == "banner" }
        hits.removeAll { $0.action == "banner" }
        let prevBanners = lastBanners
        lastBanners = banners.map { $0.frame! }
        looks = looks.filter { k, _ in lastBanners.contains { key($0) == k } }
        // Look at a banner only once it has stopped sliding in; refresh what it shows every so often.
        for b in banners where prevBanners.contains(b.frame!) {
            let k = key(b.frame!)
            if let cached = looks[k], Date().timeIntervalSince(cached.at) < 1.5 {} else { looks[k] = (Date(), lookAtBanner(b.frame!)) }
            hits += bannerHits(b, looks[k]!.look)
        }

        for cmd in pending {
            switch cmd {
            case "accept": emit(["event": "result", "cmd": cmd, "ok": press(acceptWords, in: hits)])
            case "decline": emit(["event": "result", "cmd": cmd, "ok": press(declineWords, in: hits)])
            case "end": emit(["event": "result", "cmd": cmd, "ok": press(endWords, in: hits) || press(declineWords, in: hits)])
            case "confirm": confirmUntil = Date().addingTimeInterval(10)
            case "dump":
                var dump: [[String: Any]]? = []
                var ignored: [Hit] = []
                for app in callApps() { scanApp(app, hits: &ignored, dump: &dump) }
                for b in banners {
                    let f = b.frame!, look = lookAtBanner(f)
                    var entry: [String: Any] = ["app": b.app, "depth": 0, "role": "call banner",
                                                "frame": [f.minX, f.minY, f.width, f.height], "screenshot": look != nil]
                    if let g = look?.green { entry["green"] = [g.x, g.y] }
                    if let r = look?.red { entry["red"] = [r.x, r.y] }
                    if let t = look?.texts { entry["texts"] = t }
                    entry["actions"] = bannerHits(b, look).map { $0.label }
                    dump!.append(entry)
                }
                emit(["event": "dump", "tree": dump ?? []])
            default: break
            }
        }
        pending.removeAll()

        // An outgoing tel:/facetime: link shows a "Call" prompt (on macOS 26, a "Click to Call" banner) on the Mac;
        // press it for the browser.
        if Date() < confirmUntil, press(confirmWords, in: hits) { confirmUntil = .distantPast }

        var state = "idle"
        var caller = ""
        var detail = ""
        if let h = hits.first(where: { acceptWords.contains($0.label.lowercased()) }) {
            state = "ringing"
            let skip = acceptWords.union(declineWords).union(["incoming call", "notification center", "options"])
            let texts = h.texts.filter { !skip.contains($0.lowercased()) }
            caller = texts.first ?? ""
            detail = texts.dropFirst().first ?? ""
        } else if hits.contains(where: { endWords.contains($0.label.lowercased()) }) {
            state = "active"
        }
        // Debounce idle so a UI redraw mid-call doesn't look like a hang-up.
        if state == "idle" && lastState != "idle" && lastState != "" {
            idleStreak += 1
            if idleStreak < 3 { return }
        }
        idleStreak = 0
        if state != lastState || caller != lastCaller {
            lastState = state
            lastCaller = caller
            emit(["event": "state", "state": state, "caller": caller, "detail": detail])
        }
    }

    Thread.detachNewThread {
        while let line = readLine() {
            let cmd = line.trimmingCharacters(in: .whitespaces).lowercased()
            if !cmd.isEmpty { queue.async { pending.append(cmd); tick() } }
        }
        exit(0)
    }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(700))
    timer.setEventHandler { tick() }
    timer.resume()
    keepAlive.append(timer as AnyObject)
    dispatchMain()
}

// MARK: - FaceTime window video

@available(macOS 14.0, *)
func runVideo() async {
    let fps = Double(arg("--fps", "12")!) ?? 12
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    var window: SCWindow?
    var lastLookup = Date.distantPast
    while true {
        if window == nil || Date().timeIntervalSince(lastLookup) > 2 {
            lastLookup = Date()
            if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) {
                window = content.windows
                    .filter { ($0.owningApplication?.bundleIdentifier ?? "") == "com.apple.FaceTime" && $0.frame.width > 200 && $0.frame.height > 150 }
                    .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            }
        }
        if let w = window {
            let config = SCStreamConfiguration()
            let scale = min(2.0, 1280.0 / max(w.frame.width, 1))
            config.width = Int(w.frame.width * scale)
            config.height = Int(w.frame.height * scale)
            config.showsCursor = false
            let filter = SCContentFilter(desktopIndependentWindow: w)
            if let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config),
               let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.6]) {
                var len = UInt32(jpeg.count).bigEndian
                let frame = Data(bytes: &len, count: 4) + jpeg
                outQueue.sync { writeAll(frame) }
            } else {
                window = nil
            }
        }
        try? await Task.sleep(nanoseconds: UInt64(1_000_000_000 / fps))
    }
}

// MARK: - main

switch CommandLine.arguments.dropFirst().first ?? "" {
case "devices":
    listDevices()
case "audio":
    runAudio()
case "restore":
    if CommandLine.arguments.count > 2 { restoreDefaults(from: CommandLine.arguments[2]) }
case "watch":
    runWatch()
case "look":  // callbridge look X Y W H: what the watcher sees in a call banner at that screen rectangle
    let n = CommandLine.arguments.dropFirst(2).compactMap { Double($0) }
    if n.count == 4, let look = lookAtBanner(CGRect(x: n[0], y: n[1], width: n[2], height: n[3])) {
        print("green:", look.green.map { "\($0)" } ?? "-", "red:", look.red.map { "\($0)" } ?? "-", "texts:", look.texts)
    } else {
        print("nothing captured")
    }
case "video":
    if #available(macOS 14.0, *) {
        handleSignals()
        Task { await runVideo() }
        dispatchMain()
    } else {
        FileHandle.standardError.write("callbridge: video needs macOS 14 or later\n".data(using: .utf8)!)
        exit(2)
    }
default:
    FileHandle.standardError.write("usage: callbridge devices | audio | restore FILE | watch | video | look X Y W H\n".data(using: .utf8)!)
    exit(64)
}
