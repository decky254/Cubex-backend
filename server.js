import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

/**
 * =========================
 * APP SETUP
 * =========================
 */
const app = express();

app.use(cors());
app.use(express.json());

/**
 * =========================
 * ENV VARIABLES
 * =========================
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is required.");
}

if (!supabaseKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
}

/**
 * =========================
 * SUPABASE CLIENT
 * =========================
 */
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * =========================
 * AUTO WALLET CREATION
 * =========================
 */
async function ensureWallet(user_id) {
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw error;

  // Create wallet if missing
  if (!data) {
    const { data: newWallet, error: createError } = await supabase
      .from("wallets")
      .insert([
        {
          user_id,
          balance: 0
        }
      ])
      .select()
      .single();

    if (createError) throw createError;

    return newWallet;
  }

  return data;
}

/**
 * =========================
 * LIVE MARKET PRICE
 * BTC TEST FEED
 * =========================
 */
async function getPrice() {
  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
    );

    const data = await response.json();

    return Number(data.price);
  } catch (err) {
    console.log("Price feed error:", err.message);

    // fallback test price
    return 100000;
  }
}

/**
 * =========================
 * PNL CALCULATION
 * =========================
 */
function calculatePnL(trade, currentPrice) {
  const entry = Number(trade.entry_price);
  const units = Number(trade.units);

  if (trade.direction === "buy") {
    return (currentPrice - entry) * units;
  } else {
    return (entry - currentPrice) * units;
  }
}

/**
 * =========================
 * CLOSE TRADE
 * =========================
 */
async function closeTrade(trade, reason, currentPrice) {
  try {
    const pnl = calculatePnL(trade, currentPrice);

    /**
     * GET USER WALLET
     */
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", trade.user_id)
      .maybeSingle();

    if (walletError) {
      console.log(walletError);
      return;
    }

    /**
     * RETURN ORIGINAL STAKE + PNL
     */
    const settlement =
      Number(wallet.balance) +
      Number(trade.amount) +
      Number(pnl);

    /**
     * UPDATE WALLET
     */
    await supabase
      .from("wallets")
      .update({
        balance: settlement
      })
      .eq("user_id", trade.user_id);

    /**
     * CLOSE TRADE
     */
    await supabase
      .from("trades")
      .update({
        status: "closed",
        pnl,
        close_price: currentPrice,
        close_reason: reason,
        is_locked: false
      })
      .eq("id", trade.id);

    console.log(
      `Trade closed: ${trade.id} | Reason: ${reason}`
    );

  } catch (err) {
    console.log("Close trade error:", err.message);
  }
}

/**
 * =========================
 * LIVE TRADING ENGINE
 * =========================
 */
async function updatePnL() {
  try {
    const currentPrice = await getPrice();

    /**
     * GET OPEN TRADES
     */
    const { data: trades, error } = await supabase
      .from("trades")
      .select("*")
      .eq("status", "open");

    if (error) {
      console.log(error);
      return;
    }

    if (!trades || trades.length === 0) {
      return;
    }

    /**
     * PROCESS EACH TRADE
     */
    for (let trade of trades) {
      const pnl = calculatePnL(trade, currentPrice);

      /**
       * UPDATE LIVE PNL
       */
      await supabase
        .from("trades")
        .update({
          pnl
        })
        .eq("id", trade.id);

      /**
       * TP / SL LEVELS
       */
      const entry = Number(trade.entry_price);
      const units = Number(trade.units);

      let tpLevel;
      let slLevel;

      if (trade.direction === "buy") {
        tpLevel =
          entry +
          (Number(trade.take_profit) / units);

        slLevel =
          entry -
          (Number(trade.stop_loss) / units);
      } else {
        tpLevel =
          entry -
          (Number(trade.take_profit) / units);

        slLevel =
          entry +
          (Number(trade.stop_loss) / units);
      }

      /**
       * TAKE PROFIT HIT
       */
      if (
        (trade.direction === "buy" &&
          currentPrice >= tpLevel) ||

        (trade.direction === "sell" &&
          currentPrice <= tpLevel)
      ) {
        await closeTrade(
          trade,
          "TAKE_PROFIT",
          currentPrice
        );

        continue;
      }

      /**
       * STOP LOSS HIT
       */
      if (
        (trade.direction === "buy" &&
          currentPrice <= slLevel) ||

        (trade.direction === "sell" &&
          currentPrice >= slLevel)
      ) {
        await closeTrade(
          trade,
          "STOP_LOSS",
          currentPrice
        );

        continue;
      }

      /**
       * LOCK EXPIRY
       */
      if (
        trade.lock_expires_at &&
        new Date(trade.lock_expires_at) <= new Date()
      ) {
        await closeTrade(
          trade,
          "LOCK_EXPIRED",
          currentPrice
        );
      }
    }

  } catch (err) {
    console.log("PnL engine error:", err.message);
  }
}

