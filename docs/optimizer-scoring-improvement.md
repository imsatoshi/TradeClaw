# 优化器改进方案：从 Grid Search 到抗过拟合框架

> 版本：2026-02-23
> 问题背景：当前 TP 点位系统性偏高，持仓长期无法触及目标价。

---

## 一、当前问题：过拟合，不只是指标选错

### 1.1 现象

当前活跃持仓 TP1 距入场价均超 13%，而价格峰值仅运行到所需距离的 30–50%：

| 币对 | TP1 涨幅 | TP2 涨幅 | 峰值距入场 |
|------|----------|----------|-----------|
| AWE/USDT | +13.1% | +24.1% | +4.9% |
| YGG/USDT | +13.1% | +21.5% | +2.7% |
| AGLD/USDT | +14.7% | +25.4% | +6.6% |

### 1.2 直觉上的原因

看起来只是"评分指标选错了"——优化器只最大化 expectancy，不管胜率。但这是表层原因。

**更深层的原因是过拟合**：

当前流程是：
```
历史数据 30 天 → grid search 56 个 (SL, TP) 组合 → 取最高 expectancy → 写入参数
```

Bailey & Lopez de Prado（2014）证明：当 N 个策略组合被测试后，纯随机噪声下能观测到的最大 Sharpe 约为：

```
E[max SR_N] ≈ σ_SR × [(1−γ) × Φ⁻¹(1−1/N) + γ × Φ⁻¹(1−1/Ne)]
```

**实际含义**：测试 56 个组合，即使真实 alpha 为零，也能在历史上"找到"一个看起来最优的参数。优化器的输出可信度与测试的组合数高度相关——组合越多，过拟合越严重。

> 补充胜率约束或 timeout 惩罚 **不能解决** 过拟合问题，只是换了一个维度过拟合而已。

---

## 二、量化行业的标准解法

### 2.1 Walk-Forward Optimization（WFO）——核心工具

**原理**：不用同一段数据既优化又评估，而是滚动地用历史数据优化、用未来数据验证：

```
|── IS ──|── OOS ──|
         |── IS ──|── OOS ──|
                  |── IS ──|── OOS ──|
```

- **IS（in-sample）**：优化参数
- **OOS（out-of-sample）**：用优化出的参数模拟交易，完全不参与优化

最终把所有 OOS 片段拼成一条完整的权益曲线，这才是真实可信的回测结果。

**IS:OOS 比例**：通常 3:1 到 5:1（例如 60 天 IS + 20 天 OOS）。

**WFO 效率比（WFO Efficiency Ratio）**：
```
WFO ER = OOS_Sharpe / IS_Sharpe
```
健康策略应 > 0.5；接近 0 说明严重过拟合。

### 2.2 Deflated Sharpe Ratio（DSR）——统计校正多次测试

WFO 减少过拟合，但不能消除。对最终选出的参数，需要用 DSR 检验它是否统计显著：

```
DSR = Φ((SR̂ − SR₀) × √(T−1) / √(1 − skew×SR̂ + (kurt−1)/4×SR̂²))
```

其中 SR₀ 是"纯噪声下测试 N 个组合能得到的期望最大 SR"。

**DSR > 0.95**：可在 95% 置信度下认为策略有真实 alpha。

### 2.3 CSCV / PBO——量化过拟合概率

CSCV（Combinatorially Symmetric Cross-Validation）计算**过拟合概率（PBO）**：

> PBO = 在所有 IS/OOS 划分组合中，IS 表现最好的参数在 OOS 表现低于中位数的比例。

- PBO = 0：没有过拟合，IS 最优参数在 OOS 也表现好
- PBO = 0.5：随机，IS 信息对 OOS 毫无预测力
- PBO > 0.5：严重过拟合，IS 选优反而损害 OOS 表现

### 2.4 Monte Carlo——了解分布而非单一结果

不要只看回测的最终结果，而要看结果的**分布**：

