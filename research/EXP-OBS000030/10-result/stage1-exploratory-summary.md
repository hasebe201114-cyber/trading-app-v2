# Stage 1 Cross-Sectional Momentum - Exploratory Summary

**生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）。本結果はいかなる場合も本番採用の判断材料にしない。**

## Boundary Conditions

1. **Production adoption banned**: This exploratory result cannot be used for production decision (D staging).
2. **Survivorship bias disclosed** (all tables below tagged): Bitget current live symbols only, dead symbols excluded.
3. **No formal PASS/FAIL judgment**: Observation-based only (no G1-G4 gates applied).
4. **No adoption path even if positive**: Any hint → reference for paid-data re-run as separate OBS.

---

## Config A: 14 Fixed Symbols

**生存バイアス: 最強（2022~2026通年の14銘柄のみ）**

### Prediction Unit (Cross-sectional IC)

| Metric | Value |
|---|---|
| Mean IC | -0.0720 |
| Std IC | 0.3535 |
| t-stat (IC) | -1.5110 |
| % Above 0 | 38.2% |
| Permutation p-value | 0.9766 |
| Measurement periods (months) | 55 |

_注記: 生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N=14。測定期間=55ヶ月。_

### Pipeline Integration (Dollar-Neutral Long-Short Monthly Tercile)

| Metric | Gross | Net |
|---|---|---|
| Annual Sharpe | -0.1327 | -0.1013 |
| Cumulative Return | -35.39% | -32.50% |
| Max Drawdown | -51.07% | -50.95% |
| Monthly observations | 54 |
| Permutation p-value (Net) | 0.8382 |

_注記: 生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N=14。測定期間=54ヶ月。_

_Funding note: Funding履歴は無料API 3年不成立のため全期間ネットから除外。ショート保有コストが過小評価されている可能性。_

### Held-Out Coin Split (Config A only)

| Group | Mean IC |
|---|---|
| Selection (odd indices, 7 coins) | 1.0000 |
| Confirmation (even indices, 7 coins) | 1.0000 |
| Same sign? | Yes |

_注記: 生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N_selection=7/N_confirmation=7。パワー低い（各群N=7）。_

### Time-Series Split (2024-06-30 Boundary)

| Period | Mean IC | Std IC | Perm p |
|---|---|---|---|
| Selection (2022-01〜2024-06) | (computed in JSON) | — | — |
| Confirmation (2024-07〜2026-07) | (computed in JSON) | — | — |

_詳細は stage1-cross-sectional-momentum-exploratory.json を参照_

### Regime Decomposition (Config A)

| Regime | Period | Mean IC | Gross Sharpe | Net Sharpe | Note |
|---|---|---|---|---|---|
| R1 (Bearish/2022) | 2022-01〜2022-12 | (in JSON) | (in JSON) | (in JSON) | Weakness test |
| R2 (Recovery/2023-24) | 2023-01〜2024-12 | (in JSON) | (in JSON) | (in JSON) | Bull regime |
| R3 (Recent/2025-26) | 2025-01〜2026-07 | (in JSON) | (in JSON) | (in JSON) | Recent |

_詳細は stage1-cross-sectional-momentum-exploratory.json を参照_

---

## Config B: PIT Variable N (Supplementary)

**生存バイアス: 未解消（PIT組入れは「現在存在する銘柄が過去にデータを持っていたか」で判定し、当時消えた銘柄は物理的に含められない）**

### Prediction Unit (Cross-sectional IC)

| Metric | Value |
|---|---|
| Mean IC | -0.0367 |
| Std IC | 0.3202 |
| t-stat (IC) | -0.8494 |
| % Above 0 | 45.5% |
| Permutation p-value | 0.8742 |
| Measurement periods (months) | 55 |
| Avg universe size (N) | ~44 |

_注記: 生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N=44。測定期間=55ヶ月。_

### Pipeline Integration (Dollar-Neutral Long-Short Monthly Tercile)

| Metric | Gross | Net |
|---|---|---|
| Annual Sharpe | -0.0648 | -0.0410 |
| Cumulative Return | -52.23% | -49.60% |
| Max Drawdown | -66.36% | -64.72% |
| Monthly observations | 54 |
| Permutation p-value (Net) | 0.0660 |

_注記: 生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N=44。測定期間=54ヶ月。_

_Funding note: Funding履歴は無料API 3年不成立のため全期間ネットから除外。ショート保有コストが過小評価されている可能性。_

---

## Cost Structure

| Component | Value | Note |
|---|---|---|
| Taker fee | 6 bps / side | Bitget USDT-perp standard |
| Slippage Tier 1-10 | 5 bps / side | Based on 24h USDT volume rank |
| Slippage Tier 11-30 | 15 bps / side | — |
| Slippage Tier 31+ | 30 bps / side | — |
| Round-trip cost per trade | (fee + slippage) × 2 | Applied each monthly rebalance |
| Funding cost | **NOT INCLUDED** | 3-year history unavailable via free API (~90 day max). Short leg cost understated. |

---

## Key Observations (Factual, No Judgment)

1. **Config A (Deep, Fixed 14)**:
   - Mean IC = -0.0720, std = 0.3535, t = -1.5110, perm-p = 0.9766
   - Net Sharpe = -0.1013, cumulative net = -32.50%
   - Held-out confirmation IC = 1.0000 (same sign as selection: true)

2. **Config B (Broad, Variable N)**:
   - Mean IC = -0.0367, std = 0.3202, t = -0.8494, perm-p = 0.8742
   - Net Sharpe = -0.0410, cumulative net = -49.60%

3. **Funding gap**: Funding履歴欠損により、ショート保有コスト（キャリー・イージング）が測定に含まれていない。実際のネットコストはここで示す値より大きい可能性。

---

## Non-Judgment Template

**B implementation officer does not apply Rubric § 5 (seeds / weak hint / mixed classification). That interpretation is reserved for C critical reviewer.**

Raw numbers above. End of Stage 1.

---

## File References

- Full results: stage1-cross-sectional-momentum-exploratory.json
- Reproducibility: stage1-params.json, stage1-run.log
- Spec: research/EXP-OBS000030/00-spec-stage1-exploratory.md
