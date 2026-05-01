const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

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
      { name: "주먹", dmg: 1.0, req: 0 },
      { name: "흑섬", dmg: 1.6, req: 20 },
      { name: "연격", dmg: 2.2, req: 50 },
    ]
  },
  gojo: {
    name: "고죠",
    hp: 2000,
    atk: 120,
    def: 100,
    energy: Infinity,
    skills: [
      { name: "무한", dmg: 1.2, req: 0 },
      { name: "적", dmg: 2.0, req: 20 },
      { name: "무량공처", dmg: 4.0, req: 60 },
    ]
  }
};

// ─────────────────────────────
// 플레이어
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
      mastery: { itadori: 0 }
    });
  }
  return players.get(id);
}

function getSkill(player, charId) {
  const mastery = player.mastery[charId] || 0;
  let skill = CHAR[charId].skills[0];
  for (const s of CHAR[charId].skills) {
    if (mastery >= s.req) skill = s;
  }
  return skill;
}

// ─────────────────────────────
// 턴 계산
// ─────────────────────────────
function enemyTurn(state, player, char) {
  const dmg = Math.max(1,
    Math.floor(state.enemy.atk - char.def * 0.3)
  );
  state.pHp -= dmg;
  return `💥 적 공격! -${dmg} HP`;
}

// ─────────────────────────────
// 전투 시작
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const p = getPlayer(msg.author.id);

  // ───── 전투 ─────
  if (msg.content === "!전투") {
    const enemy = {
      name: "저주령",
      hp: 800,
      atk: 60,
      def: 40
    };

    battles.set(msg.author.id, {
      enemy,
      pHp: p.hp,
      eHp: enemy.hp,
      turn: "player"
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("atk")
        .setLabel("공격")
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId("skill")
        .setLabel("술식")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("heal")
        .setLabel("회복")
        .setStyle(ButtonStyle.Success),
    );

    return msg.reply({
      content: "⚔️ 전투 시작!",
      components: [row]
    });
  }

  // ───── 던전 ─────
  if (msg.content === "!던전") {
    const stages = [
      { name: "저급 저주", hp: 300, atk: 30 },
      { name: "중급 저주", hp: 600, atk: 60 },
      { name: "보스", hp: 1200, atk: 100 },
    ];

    dungeons.set(msg.author.id, {
      stage: 0,
      enemy: stages[0],
      pHp: p.hp
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("d_atk")
        .setLabel("공격")
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId("d_next")
        .setLabel("다음층")
        .setStyle(ButtonStyle.Primary)
    );

    return msg.reply({
      content: "🏯 던전 입장!",
      components: [row]
    });
  }
});

// ─────────────────────────────
// 버튼 처리
// ─────────────────────────────
client.on("interactionCreate", async (i) => {
  const p = getPlayer(i.user.id);

  // ───── 전투 ─────
  if (battles.has(i.user.id)) {
    const b = battles.get(i.user.id);
    const char = CHAR[p.char];
    const skill = getSkill(p, p.char);

    if (i.customId === "atk") {
      const dmg = Math.floor(char.atk * 1.0);
      b.eHp -= dmg;
      const log = `👊 공격 -${dmg}`;

      const enemyLog = enemyTurn(b, p, char);

      return i.reply(`${log}\n${enemyLog}`);
    }

    if (i.customId === "skill") {
      const dmg = Math.floor(char.atk * skill.dmg);
      b.eHp -= dmg;

      const enemyLog = enemyTurn(b, p, char);

      return i.reply(`✨ ${skill.name} -${dmg}\n${enemyLog}`);
    }

    if (i.customId === "heal") {
      const heal = 200;
      b.pHp += heal;
      return i.reply(`💚 회복 +${heal}`);
    }
  }

  // ───── 던전 ─────
  if (dungeons.has(i.user.id)) {
    const d = dungeons.get(i.user.id);
    const enemy = d.enemy;

    if (i.customId === "d_atk") {
      const dmg = 100;
      enemy.hp -= dmg;

      let text = `⚔️ 던전 공격 -${dmg}`;

      if (enemy.hp <= 0) {
        d.stage++;

        if (d.stage >= 3) {
          dungeons.delete(i.user.id);
          return i.reply("🏆 던전 클리어!");
        }

        const next = [
          { name: "중급", hp: 600, atk: 60 },
          { name: "보스", hp: 1200, atk: 100 },
        ];

        d.enemy = next[d.stage - 1];
        return i.reply("⬆️ 다음 층 이동!");
      }

      return i.reply(text);
    }

    if (i.customId === "d_next") {
      return i.reply("➡️ 이동 중...");
    }
  }
});

client.once("ready", () => {
  console.log("BOT ON
