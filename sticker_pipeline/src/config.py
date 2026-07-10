from pathlib import Path

# プロジェクトルート
PROJECT_ROOT = Path(__file__).parent.parent

# ディレクトリパス
RAW_IMAGES_DIR = PROJECT_ROOT / "raw_images"
PROCESSED_IMAGES_DIR = PROJECT_ROOT / "processed_images"
STICKER_SETS_DIR = PROJECT_ROOT / "sticker_sets"
PROMPTS_DIR = PROJECT_ROOT / "prompts"

# LINE仕様定数
STICKER_SIZE = 512          # px (512×512)
FRAME_SIZE = 26             # 余白幅 px
MAX_FILE_SIZE_KB = 300      # 1枚の最大サイズ
MIN_STICKER_COUNT = 8       # セット最小枚数

# 感情ラベルとプロンプト説明
EMOTIONS = {
    "happy": "smiling brightly, energetic",
    "concentrated": "focused expression, thinking",
    "tired": "sleepy eyes, yawning",
    "excited": "jumping, arms up",
    "sad": "downturned mouth, teary",
    "proud": "chest out, confident",
    "frustrated": "furrowed brows, grumpy",
    "encouragement": "thumbs up, supportive pose",
    "thanks": "hands together, grateful expression",
    "surprised": "wide eyes, open mouth",
    "nervous": "sweating, anxious expression",
    "love": "heart eyes, blushing",
}

# ベースプロンプトテンプレート
BASE_PROMPT_TEMPLATE = (
    "kawaii piano teacher character, anime style, {emotion}, "
    "chibi proportions, simple linework, expressive eyes, "
    "no background, transparent, white outline stroke, "
    "professional illustration, vibrant colors, "
    "512x512, high quality"
)

# ネガティブプロンプト
NEGATIVE_PROMPT = (
    "background, watermark, text, blurry, low quality, "
    "realistic, 3d, photorealistic, dark colors"
)

# Fooocus推奨設定
FOOOCUS_SETTINGS = {
    "sampler": "DPM++ 2M Karras",
    "steps": 25,
    "guidance_scale": 7.0,
    "width": 512,
    "height": 512,
}

# メタデータ
STICKER_METADATA = {
    "title": "Piano Teacher Emotions",
    "author": "Atsushi Hasebe",
    "description": "Cute piano teacher character with various emotions",
    "tags": ["piano", "kawaii", "teacher", "emotions"],
}
