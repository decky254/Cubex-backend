import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

/**
 * Debug ENV (helps confirm Render is working)
 */
console.log("SUPABASE_URL LOADED:", !!process.env.SUPABASE_URL);
console.log("SUPABASE_SERVICE_ROLE_KEY LOADED:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Supabase Client
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("SUPABASE_URL is required.");
if (!supabaseKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * TEST ROUTE
 */
app.get("/", (req, res) => {
  res.send("CubeX Backend Running 🚀");
});

/**
 * GET WALLET
 */
app.get("/api/wallet/:user_id", async (req, res) => {
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", req.params.user_id)
    .single();

  if (error) return res.status(400).json(error);

  res.json(data);
});

/**
 * GET TRADES
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
 * PLACE TRADE (FIXED INSERT + WALLET SAFETY)
 */
app.post("/api/trade", async (req, res) => {
  const { user_id, pair, amount, direction } = req.body;

  // GET WALLET
  const { data: wallet, error: walletError } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user_id)
    .single();

  if (walletError) return res.status(400).json(walletError);

  if (!wallet || Number(wallet.balance) < Number(amount)) {
    return res.status(400).json({
      error: "Insufficient balance"
    });
  }

  // UPDATE BALANCE (SAFE MATH)
  const newBalance = Number(wallet.balance) - Number(amount);

  const { error: updateError } = await supabase
    .from("wallets")
    .update({ balance: newBalance })
    .eq("user_id", user_id);

  if (updateError) return res.status(400).json(updateError);

  // INSERT TRADE (FIXED .select())
  const { data, error } = await supabase
    .from("trades")
    .insert([
      {
        user_id,
        pair,
        amount,
        direction,
        entry_price: 0,
        pnl: 0,
        status: "open",
        execution_type: "instant"
      }
    ])
    .select();

  if (error) return res.status(400).json(error);

  res.json({
    success: true,
    trade: data
  });
});

/**
 * WITHHELD TRADE
 */
app.post("/api/trade/withheld", async (req, res) => {
  const { user_id, pair, amount, direction, trigger_price } = req.body;

  const { data, error } = await supabase
    .from("trades")
    .insert([
      {
        user_id,
        pair,
        amount,
        direction,
        entry_price: 0,
        pnl: 0,
        status: "pending",
        execution_type: "withheld",
        trigger_price
      }
    ])
    .select();

  if (error) return res.status(400).json(error);

  res.json({
    success: true,
    trade: data
  });
});

/**
 * ADMIN BALANCE UPDATE
 */
app.post("/api/admin/balance", async (req, res) => {
  const { user_id, amount } = req.body;

  const { error } = await supabase
    .from("wallets")
    .update({ balance: amount })
    .eq("user_id", user_id);

  if (error) return res.status(400).json(error);

  res.json({
    success: true
  });
});

/**
 * START SERVER
 */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`CubeX backend running on port ${PORT} 🚀`);
});

