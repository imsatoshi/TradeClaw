# TradeClaw Improvement Plan v4 — 交易邏輯假設修正

> Generated: 2026-03-08 | Status: In Progress

## 概述

v2/v3 修復了代碼層面的 bug（原子寫入、異常處理、內存洩漏）。
v4 修復**假設層面的錯誤** — 代碼能跑、測試通過，但交易邏輯在真實市場中是錯的。

核心原則：不是問「能不能跑」，而是問「憑什麼這麼算」。

---

## P0 — 根本性邏輯缺陷

### P0-1: RSI 評分需要背離確認，而非絕對值
**問題：** `scoreMomentum()` 給 RSI 30-45 打 8 分（「超賣恢復」）。但在清算級聯中，RSI 25 意味著恐慌在加速，不是見底。代碼無法區分「賣壓耗盡」和「級聯崩盤」。
**場景：** 2024 年 3 月 BTC 一小時跌 3%，15m RSI 從 28 到 12，系統在 28 時就給了高分。
**修正：** RSI 評分要求**背離**（當前擺動低點的 RSI 高於前一個低點的 RSI），而非看絕對水平。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts` (scoreMomentum, lines 79-163)

### P0-2: 波動率懲罰需要區分市場狀態
**問題：** BBWP > 70 全局扣 10-15 分。但上升趨勢中波動率擴大 = 趨勢加速確認。代碼把最好的趨勢入場當風險扣分。
**場景：** BTC 突破 95K 阻力，BBWP 跳到 72，系統扣 10 分。但這正是趨勢確認的信號。
**修正：** 趨勢中 BBWP 高 = 加分（加速），震盪中 BBWP 高 = 扣分（鞭刑風險）。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts` (scoreSetup, lines 618-624)

### P0-3: DCA 需要條件門檻，不能無條件加倉
**問題：** 虧 -1.5x ATR 加倉 50%，-2.5x ATR 再加 50%。如果 regime 已變（震盪→趨勢），你在用 54% 勝率信號翻倍下注。
**場景：** BTC 做空在 $98.5K，FOMC 消息推升至 $104K。系統在 $99.9K 和 $104K 各加倉一次，虧損翻倍。
**修正：**
- DCA 最多 1 層（從 2 降到 1）
- 觸發前檢查 regime 是否和入場時一致
- 低評分信號（<75）禁用 DCA
**文件：** `src/extension/crypto-trading/trade-manager/TradeManager.ts` (computeDcaLayers, checkDcaTrigger)

### P0-4: Guard 閾值收緊
**問題：** 40% 單倉 × 5 持倉 × 60s 冷卻 = 3 分鐘內可累積 160% 名義敞口。加密貨幣壓力下相關性 0.85+，閃崩常見。
**修正：**
- MaxPositionSize: 40% → 25%
- Cooldown: 60s → 300s
- MaxOpenTrades: 5 → 3
**文件：** `data/config/guards.json`

---

## P1 — 重要邏輯問題

### P1-1: EMA 展幅看變化率而非絕對值
**問題：** EMA 展幅 3.0% 得 10 分。但 3.5%→3.0%（減速）和 0.2%→0.7%（加速）得分反了。
**修正：** 加入展幅 delta：如果展幅在擴大 → 加分，收縮 → 減分。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts` (scoreTrend, lines 32-77)

### P1-2: 多時間框架 RSI 懲罰基於趨勢方向
**問題：** 1H RSI > 70 懲罰做多。但 1H 上升趨勢中 RSI 70 是正常延伸，15m 回調做多是高確信入場。
**修正：** 檢查 1H EMA 方向：同向 → 不懲罰，逆向 → 加重懲罰。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts` (scoreMomentum, lines 135-157)

### P1-3: 漸進保護刷新 ATR
**問題：** 用入場時的 ATR 計算所有階段。趨勢加速後 ATR 擴大，1.5x 入場 ATR 的止損相對當前波動變緊。
**修正：** 每次階段檢查時取當前 ATR（已有 atrCache），用 `max(entryATR, currentATR)` 計算止損距離。
**文件：** `src/extension/crypto-trading/trade-manager/TradeManager.ts` (applyProgressiveProtection)

### P1-4: 資金費率評分看 delta 而非絕對值
**問題：** 費率 > 0.05% → 做空得高分。但費率從 0.01% 升到 0.05% = 趨勢加速，反做是逆勢。
**修正：** 要求費率在**下降**（從高點回落）才觸發反做信號，上升中不觸發。
**文件：** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts` (scoreFunding, lines 468-497)

---

## 實施順序

```
P0-4 (Guard 配置) → P0-2 (波動率懲罰) → P0-1 (RSI 背離) → P0-3 (DCA 門檻)
→ P1-1 (EMA delta) → P1-2 (MTF 方向) → P1-4 (費率 delta) → P1-3 (ATR 刷新)
```

## 預期效果

- **P0 修正後：** 消除最大的假陽性來源（級聯中追超賣、趨勢中躲波動、DCA 翻倍虧損）
- **P1 修正後：** 從「指標機器」變成理解市場狀態的系統
- 預計減少 30-40% 的錯誤信號（尤其在高波動和 regime 轉換期間）
