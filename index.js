const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ─────────────────────────────
// 안정 세팅 (Railway 필수)
// ─────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ─────────────────────────────
// 캐릭터
// ─────────────────────────────
const CHAR = {
  itadori: {
    name: "이타도리",
    hp: 1200,
    atk: 90,
    def: 70,
    energy: 100,
    skills: [
      { name: "주먹", req: 0, dmg: 1 },
      { name: "흑섬", req: 20, dmg: 1.6 },
      { name: "연격", req: 50, dmg: 2.2 },
    ],
  },

  gojo: {
    name: "고죠",
    hp: 2000,
    atk: 120,
    def: 100,
    energy: Infinity, // 🔥 무한 주력
    skills: [
      { name: "무한", req: 0, dmg: 1.2 },
      { name: "적", req: 20, dmg: 2.0 },
      { name: "무량공처", req: 60, dmg: 4.0 },
    ],
  },

  sukuna: {
    name: "스쿠나",
    hp: 2200,
    atk: 130,
    def: 90,
    energy: 120,
    skills: [
      { name: "참격", req: 0, dmg: 1.3 },
      { name: "해체", req: 20, dmg: 2.0 },
      { name: "영역전개", req: 60, dmg: 3.8 },
    ],
  },
};

// ─────────────────────────────
// DB
// ─────────────────────────────
const players = new Map();
const battles = new Map();
const dungeons = new Map();

function getPlayer(id) {
  if (!players.has(id)) {
    players.set(id, {
      char: "itadori",
      hp: 1200,
      energy: 100,
      owned: ["itadori"],
      mastery: { itadori: 0 },
      crystals: 500,
    });
  }
  return players.get(id);
}

// ─────────────────────────────
// 스킬 계산
// ─────────────────────────────
function getSkill(p, charId) {
  const m = p.mastery[charId] || 0;
  let skill = CHAR[charId].skills[0];
  for (const s of CHAR[charId].skills) {
    if (m >= s.req) skill = s;
  }
  return skill;
}

// ─────────────────────────────
// 가챠
// ─────────────────────────────
function gacha() {
  const pool = ["itadori", "gojo", "sukuna"];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────
// 메시지
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    const p = getPlayer(msg.author.id);

    // ───────── 가챠 ─────────
    if (msg.content === "!가챠") {
      const r = gacha();

      if (!p.owned.includes(r)) {
        p.owned.push(r);
        p.mastery[r] = 0;
      }

      p.char = r;
      return msg.reply(`🎲 획득: ${CHAR[r].name}`);
    }

    // ───────── 전투 ─────────
    if (msg.content === "!전투") {
      const enemy = { name: "저주령", hp: 800, atk: 60, def: 40 };

      battles.set(msg.author.id, {
        enemy,
        eHp: enemy.hp,
        turn: "player",
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("atk").setLabel("공격").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("skill").setLabel("술식").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("heal").setLabel("회복").setStyle(ButtonStyle.Success)
      );

      return msg.reply({
        content: "⚔️ 전투 시작!",
        components: [row],
      });
    }

    // ───────── 던전 ─────────
    if (msg.content === "!던전") {
      dungeons.set(msg.author.id, {
        stage: 0,
        enemy: { name: "저급 저주", hp: 300, atk: 30 },
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("d_atk").setLabel("공격").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("d_next").setLabel("다음층").setStyle(ButtonStyle.Primary)
      );

      return msg.reply({
        content: "🏯 던전 시작!",
        components: [row],
      });
    }
  } catch (e) {
    console.error("MESSAGE ERROR:", e);
  }
});

// ─────────────────────────────
// 버튼
// ─────────────────────────────
client.on("interactionCreate", async (i) => {
  try {
    const p = getPlayer(i.user.id);

    const char = CHAR[p.char];
    const skill = getSkill(p, p.char);

    // ───────── 전투 ─────────
    if (battles.has(i.user.id)) {
      const b = battles.get(i.user.id);

      if (i.customId === "atk") {
        const dmg = Math.floor(char.atk);
        b.eHp -= dmg;

        const enemyDmg = Math.max(1, b.enemy.atk - char.def * 0.3);
        p.hp -= enemyDmg;

        return i.reply(`👊 -${dmg} / 💥 -${enemyDmg}`);
      }

      if (i.customId === "skill") {
        const dmg = Math.floor(char.atk * skill.dmg);
        b.eHp -= dmg;

        const enemyDmg = Math.max(1, b.enemy.atk - char.def * 0.3);
        p.hp -= enemyDmg;

        // 🔥 주력 소모 (고죠 제외)
        if (char.energy !== Infinity) p.energy -= 20;

        return i.reply(`✨ ${skill.name} -${dmg}`);
      }

      if (i.customId === "heal") {
        p.hp += 200;
        return i.reply("💚 회복 +200");
      }
    }

    // ───────── 던전 ─────────
    if (dungeons.has(i.user.id)) {
      const d = dungeons.get(i.user.id);

      if (i.customId === "d_atk") {
        d.enemy.hp -= 120;

        if (d.enemy.hp <= 0) {
          d.stage++;

          if (d.stage >= 3) {
            dungeons.delete(i.user.id);
            return i.reply("🏆 던전 클리어!");
          }

          d.enemy = { name: "상위 저주", hp: 600, atk: 60 };
          return i.reply("⬆️ 다음 층!");
        }

        return i.reply("⚔️ 공격!");
      }

      if (i.customId === "d_next") {
        return i.reply("➡️ 이동");
      }
    }
  } catch (e) {
    console.error("INTERACTION ERROR:", e);
  }
});

// ─────────────────────────────
// 시작
// ─────────────────────────────
client.once("ready", () => {
  console.log(`BOT ONLINE: ${client.user.tag}`);
});

// 🔥 Railway 핵심
client.login(process.env.DISCORD_TOKEN);
DISCORD_TOKEN =MTQ5OTQ0OTM2MDM0MDA5NDk4Ng.GNcceq.jpyat_0O2KdsV5toeYyXOvVYcFkeit2wQbA7s8
