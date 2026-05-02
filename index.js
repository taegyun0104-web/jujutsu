require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const app = express();

app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
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

// ═══════════════════════════════════════════════
// ── 캐릭터 데이터 (신규 캐릭터 포함 및 스킬 리메이크) ──
// ═══════════════════════════════════════════════
const CHARACTERS = {
  itadori: { name: "이타도리 유지", emoji: "🟠", grade: "준1급", atk: 75, def: 65, maxHp: 1000, 
    skills: [
      { name: "주먹질", dmg: 80 },
      { name: "다이버전트 주먹", dmg: 140 },
      { name: "흑섬", dmg: 220 }
    ]
  },
  gojo: { name: "고조 사토루", emoji: "🔵", grade: "특급", atk: 110, def: 100, maxHp: 1600, 
    skills: [
      { name: "아오", dmg: 120 },
      { name: "아카", dmg: 180 },
      { name: "무라사키", dmg: 300 }
    ]
  },
  // --- 신규 캐릭터 4종 ---
  jogo: { name: "죠고", emoji: "🌋", grade: "특급", atk: 100, def: 55, maxHp: 1100, 
    skills: [
      { name: "화염 방사", dmg: 95 },
      { name: "화어", dmg: 160 },
      { name: "극번 '운'", dmg: 290 }
    ]
  },
  hanami: { name: "하나미", emoji: "🌳", grade: "특급", atk: 85, def: 105, maxHp: 1700, 
    skills: [
      { name: "나무 조종", dmg: 85 },
      { name: "저주 씨앗", dmg: 145 },
      { name: "현란한 꽃밭", dmg: 230 }
    ]
  },
  dagon: { name: "다곤", emoji: "🐙", grade: "특급", atk: 88, def: 95, maxHp: 1500, 
    skills: [
      { name: "수류 방출", dmg: 88 },
      { name: "사어전", dmg: 155 },
      { name: "탕온평선", dmg: 260 }
    ]
  },
  mahito: { name: "마히토", emoji: "🧵", grade: "특급", atk: 105, def: 80, maxHp: 1350, 
    skills: [
      { name: "영혼 변형", dmg: 105 },
      { name: "다중혼", dmg: 185 },
      { name: "편살즉영체", dmg: 310 }
    ]
  }
};

// ═══════════════════════════════════════════════
// ── 시스템 로직 (술식 연계, 쿨타임, 사멸회유) ──
// ═══════════════════════════════════════════════

const players = {}; // 실제 환경에서는 JSON 저장 로직 연결 필요

function getPlayer(userId, name) {
  if (!players[userId]) {
    players[userId] = {
      name: name,
      hp: 1000,
      active: "itadori",
      owned: ["itadori"],
      cullingPoints: 0,
      nerfLevel: 0,
      // 전투 관련 상태 (세션별로 관리하는 것이 좋으나 편의상 통합)
      skillStep: 0,       // 0, 1, 2 (1, 2, 3번 스킬 순서)
      skillBurnout: 0,    // 술식 봉인 턴
      reverseCooldown: 0  // 반전술식 쿨타임
    };
  }
  return players[userId];
}

// ── 사멸회유 임베드 및 버튼 생성 ──
function getCullingEmbed(player, enemy, log) {
  const ch = CHARACTERS[player.active];
  return new EmbedBuilder()
    .setTitle(`⚔️ 사멸회유 진행 중 (포인트: ${player.cullingPoints})`)
    .setColor(0x2f3136)
    .setDescription(log)
    .addFields(
      { name: `👤 ${player.name}`, value: `HP: ${player.hp}/${ch.maxHp}\n술식 단계: ${player.skillBurnout > 0 ? "🔥 과부하" : (player.skillStep + 1) + "단계"}`, inline: true },
      { name: `👾 ${enemy.name}`, value: `HP: ${enemy.hp}/${enemy.maxHp}\n너프 적용: LV.${player.nerfLevel}`, inline: true }
    );
}

