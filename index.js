require("dotenv").config();

const express = require("express");
const app = express();

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ───────── SAFE GUARD ─────────
process.on("uncaughtException", console.log);
process.on("unhandledRejection", console.log);

// ───────── DISCORD ─────────
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) process.exit(1);

// ───────── DB ─────────
const DB = {
  players: {},
  battles: {},
  pvp: {},
};

// ───────── CHAR ─────────
const CHAR = {
  gojo: { name: "고죠", domain: "무량공처", skills: ["허식무라사키"] },
  sukuna: { name: "스쿠나", domain: "복마어주자", skills: ["참격"] },
  itadori: { name: "이타도리", domain: null, skills: ["돌진"] },
};

// ───────── PLAYER ─────────
function getPlayer(id) {
  if (!DB.players[id]) {
    DB.players[id] = {
      id,
      char: "itadori",
      hp: 1200,

      skillsCooldown: {},
      domainCooldown: 0,
    };
  }

  const p = DB.players[id];
  p.skillsCooldown ??= {};
  p.domainCooldown ??= 0;

  return p;
}

// ───────── DAMAGE ─────────
function dmg(x) {
  return Math.floor(x + Math.random() * 50);
}

// ───────── UI ─────────
function ui() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("atk").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("skill").setLabel("🌀 술식").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("domain").setLabel("🌌 영역").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  );
}

// ───────── MESSAGE ─────────
client.on("messageCreate", (msg) => {
  if (!msg || msg.author.bot) return;

  const p = getPlayer(msg.author.id);

  // ⚔ PvE 전투
  if (msg.content === "!전투") {
    DB.battles[msg.author.id] = { enemyHp: 1200, turn: msg.author.id };

    return msg.reply({
      content: "⚔️ 전투 시작",
      components: [ui()],
    });
  }

  // ⚔ PvP 시작
  if (msg.content.startsWith("!pvp")) {
    const t = msg.mentions.users.first();
    if (!t) return msg.reply("멘션 필요");

    DB.pvp[msg.author.id] = {
      a: msg.author.id,
      b: t.id,
      hp: {
        [msg.author.id]: 1200,
        [t.id]: 1200,
      },
      turn: msg.author.id,
    };

    return msg.reply("⚔️ PvP 시작");
  }
});

// ───────── BUTTON ─────────
client.on("interactionCreate", async (i) => {
  if (!i.isButton()) return;

  const p = getPlayer(i.user.id);
  const battle = DB.battles[i.user.id];
  const pvp = Object.values(DB.pvp).find(v => v.a === i.user.id || v.b === i.user.id);

  // ❌ 아무 전투 없음
  if (!battle && !pvp) {
    return i.reply({ content: "전투 없음", ephemeral: true });
  }

  const enemyId = pvp
    ? pvp.a === i.user.id ? pvp.b : pvp.a
    : null;

  // ───────── ATTACK ─────────
  if (i.customId === "atk") {
    const d = dmg(100);

    if (battle) {
      battle.enemyHp -= d;
      return i.reply(`⚔️ -${d} / HP ${battle.enemyHp}`);
    }

    if (pvp) {
      pvp.hp[enemyId] -= d;
      return i.reply(`⚔️ PvP -${d}`);
    }
  }

  // ───────── SKILL ─────────
  if (i.customId === "skill") {
    const c = CHAR[p.char];
    const skill = c.skills[Math.floor(Math.random() * c.skills.length)];

    if (p.skillsCooldown[skill] > Date.now()) {
      return i.reply("쿨타임");
    }

    p.skillsCooldown[skill] = Date.now() + 5000;

    let d = 120;
    if (skill === "허식무라사키") d = 300;

    if (battle) battle.enemyHp -= d;
    if (pvp) pvp.hp[enemyId] -= d;

    return i.reply(`🌀 ${skill} -${d}`);
  }

  // ───────── DOMAIN (핵심 추가) ─────────
  if (i.customId === "domain") {
    const c = CHAR[p.char];

    if (!c.domain) return i.reply("❌ 영역 없음");

    if (p.domainCooldown > Date.now()) {
      return i.reply("쿨타임");
    }

    p.domainCooldown = Date.now() + 20000;

    const power = 200 + p.hp * 0.1;

    // PvP 영역
    if (pvp) {
      const enemy = getPlayer(enemyId);

      const enemyPower = 200 + enemy.hp * 0.1;

      if (power > enemyPower) {
        pvp.hp[enemyId] -= 500;
        return i.reply(`🌌 영역 승리`);
      } else {
        pvp.hp[i.user.id] -= 500;
        return i.reply(`💥 영역 패배`);
      }
    }

    // PvE
    if (battle) {
      battle.enemyHp -= 400;
    }

    return i.reply(`🌌 ${c.domain} 발동`);
  }

  // ───────── RUN ─────────
  if (i.customId === "run") {
    const ok = Math.random() < 0.7;

    if (ok) {
      delete DB.battles[i.user.id];
      return i.reply("🏃 도주 성공");
    }

    return i.reply("❌ 실패");
  }
});

// ───────── LOGIN ─────────
client.once("ready", () => {
  console.log("ONLINE:", client.user.tag);
});

client.login(TOKEN);
