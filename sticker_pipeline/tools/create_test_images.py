"""
create_test_images.py
パイプライン動作確認用のダミー画像を raw_images/ に生成する。
Fooocusが使えない環境でスクリプトをテストするために使う。

使い方:
    python tools/create_test_images.py
"""

import sys
import math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from PIL import Image, ImageDraw
from config import RAW_IMAGES_DIR, EMOTIONS

# 感情ごとの色
PALETTE = [
    (255, 150, 150), (150, 200, 255), (200, 255, 150),
    (255, 220, 100), (200, 150, 255), (100, 220, 200),
    (255, 180,  80), (150, 255, 200), (255, 130, 200),
    (130, 200, 255), (200, 255, 180), (255, 200, 130),
]

HAPPY_EMOTIONS = {
    "happy", "excited", "proud", "encouragement", "thanks", "love"
}
SAD_EMOTIONS = {"sad", "frustrated", "nervous"}


def draw_character(draw: ImageDraw.ImageDraw, emotion: str, color: tuple, size: int) -> None:
    cx, cy = size // 2, size // 2

    # 頭
    r = int(size * 0.2)
    head_top = cy - r - int(size * 0.1)
    draw.ellipse(
        (cx - r, head_top, cx + r, head_top + 2 * r),
        fill=color, outline=(50, 50, 50, 255), width=4,
    )

    # 目
    eye_r = int(size * 0.028)
    eye_y = head_top + r - int(size * 0.04)
    for ex in (cx - int(size * 0.075), cx + int(size * 0.075)):
        draw.ellipse(
            (ex - eye_r, eye_y - eye_r, ex + eye_r, eye_y + eye_r),
            fill=(30, 30, 30, 255),
        )
        # ハイライト
        draw.ellipse(
            (ex + 4, eye_y - eye_r + 4, ex + eye_r, eye_y),
            fill=(255, 255, 255, 180),
        )

    # 口
    mouth_y_top = head_top + int(r * 1.2)
    mouth_y_bot = mouth_y_top + int(size * 0.06)
    if emotion in HAPPY_EMOTIONS:
        draw.arc((cx - 30, mouth_y_top, cx + 30, mouth_y_bot), 10, 170,
                 fill=(50, 50, 50, 255), width=4)
    elif emotion in SAD_EMOTIONS:
        draw.arc((cx - 30, mouth_y_top, cx + 30, mouth_y_bot), 190, 350,
                 fill=(50, 50, 50, 255), width=4)
    else:
        mid_y = (mouth_y_top + mouth_y_bot) // 2
        draw.line((cx - 25, mid_y, cx + 25, mid_y), fill=(50, 50, 50, 255), width=4)

    # 体
    body_top = head_top + 2 * r + 5
    draw.rectangle(
        (cx - int(size * 0.1), body_top, cx + int(size * 0.1), body_top + int(size * 0.22)),
        fill=color, outline=(50, 50, 50, 255), width=3,
    )


def create_test_images(output_dir: Path = RAW_IMAGES_DIR, size: int = 800) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    for i, (emotion, _) in enumerate(EMOTIONS.items()):
        img = Image.new("RGBA", (size, size), (255, 255, 255, 255))
        draw = ImageDraw.Draw(img)
        draw_character(draw, emotion, PALETTE[i % len(PALETTE)], size)

        out_path = output_dir / f"sticker_{emotion}.png"
        img.save(out_path, "PNG")
        print(f"  ✅ {out_path.name} ({out_path.stat().st_size / 1024:.0f}KB)")

    print(f"\n✨ {len(EMOTIONS)} 枚 → {output_dir}")


if __name__ == "__main__":
    print("🎨 テスト用ダミー画像を生成中...\n")
    create_test_images()
