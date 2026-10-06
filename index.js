const { Bot, InlineKeyboard, InputFile } = require("grammy");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PRICE = process.env.PRICE || "100 birr";
const PAYMENT_INFO = process.env.PAYMENT_INFO || "Payment info not set";
const MAX_NUMBER = Number(process.env.MAX_NUMBER || 100);
const DB_FILE = "data.json";

function load() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { db = {}; }
  db.entries = db.entries || [];
  db.requests = db.requests || {};
  db.users = db.users || {};
  return db;
}
function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// numbers that are approved OR currently held by someone
function takenSet(db) {
  const s = new Set(db.entries.map((e) => e.number));
  for (const u of Object.values(db.users)) {
    if (u.number && (u.step === "proof" || u.step === "pending")) s.add(u.number);
  }
  return s;
}
function freeNumbers(db) {
  const t = takenSet(db);
  const f = [];
  for (let n = 1; n <= MAX_NUMBER; n++) if (!t.has(n)) f.push(n);
  return f;
}

const bot = new Bot(BOT_TOKEN);
const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;

bot.command("myid", (ctx) => ctx.reply("Your ID: " + ctx.from.id));

bot.command("start", (ctx) => {
  if (isAdmin(ctx)) return ctx.reply("Admin commands: /list /export /numbers");
  const db = load();
  const u = db.users[ctx.from.id];
  if (!u || u.step !== "pending") {
    db.users[ctx.from.id] = { step: "choose", number: null };
    save(db);
  }
  return ctx.reply(
    "Welcome! Ticket price: " + PRICE +
    "\n\nSend the lucky number you want (1 to " + MAX_NUMBER + ")." +
    "\nUse /numbers to see the available numbers."
  );
});

bot.command("numbers", async (ctx) => {
  const db = load();
  const f = freeNumbers(db);
  if (!f.length) return ctx.reply("All numbers are taken.");
  return ctx.reply("Available numbers:\n" + f.join(", "));
});

bot.command("change", (ctx) => {
  if (isAdmin(ctx)) return;
  const db = load();
  const u = db.users[ctx.from.id];
  if (u && u.step === "pending") {
    return ctx.reply("Your payment is being checked. Please wait.");
  }
  db.users[ctx.from.id] = { step: "choose", number: null };
  save(db);
  return ctx.reply("OK. Send the new number you want.");
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const db = load();
  if (!db.entries.length) return ctx.reply("No entries yet.");
  const lines = db.entries
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((e) => "#" + e.number + " - " + e.name);
  for (let i = 0; i < lines.length; i += 50) {
    await ctx.reply(lines.slice(i, i + 50).join("\n"));
  }
});

bot.command("export", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const db = load();
  const csv = "number,name,username\n" + db.entries
    .map((e) => [e.number, '"' + e.name + '"', e.username || ""].join(","))
    .join("\n");
  await ctx.replyWithDocument(new InputFile(Buffer.from(csv), "raffle.csv"));
});

bot.on("message", async (ctx) => {
  if (isAdmin(ctx)) return;
  if (ctx.message.text && ctx.message.text.startsWith("/")) return;

  const db = load();
  const uid = ctx.from.id;
  const u = db.users[uid] || { step: "choose", number: null };
  db.users[uid] = u;

  // STEP 1: choose a number
  if (u.step === "choose") {
    const text = (ctx.message.text || "").trim();
    if (!/^\d+$/.test(text)) {
      return ctx.reply("Please send the lucky number you want (1 to " + MAX_NUMBER + ").");
    }
    const n = Number(text);
    if (n < 1 || n > MAX_NUMBER) {
      return ctx.reply("Please choose a number from 1 to " + MAX_NUMBER + ".");
    }
    if (takenSet(db).has(n)) {
      return ctx.reply("Sorry, number " + n + " is already taken. Send another number or use /numbers.");
    }
    u.number = n;
    u.step = "proof";
    save(db);
    return ctx.reply(
      "Number " + n + " is reserved for you.\n\n" +
      "Price: " + PRICE + "\n" + PAYMENT_INFO +
      "\n\nAfter paying, send your payment screenshot or transaction ID here." +
      "\nTo pick a different number, send /change"
    );
  }

  // STEP 3: waiting for admin
  if (u.step === "pending") {
    return ctx.reply("Your payment is being checked. Please wait.");
  }

  // STEP 2: payment proof
  const id = String(Date.now());
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  db.requests[id] = {
    userId: uid, name, username: ctx.from.username || "",
    number: u.number, status: "pending",
  };
  u.step = "pending";
  save(db);

  await ctx.api.copyMessage(ADMIN_ID, ctx.chat.id, ctx.message.message_id);
  const kb = new InlineKeyboard()
    .text("✅ Approve", "ok:" + id)
    .text("❌ Reject", "no:" + id);
  await ctx.api.sendMessage(
    ADMIN_ID,
    "Payment from: " + name + (ctx.from.username ? " (@" + ctx.from.username + ")" : "") +
    "\nWants number: #" + u.number,
    { reply_markup: kb }
  );
  await ctx.reply("Received! Please wait while we verify your payment.");
});

bot.on("callback_query:data", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const [action, id] = ctx.callbackQuery.data.split(":");
  const db = load();
  const req = db.requests[id];
  if (!req || req.status !== "pending") {
    return ctx.answerCallbackQuery({ text: "Already handled." });
  }
  const oldText = ctx.callbackQuery.message.text;
  const user = db.users[req.userId] || {};

  if (action === "no") {
    req.status = "rejected";
    user.step = "choose";
    user.number = null;
    db.users[req.userId] = user;
    save(db);
    await ctx.api.sendMessage(
      req.userId,
      "Sorry, we could not verify your payment, and your number was released. Send /start to try again or contact us."
    );
    await ctx.editMessageText(oldText + "\n❌ Rejected");
    return ctx.answerCallbackQuery();
  }

  req.status = "approved";
  db.entries.push({
    number: req.number, name: req.name,
    username: req.username, userId: req.userId,
  });
  user.step = "choose";
  user.number = null;
  db.users[req.userId] = user;
  save(db);
  await ctx.api.sendMessage(
    req.userId,
    "✅ Payment verified! Your lucky number is: " + req.number + " 🍀\nTo buy another number, send /start"
  );
  await ctx.editMessageText(oldText + "\n✅ Approved");
  await ctx.answerCallbackQuery();
});

bot.start();
