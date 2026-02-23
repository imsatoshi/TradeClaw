"""
TradeClaw - AI-native execution strategy for Freqtrade.

Architecture:
  AI (strategy brain) → TradePlan (TP/SL specification) → TradeManager (auto-execution) → Freqtrade (this strategy)

This strategy:
- NEVER generates entry/exit signals (all via AI forceentry/forceexit)
- Provides rich technical indicators for AI decision-making
- Uses custom_stoploss as a safety net (-20%) — actual SL managed by TradeManager
- Calculates indicators on 5m timeframe (AI heartbeat cycle)
"""

import talib.abstract as ta
from freqtrade.strategy.interface import IStrategy
from pandas import DataFrame


class TradeClaw(IStrategy):
    INTERFACE_VERSION = 3

    # Safety-net stoploss: -20% hard floor. Actual SL managed by TradeManager (typically 1-3%).
    # This only fires if TradeManager fails — it's a last-resort protection.
    stoploss = -0.20

    # Max concurrent positions (AI checks this via calculatePositionSize)
    max_open_trades = 6

    # Short trading: enabled for futures mode
    can_short = True

    # Execution timeframe — 5m aligns with AI heartbeat cycle
    timeframe = "5m"

    # Minimal ROI - disabled (AI manages exits via TradePlan)
    minimal_roi = {"0": 100}

    # Trailing stop - disabled (TradeManager handles trailing via updateTradePlan)
    trailing_stop = False

    # Allow unlimited open orders per trade (needed for TradeManager TP/SL placement)
    # Note: Freqtrade default is 1, which blocks multi-TP. Set to -1 for unlimited.
    max_entry_position_adjustment = -1

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Calculate technical indicators for AI context.

        These indicators are available in Freqtrade's internal dataframe.
        The AI also calculates indicators independently from Binance OHLCV,
        but having them here ensures Freqtrade's own analysis is consistent.
        """
        # === Trend Detection ===
        # EMA trio — AI uses EMA9/21/55 crossover for regime classification
        dataframe["ema9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema55"] = ta.EMA(dataframe, timeperiod=55)

        # SMA 200 — long-term trend filter
        dataframe["sma200"] = ta.SMA(dataframe, timeperiod=200)

        # === Momentum ===
        # RSI — overbought/oversold detection
        dataframe["rsi14"] = ta.RSI(dataframe, timeperiod=14)

        # MACD — momentum direction + divergence
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["macd"] = macd["macd"]
        dataframe["macd_signal"] = macd["macdsignal"]
        dataframe["macd_hist"] = macd["macdhist"]

        # === Volatility ===
        # ATR — position sizing, SL distance calculation
        dataframe["atr14"] = ta.ATR(dataframe, timeperiod=14)

        # Bollinger Bands — volatility squeeze / breakout detection
        bb = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_upper"] = bb["upperband"]
        dataframe["bb_middle"] = bb["middleband"]
        dataframe["bb_lower"] = bb["lowerband"]
        # BB width — low width = squeeze = potential breakout
        dataframe["bb_width"] = (dataframe["bb_upper"] - dataframe["bb_lower"]) / dataframe["bb_middle"]

        # === Volume ===
        # Volume SMA — volume confirmation for breakouts
        dataframe["volume_sma20"] = ta.SMA(dataframe["volume"], timeperiod=20)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """Never enter autonomously — all entries via AI forceentry."""
        dataframe["enter_long"] = 0
        dataframe["enter_short"] = 0
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """Never exit autonomously — all exits via AI forceexit / TradeManager."""
        dataframe["exit_long"] = 0
        dataframe["exit_short"] = 0
        return dataframe