1. 从回测交易列表中有放回地抽样，生成 1000+ 条权益曲线
2. 取 P5 / P50 / P95 分位数
3. 用 P95 最大回撤来计算仓位大小（不是用平均回撤）
4. 如果 P50 Sharpe < 0，说明交易样本本身就是负期望的

---

## 三、针对 TradeClaw 的具体改进方案

### 3.1 最紧迫的问题：30 天数据不够

当前优化器默认 `days=30`，测试 56 个组合。

Lopez de Prado 给出了回测数据量下限公式（近似）：

| 测试组合数 (N) | 最少历史长度（年，日级别） |
|--------------|------------------------|
| 10 | ~2 年 |
| 56 | ~4 年 |
| 100 | ~5.5 年 |

**15m K 线 30 天 = 约 2,880 根 bar。** 对于 56 个组合的 grid search，这远远不够——结论几乎肯定是过拟合的。

**立即可行的缓解措施**：

```typescript
// 当前
days = 30

// 建议
days = 90   // 最低可接受线，非常短的策略可接受
```

更根本的解法是用更长历史数据（见 3.2）。

### 3.2 实施 Walk-Forward Optimization

将当前 `optimizeParams` 函数改造为 WFO 流程：

```
建议 WFO 配置：
  总历史窗口：180 天
  IS 窗口：  60 天（滚动）
  OOS 窗口： 20 天
  共 6 个 fold
```

**代码层面改动**（伪代码）：

```typescript
async function walkForwardOptimize(config: WFOConfig): Promise<WFOResult> {
  const { symbol, totalDays = 180, isDays = 60, oosDays = 20 } = config

  const oosResults: OOSFoldResult[] = []

  // 滚动生成 IS/OOS 窗口
  for (let foldEnd = totalDays; foldEnd >= isDays + oosDays; foldEnd -= oosDays) {
    const isEnd   = foldEnd - oosDays
    const isStart = isEnd - isDays

    // IS：优化参数
    const bestParams = await optimizeOnWindow(symbol, isStart, isEnd)

    // OOS：用优化出的参数评估（不允许修改参数）
    const oosPerf = await evaluateOnWindow(symbol, isEnd, foldEnd, bestParams)

    oosResults.push({ fold: oosResults.length, bestParams, oosPerf })
  }

  // 拼接所有 OOS 段，计算综合指标
  const worstParams = oosResults.sort((a, b) => a.oosPerf.expectancy - b.oosPerf.expectancy)[0]
  const wfoER = oosResults.reduce((s, r) => s + r.oosPerf.sharpe, 0) /
                oosResults.reduce((s, r) => s + r.isSharpe, 0)

  // 用最新 IS 窗口的最优参数作为当前生效参数
  const latestParams = oosResults[oosResults.length - 1].bestParams

  return { oosResults, wfoEfficiencyRatio: wfoER, recommendedParams: latestParams }
}
```

**应用规则**：只有当 `wfoER > 0.5` 时，才将参数写入 `symbolOverrides`。否则保留上次参数或使用全局默认值。

### 3.3 缩减参数搜索空间（减少 N）

每增加一个测试组合，就增加一次"碰巧找到好结果"的机会。应该**减少组合数**，而不是增加约束条件：

```typescript
// 当前：8 × 7 = 56 个组合
slRange = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]
tpRange = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]

// 建议：4 × 4 = 16 个组合（基于经济逻辑选点，不是均匀采样）
slRange = [0.75, 1.0, 1.5, 2.0]   // 从"很紧"到"宽松"4个有意义的级别
tpRange = [1.5, 2.0, 2.5, 3.0]    // 去掉 tpMult > 3（15m ATR 框架下极难触及）
```

**理由**：
- 去掉 `tpMult 4.0, 5.0`——基于 15m ATR 的信号，5×ATR 在 48h 内基本不可能触及，保留只会提供虚假的"最优解"
- 去掉 `slMult 0.5`——过紧的止损在 15m 级别几乎必然被噪声触发，产生大量 SL 信号污染回测
- 组合数从 56 → 16，对应所需历史数据量减少约 60%

### 3.4 调整 maxHoldBars

