import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/**
 * ENV CHECK
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("SUPABASE_URL is required.");
if (!supabaseKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * =========================
 * WALLET AUTO CREATION
 * =========================
 */
async function ensureWallet(user_id) {
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { data: newWallet, error: createError } = await supabase
      .from("wallets")
      .insert([{ user_id, balance: 0 }])
      .select()
      .single();

    if (createError) throw createError;
    return newWallet;
  }

  return data;
}

/**
 * =========================
 * PRICE FEED (BTC TEST)
 * =========================
 */
async function getPrice() {
  const res = await fetch(
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
  );
  const data = await res.json();
  return Number(data.price);
}

/**
 * =========================
 * PNL CALCULATION
 * =========================
 */
function calculatePnL(trade, price) {
  if (trade.direction === "buy") {
    return (price - trade.entry_price) * trade.units;
  } else {
    return (trade.entry_price - price) * trade.units;
  }
}

/**
 * =========================
 * LIVE PNL ENGINE
 * =========================
 */
async function updatePnL() {
  const price = await getPrice();

  const { data: trades } = await supabase
    .from("trades")
    .select("*")
    .eq("status", "open");

  if (!trades) return;

  for (let trade of trades) {
    const pnl = calculatePnL(trade, price);

    await supabase
      .from("trades")
      .update({ pnl })
      .eq("id", trade.id);
  }
}

/**
 * =========================
 * AUTO UNLOCK ENGINE
 * =========================
 */
async function unlockTrades() {
  const now = new Date();

  const { data: trades } = await supabase
    .from("trades")
    .select("*")
    .eq("is_locked", true);

  if (!trades) return;

  for (let trade of trades) {
    if (new Date(trade.lock_expires_at) <= now) {
      await supabase
        .from("trades")
        .update({ is_locked: false })
        .eq("id", trade.id);
    }
  }
}

/**
 * =========================
 * ROUTES
 * =========================
 */

app.get("/", (req, res) => {
  res.send("🚀 CubeX Trading Engine Running");
});

/**
 * WALLET
 */
app.get("/api/wallet/:user_id", async (req, res) => {
  try {
    const wallet = await ensureWallet(req.params.user_id);
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * TRADE WITH LOCK + TP/SL
 */
app.post("/api/trade", async (req, res) => {
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

  try {
    const wallet = await ensureWallet(user_id);

    if (Number(wallet.balance) < Number(amount)) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const newBalance = Number(wallet.balance) - Number(amount);

    await supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("user_id", user_id);

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + Number(lock_duration_days));

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
          lock_duration_days,
          lock_expires_at: expiry.toISOString(),
          is_locked: true,
          entry_price: 0,
          pnl: 0,
          status: "open",
          execution_type: "locked"
        }
      ])
      .select();

    if (error) return res.status(400).json(error);

    res.json({
      success: true,
      wallet_balance: newBalance,
      trade: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * TRADES
 */
app.get("/api/trades/:user_id", async (req, res) => {
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .eq("user_id", req.params.user_id);

  if (error) return res.status(400).json(error);
  res.json(data);
});

/**
 * =========================
 * BACKGROUND LOOPS
 * =========================
 */
setInterval(updatePnL, 5000);      // live pnl
setInterval(unlockTrades, 60000);  // unlock system

/**
 * START SERVER
 */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 CubeX Engine running on port ${PORT}`);
});