/**
 * =========================
 * AUTO UNLOCK ENGINE
 * =========================
 */
async function unlockTrades() {
  try {
    const now = new Date();

    const { data: trades, error } = await supabase
      .from("trades")
      .select("*")
      .eq("is_locked", true);

    if (error) {
      console.log(error);
      return;
    }

    if (!trades) return;

    for (let trade of trades) {
      if (
        trade.lock_expires_at &&
        new Date(trade.lock_expires_at) <= now
      ) {
        await supabase
          .from("trades")
          .update({
            is_locked: false
          })
          .eq("id", trade.id);
      }
    }

  } catch (err) {
    console.log("Unlock engine error:", err.message);
  }
}

/**
 * =========================
 * TEST ROUTE
 * =========================
 */
app.get("/", (req, res) => {
  res.send("🚀 CubeX Trading Engine Running");
});

/**
 * =========================
 * GET WALLET
 * =========================
 */
app.get("/api/wallet/:user_id", async (req, res) => {
  try {
    const wallet = await ensureWallet(
      req.params.user_id
    );

    res.json(wallet);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

/**
 * =========================
 * APP SETUP
 * =========================
 */
const app = express();

app.use(cors());
app.use(express.json());

/**
 * =========================
 * ENV VARIABLES
 * =========================
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is required.");
}

if (!supabaseKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
}

/**
 * =========================
 * SUPABASE CLIENT
 * =========================
 */
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * =========================
 * AUTO WALLET CREATION
 * =========================
 */
async function ensureWallet(user_id) {
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw error;

  // Create wallet if missing
  if (!data) {
    const { data: newWallet, error: createError } = await supabase
      .from("wallets")
      .insert([
        {
          user_id,
          balance: 0
        }
      ])
      .select()
      .single();

    if (createError) throw createError;

    return newWallet;
  }

  return data;
}

/**
 * =========================
 * LIVE MARKET PRICE
 * BTC TEST FEED
 * =========================
 */
async function getPrice() {
  try {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
    );

    const data = await response.json();

    return Number(data.price);
  } catch (err) {
    console.log("Price feed error:", err.message);

    // fallback test price
    return 100000;
  }
}

/**
 * =========================
 * PNL CALCULATION
 * =========================
 */
function calculatePnL(trade, currentPrice) {
  const entry = Number(trade.entry_price);
  const units = Number(trade.units);

  if (trade.direction === "buy") {
    return (currentPrice - entry) * units;
  } else {
    return (entry - currentPrice) * units;
  }
}

/**
 * =========================
 * CLOSE TRADE
 * =========================
 */
async function closeTrade(trade, reason, currentPrice) {
  try {
    const pnl = calculatePnL(trade, currentPrice);

    /**
     * GET USER WALLET
     */
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", trade.user_id)
      .maybeSingle();

    if (walletError) {
      console.log(walletError);
      return;
    }

    /**
     * RETURN ORIGINAL STAKE + PNL
     */
    const settlement =
      Number(wallet.balance) +
      Number(trade.amount) +
      Number(pnl);

    /**
     * UPDATE WALLET
     */
    await supabase
      .from("wallets")
      .update({
        balance: settlement
      })
      .eq("user_id", trade.user_id);

    /**
     * CLOSE TRADE
     */
    await supabase
      .from("trades")
      .update({
        status: "closed",
        pnl,
        close_price: currentPrice,
        close_reason: reason,
        is_locked: false
      })
      .eq("id", trade.id);

    console.log(
      `Trade closed: ${trade.id} | Reason: ${reason}`
    );

  } catch (err) {
    console.log("Close trade error:", err.message);
  }
}

/**
 * =========================
 * LIVE TRADING ENGINE
 * =========================
 */
async function updatePnL() {
  try {
    const currentPrice = await getPrice();

    /**
     * GET OPEN TRADES
     */
    const { data: trades, error } = await supabase
      .from("trades")
      .select("*")
      .eq("status", "open");

    if (error) {
      console.log(error);
      return;
    }

    if (!trades || trades.length === 0) {
      return;
    }

    /**
     * PROCESS EACH TRADE
     */
    for (let trade of trades) {
      const pnl = calculatePnL(trade, currentPrice);

      /**
       * UPDATE LIVE PNL
       */
      await supabase
        .from("trades")
        .update({
          pnl
        })
        .eq("id", trade.id);

      /**
       * TP / SL LEVELS
       */
      const entry = Number(trade.entry_price);
      const units = Number(trade.units);

      let tpLevel;
      let slLevel;

      if (trade.direction === "buy") {
        tpLevel =
          entry +
          (Number(trade.take_profit) / units);

        slLevel =
          entry -
          (Number(trade.stop_loss) / units);
      } else {
        tpLevel =
          entry -
          (Number(trade.take_profit) / units);

        slLevel =
          entry +
          (Number(trade.stop_loss) / units);
      }

      /**
       * TAKE PROFIT HIT
       */
      if (
        (trade.direction === "buy" &&
          currentPrice >= tpLevel) ||

        (trade.direction === "sell" &&
          currentPrice <= tpLevel)
      ) {
        await closeTrade(
          trade,
          "TAKE_PROFIT",
          currentPrice
        );

        continue;
      }

      /**
       * STOP LOSS HIT
       */
      if (
        (trade.direction === "buy" &&
          currentPrice <= slLevel) ||

        (trade.direction === "sell" &&
          currentPrice >= slLevel)
      ) {
        await closeTrade(
          trade,
          "STOP_LOSS",
          currentPrice
        );

        continue;
      }

      /**
       * LOCK EXPIRY
       */
      if (
        trade.lock_expires_at &&
        new Date(trade.lock_expires_at) <= new Date()
      ) {
        await closeTrade(
          trade,
          "LOCK_EXPIRED",
          currentPrice
        );
      }
    }

  } catch (err) {
    console.log("PnL engine error:", err.message);
  }
}

/**
 * =========================
 * AUTO UNLOCK ENGINE
 * =========================
 */
async function unlockTrades() {
  try {
    const now = new Date();

    const { data: trades, error } = await supabase
      .from("trades")
      .select("*")
      .eq("is_locked", true);

    if (error) {
      console.log(error);
      return;
    }

    if (!trades) return;

    for (let trade of trades) {
      if (
        trade.lock_expires_at &&
        new Date(trade.lock_expires_at) <= now
      ) {
        await supabase
          .from("trades")
          .update({
            is_locked: false
          })
          .eq("id", trade.id);
      }
    }

  } catch (err) {
    console.log("Unlock engine error:", err.message);
  }
}

/**
 * =========================
 * TEST ROUTE
 * =========================
 */
app.get("/", (req, res) => {
  res.send("🚀 CubeX Trading Engine Running");
});

/**
 * =========================
 * GET WALLET
 * =========================
 */
app.get("/api/wallet/:user_id", async (req, res) => {
  try {
    const wallet = await ensureWallet(
      req.params.user_id
    );

    res.json(wallet);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * =========================
 * GET USER TRADES
 * =========================
 */
app.get("/api/trades/:user_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", req.params.user_id)
      .order("created_at", {
        ascending: false
      });

    if (error) {
      return res.status(400).json(error);
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * =========================
 * PLACE TRADE
 * =========================
 */
app.post("/api/trade", async (req, res) => {
  try {
    const {
      user_id,
      pair,
      amount,
      direction,
      units,
      take_profit,
      stop_loss,
      lock_duration_days
    } = req.body;

    /**
     * VALIDATION
     */
    if (
      !user_id ||
      !pair ||
      !amount ||
      !direction ||
      !units
    ) {
      return res.status(400).json({
        error: "Missing required fields"
      });
    }

    /**
     * ENSURE WALLET EXISTS
     */
    const wallet = await ensureWallet(user_id);

    /**
     * BALANCE CHECK
     */
    if (
      Number(wallet.balance) < Number(amount)
    ) {
      return res.status(400).json({
        error: "Insufficient balance"
      });
    }

    /**
     * DEDUCT BALANCE
     */
    const newBalance =
      Number(wallet.balance) -
      Number(amount);

    await supabase
      .from("wallets")
      .update({
        balance: newBalance
      })
      .eq("user_id", user_id);

    /**
     * REAL ENTRY PRICE
     */
    const entryPrice = await getPrice();

    /**
     * LOCK EXPIRY
     */
    const expiry = new Date();

    expiry.setDate(
      expiry.getDate() +
      Number(lock_duration_days || 7)
    );

    /**
     * CREATE TRADE
     */
    const { data, error } = await supabase
      .from("trades")
      .insert([
        {
          user_id,
          pair,
          amount,
          direction,
          units,
          take_profit,
          stop_loss,

          lock_duration_days:
            lock_duration_days || 7,

          lock_expires_at:
            expiry.toISOString(),

          is_locked: true,

          entry_price: entryPrice,

          pnl: 0,

          status: "open",

          execution_type: "locked"
        }
      ])
      .select();

    if (error) {
      return res.status(400).json(error);
    }

    res.json({
      success: true,
      message: "Trade opened successfully",
      wallet_balance: newBalance,
      trade: data
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * =========================
 * ADMIN BALANCE UPDATE
 * =========================
 */
app.post(
  "/api/admin/balance",
  async (req, res) => {
    try {
      const { user_id, amount } = req.body;

      const { error } = await supabase
        .from("wallets")
        .update({
          balance: amount
        })
        .eq("user_id", user_id);

      if (error) {
        return res.status(400).json(error);
      }

      res.json({
        success: true
      });

    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  }
);

/**
 * =========================
 * BACKGROUND ENGINES
 * =========================
 */

// Live pnl updates
setInterval(updatePnL, 5000);

// Unlock checker
setInterval(unlockTrades, 60000);

/**
 * =========================
 * START SERVER
 * =========================
 */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `🚀 CubeX Engine running on port ${PORT}`
  );
});  }
});

/**
 * =========================
 * GET USER TRADES
 * =========================
 */
app.get("/api/trades/:user_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", req.params.user_id)
      .order("created_at", {
        ascending: false
      });

    if (error) {
      return res.status(400).json(error);
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * =========================
 * PLACE TRADE
 * =========================
 */
app.post("/api/trade", async (req, res) => {
  try {
    const {
      user_id,
      pair,
      amount,
      direction,
      units,
      take_profit,
      stop_loss,
      lock_duration_days
    } = req.body;

    /**
     * VALIDATION
     */
    if (
      !user_id ||
      !pair ||
      !amount ||
      !direction ||
      !units
    ) {
      return res.status(400).json({
        error: "Missing required fields"
      });
    }

    /**
     * ENSURE WALLET EXISTS
     */
    const wallet = await ensureWallet(user_id);

    /**
     * BALANCE CHECK
     */
    if (
      Number(wallet.balance) < Number(amount)
    ) {
      return res.status(400).json({
        error: "Insufficient balance"
      });
    }

    /**
     * DEDUCT BALANCE
     */
    const newBalance =
      Number(wallet.balance) -
      Number(amount);

    await supabase
      .from("wallets")
      .update({
        balance: newBalance
      })
      .eq("user_id", user_id);

    /**
     * REAL ENTRY PRICE
     */
    const entryPrice = await getPrice();

    /**
     * LOCK EXPIRY
     */
    const expiry = new Date();

    expiry.setDate(
      expiry.getDate() +
      Number(lock_duration_days || 7)
    );

