# Sticker Pipeline Session

**Objective:** LINEスタンプ自動生成パイプラインの実装

## Current Focus
- [x] プロジェクト構成・スクリプト実装完了
- [ ] Fooocus で raw_images/ に画像生成（手動）
- [ ] `python pipeline.py process` で背景透明化
- [ ] `python pipeline.py validate` でLINE仕様チェック
- [ ] `python pipeline.py metadata` で申請セット作成

## Quick Start

```bash
# 仮想環境セットアップ（初回のみ）
python -m venv venv
source venv/bin/activate        # Linux/Mac
# .\venv\Scripts\Activate.ps1  # Windows

pip install -r requirements.txt

# Step 1: プロンプト生成 (prompts/emotion_prompts.json を出力)
python pipeline.py prompts

# Step 2: Fooocusで raw_images/ に画像生成（手動）

# Step 3: 一括後処理
python pipeline.py process

# Step 4: 検証
python pipeline.py validate

# Step 5: 申請セット作成
python pipeline.py metadata

# または全ステップ一括実行（raw_images/ に画像がある状態で）
python pipeline.py all
```

## File Structure

```
sticker_pipeline/
├── pipeline.py            # エントリーポイント
├── requirements.txt
├── CLAUDE.md              # このファイル
├── src/
│   ├── config.py          # パス・定数・プロンプト定義
│   ├── generate_prompts.py
│   ├── batch_process.py
│   ├── metadata_gen.py
│   └── validate.py
├── prompts/
│   ├── base_prompts.json
│   ├── emotions.json
│   └── emotion_prompts.json  (generate_prompts 実行後に生成)
├── raw_images/            # Fooocus 出力先（手動配置）
├── processed_images/      # 後処理済み画像
└── sticker_sets/
    └── set_01/
        ├── sticker_*.png
        └── metadata.json
```

## Dependencies
- Python 3.10+
- pillow, rembg, torch, torchvision, onnxruntime
- Fooocus（別途インストール、画像生成用）

## LINE仕様
- PNG / RGBA / 512×512px / ≤300KB / 最小8枚
- ファイル名: ASCII文字のみ（スペース・記号は `_`）
