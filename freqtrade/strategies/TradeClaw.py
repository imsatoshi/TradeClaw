"""
TradeClaw - Thin strategy for AI-driven trading via Freqtrade.

All entry/exit decisions are made by the AI agent through forceentry/forceexit.
This strategy never generates buy/sell signals on its own.
AI is the sole risk manager — no hard stoploss safety net.
"""

import talib.abstract as ta
from freqtrade.strategy.interface import IStrategy
from pandas import DataFrame


class TradeClaw(IStrategy):
    INTERFACE_VERSION = 3

    # Disabled — AI is the sole risk manager for SL/TP
    stoploss = -0.99

    # Max concurrent positions (AI respects this via calculatePositionSize)
    max_open_trades = 6

    # Short trading: enabled for futures mode
    can_short = True

    # Execution timeframe — 15m aligns with AI heartbeat cycle
    timeframe = "15m"

    # Minimal ROI - disabled (AI manages exits)
    minimal_roi = {"0": 100}

    # Trailing stop - disabled (AI manages exits)
    trailing_stop = False

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """Calculate only the basic indicators the AI needs for context."""
        # EMA trio for trend detection
        dataframe["ema9"] = ta.EMA(dataframe, timeperiod=9)
        dataframe["ema21"] = ta.EMA(dataframe, timeperiod=21)
        dataframe["ema55"] = ta.EMA(dataframe, timeperiod=55)

        # RSI for momentum
        dataframe["rsi14"] = ta.RSI(dataframe, timeperiod=14)

        # ATR for volatility / position sizing
        dataframe["atr14"] = ta.ATR(dataframe, timeperiod=14)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """Never enter autonomously - all entries via AI forceentry."""
        dataframe["enter_long"] = 0
        dataframe["enter_short"] = 0
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """Never exit autonomously - all exits via AI forceexit (hard stoploss still fires)."""
        dataframe["exit_long"] = 0
        dataframe["exit_short"] = 0
        return dataframe
