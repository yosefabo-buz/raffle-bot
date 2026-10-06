const { Bot, InlineKeyboard, InputFile } = require("grammy");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PRICE = process.env.PRICE || "100 birr";
const PAYMENT_INFO = process.env.PAYMENT_INFO || "Payment info not set";
const MAX_NUMBER = Number(process.env.MAX_NUMBER || 100);
const DB_FILE = "data.json";

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { entries: [], requests: {} }; }
}
function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const bot = new Bot(BOT_TOKEN);
const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;

bot.command("myid", (ctx) => ctx.reply("Your ID: " + ctx.from.id));

bot.command("start", (ctx) =>
  ctx.reply(
    "Welcome! Ticket price: " + PRICE + "\n\n" + PAYMENT_INFO +
    "\n\nAfter paying, send your payment screenshot or transaction ID here."
  )
);

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const db = load();
  if (!db.entries.length) return ctx.reply("No entries yet.");
  const lines = db.entries.map((e) => "#" + e.number + " - " + e.name);
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
  const db = load();
  const id = String(Date.now());
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  db.requests[id] = {
    userId: ctx.from.id, name, username: ctx.from.username || "", status: "pending",
  };
  save(db);

  await ctx.api.copyMessage(ADMIN_ID, ctx.chat.id, ctx.message.message_id);
  const kb = new InlineKeyboard()
    .text("✅ Approve", "ok:" + id)
    .text("❌ Reject", "no:" + id);
  await ctx.api.sendMessage(
    ADMIN_ID,
    "Payment from: " + name + (ctx.from.username ? " (@" + ctx.from.username + ")" : ""),
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

  if (action === "no") {
    req.status = "rejected";
    save(db);
    await ctx.api.sendMessage(req.userId, "Sorry, we could not verify your payment. Please contact us.");
    await ctx.editMessageText(oldText + "\n❌ Rejected");
    return ctx.answerCallbackQuery();
  }

  const used = new Set(db.entries.map((e) => e.number));
  const free = [];
  for (let n = 1; n <= MAX_NUMBER; n++) if (!used.has(n)) free.push(n);
  if (!free.length) return ctx.answerCallbackQuery({ text: "All numbers taken!" });

  const number = free[Math.floor(Math.random() * free.length)];
  req.status = "approved";
  db.entries.push({ number, name: req.name, username: req.username, userId: req.userId });
  save(db);
  await ctx.api.sendMessage(req.userId, "✅ Payment verified! Your lucky number is: " + number + " 🍀");
  await ctx.editMessageText(oldText + "\n✅ Approved: #" + number);
  await ctx.answerCallbackQuery();
});

bot.start();
