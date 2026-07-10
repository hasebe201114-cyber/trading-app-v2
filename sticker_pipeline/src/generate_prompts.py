"""
generate_prompts.py
Fooocus用プロンプトをJSONとして生成する。
"""

import json
from pathlib import Path
from config import EMOTIONS, BASE_PROMPT_TEMPLATE, NEGATIVE_PROMPT, PROMPTS_DIR, FOOOCUS_SETTINGS


def generate_prompts() -> list[dict]:
    """感情ごとのFooocusプロンプト一覧を生成して返す。"""
    prompts = []
    for emotion, desc in EMOTIONS.items():
        prompts.append({
            "emotion": emotion,
            "prompt": BASE_PROMPT_TEMPLATE.format(emotion=desc),
            "negative_prompt": NEGATIVE_PROMPT,
            "filename": f"sticker_{emotion}.png",
            "fooocus_settings": FOOOCUS_SETTINGS,
        })
    return prompts


def save_prompts(prompts: list[dict], output_path: Path | None = None) -> Path:
    """プロンプト一覧をJSONファイルに保存する。"""
    if output_path is None:
        output_path = PROMPTS_DIR / "emotion_prompts.json"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(prompts, f, ensure_ascii=False, indent=2)

    return output_path


def main() -> None:
    prompts = generate_prompts()
    output_path = save_prompts(prompts)
    print(f"✅ {len(prompts)}個のプロンプト生成 → {output_path}")

    print("\n--- Fooocus用プロンプト一覧 ---")
    for p in prompts:
        print(f"\n[{p['emotion']}]")
        print(f"  Prompt: {p['prompt']}")
        print(f"  File  : {p['filename']}")


if __name__ == "__main__":
    main()
