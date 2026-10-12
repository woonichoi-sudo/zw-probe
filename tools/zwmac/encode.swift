// zwmac-encode — 원시 BGRA8 프레임(stdin)을 H.264 MP4 로 묶는다. macOS 의 `record` 가 쓴다.
//
//   zwmac-encode --out x.mp4 --width W --height H --fps 10   < 프레임들 (W*H*4 바이트씩, 위→아래)
//
// **판정하지 않는다** (절대 규칙 5). 받은 프레임을 i/fps 시각에 차례로 넣을 뿐이다 — 고정 간격과
// 복제는 부르는 쪽(zwmac.ts)이 정한다. Windows 의 Media Foundation 경로(Record.cs)와 같은 역할이다.
//
// **AVFoundation 은 OS 에 들어 있다** — ffmpeg 없이 된다. 화면 기록 권한도 필요 없다(픽셀은 앱이 준다).
// H.264 는 짝수 크기를 요구하므로 홀수면 오른쪽·아래 1px 을 버린다.
//
// 빌드: bash tools/zwmac/build.sh → bin/zwmac-encode

import AVFoundation
import CoreVideo
import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

var args: [String: String] = [:]
var i = 1
let argv = CommandLine.arguments
while i < argv.count {
    let k = argv[i]
    if k.hasPrefix("--"), i + 1 < argv.count {
        args[String(k.dropFirst(2))] = argv[i + 1]
        i += 2
    } else {
        i += 1
    }
}

guard let outPath = args["out"] else { fail("--out 이 필요하다") }
guard let srcW = Int(args["width"] ?? ""), let srcH = Int(args["height"] ?? ""), srcW > 1, srcH > 1 else {
    fail("--width --height 가 필요하다")
}
let fps = Int32(args["fps"] ?? "10") ?? 10
let w = srcW - srcW % 2
let h = srcH - srcH % 2
let frameBytes = srcW * srcH * 4

let url = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: url)
let writer: AVAssetWriter
do {
    writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
} catch {
    fail("AVAssetWriter 를 만들지 못했다: \(error)")
}
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: w,
    AVVideoHeightKey: h,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(1_000_000, w * h * 2)],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: w,
        kCVPixelBufferHeightKey as String: h,
    ])
guard writer.canAdd(input) else { fail("입력을 붙일 수 없다") }
writer.add(input)
guard writer.startWriting() else { fail("쓰기를 시작하지 못했다: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

let stdin = FileHandle.standardInput
var frames: Int64 = 0
var pending = Data()

func readFrame() -> Data? {
    while pending.count < frameBytes {
        let chunk = stdin.readData(ofLength: frameBytes - pending.count)
        if chunk.isEmpty { return nil }
        pending.append(chunk)
    }
    let f = pending.prefix(frameBytes)
    pending.removeFirst(frameBytes)
    return Data(f)
}

while let frame = readFrame() {
    guard let pool = adaptor.pixelBufferPool else { fail("픽셀 버퍼 풀이 없다: \(String(describing: writer.error))") }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
    guard let buf = pb else { fail("픽셀 버퍼를 만들지 못했다") }
    CVPixelBufferLockBaseAddress(buf, [])
    let dst = CVPixelBufferGetBaseAddress(buf)!.assumingMemoryBound(to: UInt8.self)
    let dstStride = CVPixelBufferGetBytesPerRow(buf)
    frame.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
        let s = src.bindMemory(to: UInt8.self).baseAddress!
        for y in 0..<h {
            memcpy(dst + y * dstStride, s + y * srcW * 4, w * 4)
        }
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    while !input.isReadyForMoreMediaData { usleep(2000) }
    if !adaptor.append(buf, withPresentationTime: CMTime(value: frames, timescale: fps)) {
        fail("프레임 \(frames) 을 넣지 못했다: \(String(describing: writer.error))")
    }
    frames += 1
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("마무리하지 못했다: \(String(describing: writer.error))") }
print("{\"ok\":true,\"frames\":\(frames),\"width\":\(w),\"height\":\(h)}")
