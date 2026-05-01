require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ─────────────────────────────
// CRASH 방지 (핵심)
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
// SAFE STORAGE (핵심 안정화)
// ─────────────────────────────
const DB = {
  players: new Map(),
  battles: new Map(),
};

// ─────────────────────────────
// CHAR + SYSTEM
// ─────────────────────────────
const CHAR = {
  itadori: { name: "이타도리", atk: 85, hp: 1200, reversal: false },
  gojo: { name: "고죠", atk: 120, hp: 2000, reversal: true },
  sukuna: { name: "스쿠나", atk: 130, hp: 2200, reversal: false },
};

const TOOLS = {
  none: { atk: 0 },
  katana: { atk: 15 },
  spear: { atk: 25 },
};

// ─────────────────────────────
// SAFE FUNCTIONS (CRASH 방지 핵심)
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
  if (!DB.battles.has(id)) return null;
  return DB.battles.get(id);
}

// ─────────────────────────────
// DAMAGE SAFE
// ─────────────────────────────
function calc(atk, toolAtk) {
  try {
    let dmg = atk + toolAtk;

    const bf = Math.random() < 0.1;
    if (bf) dmg *= 2.5;

    return { dmg: Math.floor(dmg), bf };
  } catch {
    return { dmg: 1, bf: false };
  }
}

// ─────────────────────────────
// MESSAGE SYSTEM
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    const p = getPlayer(msg.author.id);
    const char = CHAR[p.char];
    const tool = TOOLS[p.tool] || TOOLS.none;

    // ⚔️ 전투 시작
    if (msg.content === "!전투") {
      DB.battles.set(msg.author.id, {
        enemy: { hp: 800 },
        cd: 0,
      });

      return msg.reply("⚔️ 전투 시작!");
    }

    const b = getBattle(msg.author.id);

    // ─────────────────────────
    // SAFE NULL BLOCK (핵심)
    // ─────────────────────────
    if (!b) {
      // 전투 아닐 때만 일반 명령 가능
      if (msg.content === "!가챠") {
        const pool = ["itadori", "gojo", "sukuna"];
        const r = pool[Math.floor(Math.random() * pool.length)];

        p.char = r;
        p.hp = CHAR[r].hp;

        return msg.reply(`🎲 ${CHAR[r].name}`);
      }

      if (msg.content === "!랭킹") {
        const list = [...DB.players.values()]
          .sort((a, b) => (b.xp || 0) - (a.xp || 0))
          .slice(0, 5);

        return msg.reply(
          list.map((u, i) => `${i + 1}. <@${u.id}> (${u.xp})`).join("\n")
        );
      }

      return;
    }

    // ─────────────────────────
    // TURN SYSTEM SAFE
    // ─────────────────────────

    if (msg.content === "!공격") {
      const r = calc(char.atk, tool.atk);
      b.enemy.hp -= r.dmg;

      return msg.reply(r.bf ? `⚡ 흑섬 ${r.dmg}` : `👊 ${r.dmg}`);
    }

    if (msg.content === "!술식") {
      if (b.cd > 0) return msg.reply("쿨타임");

      const r = calc(char.atk * 2, tool.atk);
      b.enemy.hp -= r.dmg;
      b.cd = 3;

      return msg.reply(`✨ ${r.dmg}`);
    }

    if (msg.content === "!회복") {
      if (!char.reversal) return msg.reply("불가");

      p.hp += 200;
      return msg.reply("💚 +200");
    }

    if (msg.content === "!도주") {
      DB.battles.delete(msg.author.id);
      return msg.reply("🏃 도주");
    }

    // ─────────────────────────
    // WIN CHECK SAFE
    // ─────────────────────────
    if (b.enemy.hp <= 0) {
      p.xp += 100;
      p.crystals += 80;

      DB.battles.delete(msg.author.id);

      return msg.reply("🏆 승리!");
    }
  } catch (e) {
    console.log("SAFE ERROR:", e);
  }
});

// ─────────────────────────────
// READY
// ─────────────────────────────
client.once("ready", () => {
  console.log(`✅ ONLINE ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
