import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// TEST ROUTE
app.get("/", (req, res) => {
  res.send("CubeX Backend Running 🚀");
});

// GET WALLET
app.get("/api/wallet/:user_id", async (req, res) => {
  const { data, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", req.params.user_id)
    .single();

  if (error) return res.status(400).json(error);

  res.json(data);
});

// GET TRADES
app.get("/api/trades/:user_id", async (req, res) => {
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .eq("user_id", req.params.user_id);

  if (error) return res.status(400).json(error);

  res.json(data);
});

// PLACE TRADE
app.post("/api/trade", async (req, res) => {
  const {
    user_id,
    pair,
    amount,
    direction
  } = req.body;

  // GET WALLET
  const { data: wallet } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user_id)
    .single();

  if (!wallet || wallet.balance < amount) {
    return res.status(400).json({
      error: "Insufficient balance"
    });
  }

  // UPDATE BALANCE
  await supabase
    .from("wallets")
    .update({
      balance: wallet.balance - amount
    })
    .eq("user_id", user_id);

  // SAVE TRADE
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
    ]);

  if (error) return res.status(400).json(error);

  res.json({
    success: true,
    trade: data
  });
});

// WITHHELD TRADE
app.post("/api/trade/withheld", async (req, res) => {
  const {
    user_id,
    pair,
    amount,
    direction,
    trigger_price
  } = req.body;

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
    ]);

  if (error) return res.status(400).json(error);

  res.json({
    success: true,
    trade: data
  });
});

// ADMIN BALANCE UPDATE
app.post("/api/admin/balance", async (req, res) => {
  const { user_id, amount } = req.body;

  const { error } = await supabase
    .from("wallets")
    .update({
      balance: amount
    })
    .eq("user_id", user_id);

  if (error) return res.status(400).json(error);

  res.json({
    success: true
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("CubeX backend running 🚀");
});