const getActionButtons = (player) => {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("atk_normal")
      .setLabel("일반 공격")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("atk_skill")
      .setLabel(player.skillBurnout > 0 ? `술식 봉인(${player.skillBurnout})` : `${player.skillStep + 1}번 술식`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(player.skillBurnout > 0),
    new ButtonBuilder()
      .setCustomId("atk_reverse")
      .setLabel(player.reverseCooldown > 0 ? `반전술식(${player.reverseCooldown})` : "반전술식")
      .setStyle(ButtonStyle.Success)
      .setDisabled(player.reverseCooldown > 0),
    new ButtonBuilder()
      .setCustomId("culling_nerf")
      .setLabel("상대 너프(15pt)")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.cullingPoints < 15)
  );
};

// ═══════════════════════════════════════════════
// ── 인터랙션 처리 ──
// ═══════════════════════════════════════════════

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const player = getPlayer(interaction.user.id, interaction.user.username);
  const ch = CHARACTERS[player.active];
  
  // 임시 적 데이터 (실제로는 세션에서 관리)
  if (!interaction.message.enemy) {
    interaction.message.enemy = { name: "특급 주령", hp: 1500, maxHp: 1500, atk: 80 };
  }
  const enemy = interaction.message.enemy;

  let log = "";

  if (interaction.customId === "atk_normal") {
    const dmg = Math.floor(ch.atk * 0.8);
    enemy.hp -= dmg;
    log = `⚔️ 일반 공격으로 ${dmg}의 피해를 입혔습니다!`;
  } 
  
  else if (interaction.customId === "atk_skill") {
    const skill = ch.skills[player.skillStep];
    const dmg = skill.dmg + Math.floor(Math.random() * 50);
    enemy.hp -= dmg;
    log = `🌀 **${skill.name}(${player.skillStep + 1}번 술식)** 사용! ${dmg}의 피해!`;

    player.skillStep++;
    if (player.skillStep >= 3) {
      player.skillStep = 0;
      player.skillBurnout = 5; // 3번 다 쓰면 5턴 봉인
      log += `\n🔥 **술식을 모두 사용하여 5턴간 과부하 상태에 빠집니다!**`;
    }
  } 
  
  else if (interaction.customId === "atk_reverse") {
    const heal = Math.floor(ch.maxHp * 0.5);
    player.hp = Math.min(ch.maxHp, player.hp + heal);
    player.reverseCooldown = 3; // 3턴 쿨타임
    log = `♻️ **반전술식**으로 ${heal}만큼 회복했습니다! (3턴 쿨타임)`;
  }

  else if (interaction.customId === "culling_nerf") {
    player.cullingPoints -= 15;
    player.nerfLevel++;
    enemy.hp = Math.floor(enemy.hp * 0.8);
    enemy.atk = Math.floor(enemy.atk * 0.8);
    log = `📉 **사멸회유 규칙 추가!** 적의 능력치가 20% 감소했습니다!`;
  }

  // --- 턴 종료 처리 (쿨타임 감소 및 적 공격) ---
  if (player.skillBurnout > 0) player.skillBurnout--;
  if (player.reverseCooldown > 0) player.reverseCooldown--;

  if (enemy.hp > 0) {
    const eDmg = Math.max(10, enemy.atk - Math.floor(ch.def * 0.5));
    player.hp -= eDmg;
    log += `\n👾 적의 반격! ${eDmg}의 피해를 입었습니다.`;
  } else {
    // 승리 시
    player.cullingPoints += 1;
    log = `🏆 적을 처치했습니다! 사멸회유 포인트 +1 (현재: ${player.cullingPoints})`;
    // 적 재생성 로직 등 추가 가능
  }

  await interaction.update({
    embeds: [getCullingEmbed(player, enemy, log)],
    components: [getActionButtons(player)]
  });
});

client.login(process.env.DISCORD_TOKEN);
