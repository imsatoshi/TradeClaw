# TradeClaw Improvement Plan v5 — 假設修正第二輪

> Generated: 2026-03-08 | Status: In Progress

## 概述

v4 修正了評分系統（RSI 背離、波動率 regime、DCA 門檻、資金費率保守化）。
v5 修正**交易執行層面的假設錯誤** — 倉位大小、入場門檻、風控乘數。

---

## P0 — 影響盈利能力

### P0-1: Kelly 勝率推導需要歷史回饋
**問題：** `computeKellyRiskPercent()` 用公式 `p = 0.40 + (setupScore - 50) * 0.005` 從 score 硬算勝率。setupScore 80 → 65% 勝率，但某些 pattern 實際勝率只有 38%。線性映射沒有任何事實基礎。
**場景：** score 80 的 bullish_confirm 觸發，Kelly 算出 3.1% 風險。但該 trigger type 在下跌趨勢中實際勝率 38%，連虧 5 次。
**修正：** 收窄勝率估計範圍（0.45-0.55），降低 Kelly 上限（4%→3%），增加保守度（quarter → fifth）。在沒有歷史回饋機制之前，不能假裝知道勝率。
**文件：** `src/extension/archive-analysis/adapter.ts` (computeKellyRiskPercent, lines 39-52)

### P0-2: R:R 門檻需要區分 regime
**問題：** `checkEntryTrigger()` 硬編碼 `rr < 1.8` 全局拒絕。震盪市場 scalp 用 1.2x R:R + 52% 勝率就能盈利，但被系統丟棄。趨勢市場本身勝率高，1.5x 就夠。
**場景：** BTC 窄幅震盪 $41,900-$42,100，1.53x R:R 的高勝率 setup 被丟掉。
**修正：** R:R 門檻根據 regime 調整：ranging=1.2, trending=1.5, default=1.8。Pending zone 同理降低。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts` (lines 310, 423, 508, 546)

---

## P1 — 削弱優勢

### P1-1: Trailing Stop 需要最小距離保護
**問題：** Chandelier 模式用 14H lookback 的 high/low 錨定 SL。閃崩時 ATR 暴漲，SL 反而在最差位置收緊（whipsaw 後收緊而不是放寬）。
**修正：** 加入最小距離保護：SL 不能比 peak price 的 2.5% 更近。防止閃崩期間 ATR 暴增導致的錯誤收緊。
**文件：** `src/extension/crypto-trading/trade-manager/TradeManager.ts` (applyTrailingStop, lines 638-705)

### P1-2: Pending Zone 需要滑點緩衝
**問題：** Zone 入場價是精確結構水平，但市價單必然滑點。R:R ≥ 2.0 門檻太嚴格，大量可盈利 zone setup 被過濾。
**修正：** Zone 邊界加 0.1x ATR 滑點緩衝，R:R 門檻降到 1.5。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts` (computePendingZone, lines 490-560)

### P1-3: Emotion Guard 需要重算 Kelly 而非線性縮倉
**問題：** cautious = 0.5x 倉位，但情緒交易勝率可能降到 30-35%，0.5x 縮減不夠。應該假設勝率下降，重新算 Kelly。
**修正：** 用勝率降級替代固定乘數：cautious → 假設勝率 -10%，scared → 假設勝率 -20%。映射到更保守的 Kelly 倉位。
**文件：** `src/extension/crypto-trading/guards/emotion-guard.ts` (lines 18-35)

### P1-4: MTF 懲罰需要幣種特性
**問題：** DOGE/XRP 等均值回歸幣 1H RSI > 70 幾乎必定回調 3-5%，BTC 可以在 RSI 70+ 延續 10 根 K 線。但代碼用相同 -3 懲罰。
**修正：** 加入均值回歸幣列表，對這些幣種加重 MTF 懲罰。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts` (scoreMomentum MTF section)

---

## 實施順序

```
P0-1 (Kelly 保守化) → P0-2 (R:R regime) → P1-1 (Trailing 最小距離) → P1-2 (Zone 滑點)
→ P1-3 (Emotion Kelly) → P1-4 (幣種 MTF)
```

## 預期效果

- **P0 修正後：** 消除過度自信的倉位大小（Kelly），增加震盪市場的入場機會（R:R）
- **P1 修正後：** 減少閃崩止損（trailing），增加 zone 觸發率，情緒時更保守
- 預計提升 10-15% 的有效交易機會，同時降低 20% 的單筆風險暴露
