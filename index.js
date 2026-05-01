require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ─────────────────────────────
// HARD CRASH BLOCK
// ─────────────────────────────
process.on("unhandledRejection", (e) => console.log("UR:", e));
process.on("uncaughtException", (e) => console.log("UCE:", e));

// ─────────────────────────────
// DISCORD
// ─────────────────────────────
const { Client, GatewayIntentBits } = require("discord.js");

if (!process.env.DISCORD_TOKEN) {
  console.log("NO TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─────────────────────────────
// SAFE MEMORY
// ─────────────────────────────
const DB = {
  players: new Map(),
  battles: new Map(),
};

// ─────────────────────────────
// SAFE GETTERS
// ─────────────────────────────
function getPlayer(id) {
  if (!DB.players.has(id)) {
    DB.players.set(id, {
      id,
      char: "itadori",
      hp: 1200,
      xp: 0,
      crystals: 500,
      tool: "none",
    });
  }
  return DB.players.get(id);
}

function getBattle(id) {
  return DB.battles.get(id) || null;
}

// ─────────────────────────────
// SAFE DAMAGE
// ─────────────────────────────
function damage(atk) {
  try {
    let d = atk;

    const bf = Math.random() < 0.1;
    if (bf) d *= 2.5;

    return { dmg: Math.floor(d), bf };
  } catch {
    return { dmg: 1, bf: false };
  }
}

// ─────────────────────────────
// COMMAND ROUTER (핵심 안정화)
// ─────────────────────────────
async function handleCommand(msg) {
  const p = getPlayer(msg.author.id);
  const b = getBattle(msg.author.id);

  // ───────────────
  // 전투 없는 명령
  // ───────────────
  if (!b) {
    if (msg.content === "!가챠") {
      const pool = ["itadori", "gojo", "sukuna"];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      p.char = pick;

      return msg.reply(`🎲 ${pick}`);
    }

    if (msg.content === "!랭킹") {
      const list = [...DB.players.values()]
        .sort((a, b) => (b.xp || 0) - (a.xp || 0))
        .slice(0, 5);

      return msg.reply(
        list.map((u, i) => `${i + 1}. <@${u.id}> (${u.xp})`).join("\n")
      );
    }

    if (msg.content === "!전투") {
      DB.battles.set(msg.author.id, {
        enemy: { hp: 800 },
        cd: 0,
      });

      return msg.reply("⚔️ 전투 시작!");
    }

    return;
  }

  // ───────────────
  // 전투 명령
  // ───────────────
  const charAtk = 85;

  if (msg.content === "!공격") {
    const r = damage(charAtk);
    b.enemy.hp -= r.dmg;

    return msg.reply(r.bf ? `⚡ 흑섬 ${r.dmg}` : `👊 ${r.dmg}`);
  }

  if (msg.content === "!술식") {
    if (b.cd > 0) return msg.reply("쿨타임");

    const r = damage(charAtk * 2);
    b.enemy.hp -= r.dmg;
    b.cd = 3;

    return msg.reply(`✨ ${r.dmg}`);
  }

  if (msg.content === "!도주") {
    DB.battles.delete(msg.author.id);
    return msg.reply("🏃 도주");
  }

  if (b.enemy.hp <= 0) {
    p.xp += 100;
    p.crystals += 80;

    DB.battles.delete(msg.author.id);

    return msg.reply("🏆 승리!");
  }
}

// ─────────────────────────────
// MESSAGE WRAPPER (CRASH 방지 핵심)
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    await handleCommand(msg);
  } catch (e) {
    console.log("SAFE ROUTE ERROR:", e);
  }
});

// ─────────────────────────────
// READY
// ─────────────────────────────
client.once("ready", () => {
  console.log(`✅ ONLINE ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
