"""Measure CPU synthesis with a supplied ONNX thread count and fixed phrases."""
import argparse
import json
import time

from vieneu import Vieneu


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    tts = Vieneu(backend="onnx", device="cpu", precision="fp32", threads=args.threads)
    for _ in tts.infer_stream("Xin chào.", apply_watermark=False):
        pass
    rows = []
    phrases = [
        "Chúng ta cần chuẩn bị dữ liệu thật tốt trước khi sử dụng trí tuệ nhân tạo trong công việc.",
        "Điều quan trọng là kiểm tra kết quả thực tế, hiểu rõ giới hạn của hệ thống và từng bước cải thiện những vấn đề còn tồn tại.",
        "Khi xây dựng một sản phẩm mới, hãy bắt đầu từ nhu cầu của người dùng, thử nghiệm các giải pháp và đo lường hiệu quả trước khi mở rộng.",
    ]
    for text in phrases:
        started = time.perf_counter()
        cpu_started = time.process_time()
        samples = sum(len(chunk) for chunk in tts.infer_stream(text, apply_watermark=True))
        wall = time.perf_counter() - started
        duration = samples / 48000
        rows.append({"wallSeconds": wall, "audioSeconds": duration,
                     "cpuSeconds": time.process_time() - cpu_started,
                     "rtf": wall / duration})
    result = {"threads": args.threads, "rows": rows,
              "rtf": sum(r["wallSeconds"] for r in rows) / sum(r["audioSeconds"] for r in rows)}
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