```typescript
// 当前：96 bars = 24h
// 建议：48 bars = 12h
maxHoldBars = 48
```

**理由**：
- 15m 信号的有效生命周期通常在 4–12h，24h 持仓窗口让高 TP 策略用 timeout（以当前价退出）代替 SL 退出，虚假地降低了亏损幅度
- 缩短到 12h 后，高 TP 组合的 timeout 率会上升，其 expectancy 自然下降，优化器会被引导选择更合理的参数——**这是从数据中自然涌现的，而非人为施加的约束**

### 3.5 增加 Monte Carlo 验证步骤

在优化结果写入之前，加一步 Monte Carlo 验证：

```typescript
// 在写入参数前，对选出的最优参数做自举检验
async function validateByMonteCarlo(
  bestParams: ParamComboResult,
  trades: BacktestTradeResult[],
  iterations = 1000
): Promise<{ p50Expectancy: number; p5MaxDD: number; pbo: number }> {
  const simResults = Array.from({ length: iterations }, () => {
    // 有放回地抽样等量交易
    const sampled = trades.map(() => trades[Math.floor(Math.random() * trades.length)])
    return buildSummary(sampled).expectancy
  })

  simResults.sort((a, b) => a - b)
  const p5 = simResults[Math.floor(iterations * 0.05)]
  const p50 = simResults[Math.floor(iterations * 0.50)]

  // 如果 p50 expectancy <= 0，参数不可信，拒绝写入
  return { p50Expectancy: p50, p5MaxDD: /* 计算分位数 */ 0, pbo: 0 }
}
```

**写入规则**：
- `p50Expectancy > 0`：参数有效，写入
- `p50Expectancy <= 0` 或 `WFO ER < 0.5`：参数不可信，跳过写入，保留上一次有效参数

---

## 四、改动优先级

| 优先级 | 改动项 | 难度 | 效果 |
|--------|--------|------|------|
| P0 | `days: 30 → 90`，`maxHoldBars: 96 → 48` | 极低（改默认值）| 立即减少过拟合 |
| P0 | 去掉 `tpMult 4.0, 5.0`，`slMult 0.5` | 极低 | 避免虚假最优解 |
| P1 | 实现 WFO（滚动 IS/OOS 分离） | 中等 | 根本性解决方案 |
| P2 | WFO Efficiency Ratio 门控（ER < 0.5 时不写入参数）| 低（加一个判断）| 防止差参数落地 |
| P3 | Monte Carlo 验证步骤 | 中等 | 了解参数稳健性分布 |

---

## 五、对当前 symbolOverrides 的处置

当前服务器上已有大量 `symbolOverrides`，其中部分参数（如 INJ/SOMI/TON 的 `tpMult=5`）是在 30 天数据 + 56 组合 grid search 下过拟合产生的，不可信。

**短期处置**：

1. 将 `tpRange` 上限降至 3.0，将当前所有 `tpMultiplier > 3` 的 override 手动 cap 到 3.0
2. 下次重新跑优化（使用 `days=90`，新的 `tpRange/slRange`）时，结果会覆盖现有 overrides

```bash
# 在服务器上临时检查有哪些 tpMultiplier > 3
cat /root/TradeClaw/data/config/strategy-params.json | \
  python3 -c "
import json,sys
d=json.load(sys.stdin)
for sym,strats in d.get('symbolOverrides',{}).items():
  for strat,p in strats.items():
    tp=p.get('tpMultiplier',0)
    if tp>3: print(f'{sym} / {strat}: tpMult={tp}')
"
```

---

## 六、参考文献

- Bailey, Lopez de Prado et al. (2014) — *The Probability of Backtest Overfitting* (CSCV/PBO) — SSRN 2326253
- Bailey & Lopez de Prado (2014) — *The Deflated Sharpe Ratio* — SSRN 2460551
- Lopez de Prado (2018) — *Advances in Financial Machine Learning* — Chapters 7–12 (Purged CV, CPCV)
- Ernest Chan (2013) — *Algorithmic Trading: Winning Strategies and Their Rationale* — simulation-based optimization
