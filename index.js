require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const GIFEncoder = require("gif-encoder-2");

// ==================== HTTP 서버 ====================
const app = express();
app.get("/", (_, res) => res.send("🔱 주술회전 봇"));
app.get("/health", (_, res) => res.json({ status: "ok" }));
app.listen(process.env.PORT || 3000);

// ==================== 데이터베이스 ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS players (user_id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    console.log("✅ DB 준비");
  } catch(e) { console.log("⚠️ DB 없음, 메모리 모드"); }
}

async function loadDB() {
  try {
    const res = await pool.query("SELECT * FROM players");
    const obj = {};
    for (const row of res.rows) obj[row.user_id] = row.data;
    return obj;
  } catch(e) { return {}; }
}

async function saveDB(id, data) {
  try {
    await pool.query(`INSERT INTO players(user_id, data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=$2, updated_at=NOW()`, [id, JSON.stringify(data)]);
  } catch(e) {}
}

// ==================== 디스코드 클라이언트 ====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("❌ 토큰 없음"); process.exit(1); }

// ==================== GIF 프로필 시스템 ====================
const GIF_CHARACTERS = {
  이타도리: { color: "#f97316", glow: "#fb923c", title: "Vessel", desc: "주인공, 스쿠나의 그릇" },
  고죠: { color: "#60a5fa", glow: "#3b82f6", title: "The Strongest", desc: "최강의 주술사" },
  메구미: { color: "#1e293b", glow: "#334155", title: "Ten Shadows", desc: "십종 그림자" },
  노바라: { color: "#ec4899", glow: "#db2777", title: "Straw Doll", desc: "인형술사" },
  나나미: { color: "#facc15", glow: "#eab308", title: "Salaryman Sorcerer", desc: "전 샐러리맨" },
  스쿠나: { color: "#ef4444", glow: "#dc2626", title: "King of Curses", desc: "저주의 왕" },
  게토: { color: "#a855f7", glow: "#9333ea", title: "Curse Manipulator", desc: "저주 조작" },
  마키: { color: "#84cc16", glow: "#65a30d", title: "Heavenly Restriction", desc: "천여" },
  판다: { color: "#22c55e", glow: "#16a34a", title: "Cursed Corpse", desc: "저주 시체" },
  이누마키: { color: "#38bdf8", glow: "#0ea5e9", title: "Cursed Speech", desc: "저주언어" },
  유타: { color: "#d1d5db", glow: "#9ca3af", title: "Special Grade", desc: "특급" },
  히구루마: { color: "#f43f5e", glow: "#e11d48", title: "Judgement Sorcerer", desc: "심판관" },
  죠고: { color: "#fb7185", glow: "#ef4444", title: "Volcano Curse", desc: "화산" },
  다곤: { color: "#06b6d4", glow: "#0891b2", title: "Ocean Curse", desc: "바다" },
  하나미: { color: "#10b981", glow: "#059669", title: "Nature Curse", desc: "자연" },
  마히토: { color: "#a78bfa", glow: "#8b5cf6", title: "Soul Manipulator", desc: "영혼 조작" },
  토도: { color: "#f59e0b", glow: "#d97706", title: "Boogie Woogie", desc: "박수" },
  하카리: { color: "#fde047", glow: "#facc15", title: "Gambler Domain", desc: "도박" }
};

const gifUserData = new Map();

async function renderGIF(user, charData) {
  const w = 900, h = 350;
  const encoder = new GIFEncoder(w, h);
  encoder.setRepeat(0);
  encoder.setDelay(70);
  encoder.setQuality(20);
  encoder.start();

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const avatar = await loadImage(user.displayAvatarURL({ extension: "png", size: 512 }));

  for (let i = 0; i < 22; i++) {
    const pulse = Math.sin(i * 0.3) * 12;
    ctx.fillStyle = "#0b0f1a";
    ctx.fillRect(0, 0, w, h);
    ctx.shadowColor = charData.glow;
    ctx.shadowBlur = 35;
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, charData.color);
    grad.addColorStop(1, "#000");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(60 + 25, 60 + pulse);
    ctx.lineTo(60 + 780 - 25, 60 + pulse);
    ctx.quadraticCurveTo(60 + 780, 60 + pulse, 60 + 780, 60 + pulse + 25);
    ctx.lineTo(60 + 780, 60 + pulse + 240 - 25);
    ctx.quadraticCurveTo(60 + 780, 60 + pulse + 240, 60 + 780 - 25, 60 + pulse + 240);
    ctx.lineTo(60 + 25, 60 + pulse + 240);
    ctx.quadraticCurveTo(60, 60 + pulse + 240, 60, 60 + pulse + 240 - 25);
    ctx.lineTo(60, 60 + pulse + 25);
    ctx.quadraticCurveTo(60, 60 + pulse, 60 + 25, 60 + pulse);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    const shake = Math.sin(i * 0.5) * 3;
    ctx.save();
    ctx.beginPath();
    ctx.arc(160 + shake, 180, 80, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, 80, 100, 160, 160);
    ctx.restore();
    ctx.strokeStyle = charData.glow;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(160, 180, 90 + pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 34px sans-serif";
    ctx.fillText(user.username, 280, 170);
    ctx.fillStyle = "#93c5fd";
    ctx.font = "20px sans-serif";
    ctx.fillText(charData.title, 280, 210);
    encoder.addFrame(ctx);
  }
  encoder.finish();
  return new AttachmentBuilder(encoder.out.getData(), { name: "profile.gif" });
}

// ==================== 스킬 이펙트 아트 ====================
const SKILL_EFFECTS = {
  "흑섬": { art: "```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```", color: 0x1a0a2e, flavorText: "순간적으로 발산되는 최대 저주 에너지!" },
  "무량공처": { art: "```\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n```", color: 0x00ffff, flavorText: "\"나는 최강이니까\" — 무한이 세계를 지배한다" },
  "세계를 가르는 참격": { art: "```\n🌌✂️🌌✂️🌌\n✂️  世界  ✂️\n🌌✂️🌌✂️🌌\n```", color: 0x8b0000, flavorText: "공간 자체를 베어내는 절대적 술식!" },
  "순애빔": { art: "```\n💜💛💜💛💜\n💛 純 愛 砲 💛\n💜💛💜💛💜\n```", color: 0xff00ff, flavorText: "사랑의 에너지가 파괴적인 빔으로 변환된다!" },
  "부기우기": { art: "```\n🎵💪🎵💪🎵\n💪 Boogie 💪\n🎵💪🎵💪🎵\n```", color: 0x1e90ff, flavorText: "\"댄스홀 가수!\" — 보조공격술 위치 전환!" },
  "어주자": { art: "```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```", color: 0xb5451b, flavorText: "스쿠나의 힘이 몸을 가득 채운다..." },
  "아오": { art: "```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```", color: 0x0066ff, flavorText: "무한에 의한 인력 — 모든 것을 끌어당긴다" },
  "아카": { art: "```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```", color: 0xff0033, flavorText: "무한에 의한 척력 — 모든 것을 날려버린다" },
  "무라사키": { art: "```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```", color: 0x9900ff, flavorText: "아오와 아카의 융합 — 허공을 찢는 허수!" },
  "해": { art: "```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```", color: 0xcc0000, flavorText: "만물을 베어내는 저주의 왕의 손톱!" },
  "팔": { art: "```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```", color: 0x8b0000, flavorText: "공간 자체를 베어내는 절대적 술식!" },
  "푸가": { art: "```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```", color: 0x4a0000, flavorText: "닿는 모든 것을 분해한다 — 저주의 왕의 진면목!" },
  "복마어주자": { art: "```\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n```", color: 0x2a0000, flavorText: "천지개벽 — 저주의 왕의 궁극 영역전개!" },
  "주먹질": { art: "```\n  💥  \n ▓▓▓▓▓\n  💥  \n```", color: 0xff6b35, flavorText: "저주 에너지를 주먹에 집중시킨다!" },
  "_default": { art: "```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```", color: 0x7c5cfc, flavorText: "저주 에너지가 폭발한다!" }
};

function getSkillEffect(skillName) {
  return SKILL_EFFECTS[skillName] || SKILL_EFFECTS["_default"];
}

// ==================== 주력 술식 시스템 ====================
const MASTER_SKILLS = {
  이타도리: { skillName: "흑섬", enhancedName: "흑섬 · 연속", condition: { mastery: 50, fingers: 10 }, dmgMult: 3.0, statBonus: { atk: 80, def: 50, hp: 1000 } },
  고죠: { skillName: "무량공처", enhancedName: "무량공처 · 절대", condition: { mastery: 40 }, dmgMult: 3.5, statBonus: { atk: 100, def: 80, hp: 1500 } },
  스쿠나: { skillName: "세계를 가르는 참격", enhancedName: "세계를 가르는 참격 · 절멸", condition: { fingers: 15 }, dmgMult: 4.0, statBonus: { atk: 120, def: 60, hp: 2000 } },
  유타: { skillName: "순애빔", enhancedName: "진정한 순애빔", condition: { mastery: 40 }, dmgMult: 3.2, statBonus: { atk: 90, def: 70, hp: 1200 } },
  마키: { skillName: "천개봉파", enhancedName: "천여 각성 · 멸", condition: { hp: 0.3 }, dmgMult: 3.0, statBonus: { atk: 100, def: 40, hp: 800 } },
  토도: { skillName: "부기우기", enhancedName: "진정한 부기우기 · 연속", condition: { mastery: 45 }, dmgMult: 2.8, statBonus: { atk: 70, def: 60, hp: 900 } },
  메구미: { skillName: "후루베 유라유라", enhancedName: "마허라가라 · 각성", condition: { mastery: 35 }, dmgMult: 2.8, statBonus: { atk: 60, def: 60, hp: 800 } },
  노바라: { skillName: "발화", enhancedName: "발화 · 영혼소멸", condition: { mastery: 35 }, dmgMult: 2.8, statBonus: { atk: 65, def: 40, hp: 700 } }
};

function checkMasterSkill(player, charName) {
  const ms = MASTER_SKILLS[charName];
  if (!ms) return null;
  let unlocked = true;
  if (ms.condition.mastery && (player.mastery[charName] || 0) < ms.condition.mastery) unlocked = false;
  if (ms.condition.fingers && (player.sukunaFingers || 0) < ms.condition.fingers) unlocked = false;
  if (ms.condition.hp === 0.3 && player.hp > player.maxHp * 0.3) unlocked = false;
  return unlocked ? ms : null;
}

// ==================== 흑섬 시스템 ====================
const blackFlashHistory = new Map();

function checkBlackFlash(userId) {
  const now = Date.now();
  const history = blackFlashHistory.get(userId) || { lastTime: 0, successCount: 0, streak: 0 };
  const timeDiff = now - history.lastTime;
  const isBlackFlash = timeDiff >= 300 && timeDiff <= 700;
  
  if (isBlackFlash) {
    history.successCount++;
    history.streak++;
    history.lastTime = now;
    blackFlashHistory.set(userId, history);
    return { success: true, mult: 2.5, streak: history.streak };
  }
  history.streak = 0;
  history.lastTime = now;
  blackFlashHistory.set(userId, history);
  return { success: false, mult: 1.0, streak: 0 };
}

// ==================== 상태이상 ====================
const STATUS_EFFECTS = {
  poison: { id: "poison", name: "독", emoji: "☠️", desc: "매 턴 최대HP의 5% 피해", duration: 3 },
  burn: { id: "burn", name: "화상", emoji: "🔥", desc: "매 턴 최대HP의 8% 피해", duration: 2 },
  freeze: { id: "freeze", name: "빙결", emoji: "❄️", desc: "1턴 행동 불가", duration: 1 },
  weaken: { id: "weaken", name: "약화", emoji: "💔", desc: "공격력 30% 감소", duration: 2 },
  stun: { id: "stun", name: "기절", emoji: "⚡", desc: "1턴 행동 불가", duration: 1 }
};

function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects = [];
  const existing = target.statusEffects.find(s => s.id === statusId);
  if (existing) existing.turns = STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({ id: statusId, turns: STATUS_EFFECTS[statusId].duration });
}

function statusStr(se) {
  if (!se || se.length === 0) return "없음";
  return se.map(s => `${STATUS_EFFECTS[s.id]?.emoji || ""} ${s.turns}턴`).join(" ");
}

// ==================== 일일/주간 퀘스트 ====================
const DAILY_QUESTS = [
  { id: "daily_1", name: "전투 승리", desc: "일반 전투 3승", target: 3, type: "battle_win", reward: { crystals: 100, xp: 200, potion: 1 } },
  { id: "daily_2", name: "컬링 도전", desc: "컬링 5웨이브", target: 5, type: "culling_wave", reward: { crystals: 150, xp: 300 } },
  { id: "daily_3", name: "사멸회유", desc: "사멸회유 5포인트", target: 5, type: "jujutsu_point", reward: { crystals: 120, xp: 250 } },
  { id: "daily_4", name: "흑섬 성공", desc: "흑섬 3회 성공", target: 3, type: "black_flash", reward: { crystals: 80, xp: 150 } }
];

const WEEKLY_QUESTS = [
  { id: "weekly_1", name: "전투 마스터", desc: "일반 전투 20승", target: 20, type: "battle_win", reward: { crystals: 500, xp: 1000, potion: 3 } },
  { id: "weekly_2", name: "컬링 챔피언", desc: "컬링 30웨이브", target: 30, type: "culling_wave", reward: { crystals: 600, xp: 1200, fingers: 1 } },
  { id: "weekly_3", name: "사멸회유 대가", desc: "사멸회유 30포인트", target: 30, type: "jujutsu_point", reward: { crystals: 550, xp: 1100 } },
  { id: "weekly_4", name: "흑섬 전설", desc: "흑섬 15회", target: 15, type: "black_flash", reward: { crystals: 400, xp: 800, potion: 2 } }
];

function initQuests(player) {
  if (!player.dailyQuests) {
    player.dailyQuests = {};
    for (const q of DAILY_QUESTS) player.dailyQuests[q.id] = { progress: 0, completed: false };
  }
  if (!player.weeklyQuests) {
    player.weeklyQuests = {};
    for (const q of WEEKLY_QUESTS) player.weeklyQuests[q.id] = { progress: 0, completed: false };
  }
  const today = new Date().toDateString();
  if (player.lastDailyReset !== today) {
    for (const q of DAILY_QUESTS) player.dailyQuests[q.id] = { progress: 0, completed: false };
    player.lastDailyReset = today;
  }
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  if (player.lastWeeklyReset !== weekNum) {
    for (const q of WEEKLY_QUESTS) player.weeklyQuests[q.id] = { progress: 0, completed: false };
    player.lastWeeklyReset = weekNum;
  }
}

function updateQuestProgress(player, type, amount = 1) {
  initQuests(player);
  const rewards = { crystals: 0, xp: 0, potion: 0, fingers: 0 };
  
  for (const q of DAILY_QUESTS) {
    if (q.type === type && !player.dailyQuests[q.id].completed) {
      player.dailyQuests[q.id].progress += amount;
      if (player.dailyQuests[q.id].progress >= q.target) {
        player.dailyQuests[q.id].completed = true;
        rewards.crystals += q.reward.crystals || 0;
        rewards.xp += q.reward.xp || 0;
        rewards.potion += q.reward.potion || 0;
      }
    }
  }
  
  for (const q of WEEKLY_QUESTS) {
    if (q.type === type && !player.weeklyQuests[q.id].completed) {
      player.weeklyQuests[q.id].progress += amount;
      if (player.weeklyQuests[q.id].progress >= q.target) {
        player.weeklyQuests[q.id].completed = true;
        rewards.crystals += q.reward.crystals || 0;
        rewards.xp += q.reward.xp || 0;
        rewards.potion += q.reward.potion || 0;
        rewards.fingers += q.reward.fingers || 0;
      }
    }
  }
  
  if (rewards.crystals > 0 || rewards.xp > 0) {
    player.crystals += rewards.crystals;
    player.xp += rewards.xp;
    player.potion = (player.potion || 0) + rewards.potion;
    player.sukunaFingers = Math.min(20, (player.sukunaFingers || 0) + rewards.fingers);
  }
  return rewards;
}

// ==================== 제작 시스템 ====================
const CRAFTING_RECIPES = {
  "주구·해": { materials: { "저주 잔해": 10, "저주의 손톱": 5, "스쿠나 손가락": 1 }, desc: "세계를 가르는 참격", type: "weapon", effect: { atkBonus: 30 } },
  "주구·팔": { materials: { "저주 잔해": 10, "저주의 손톱": 5, "스쿠나 손가락": 1 }, desc: "공간 참격", type: "weapon", effect: { atkBonus: 30 } },
  "반전술식 각인": { materials: { "저주 잔해": 20, "희귀 결정": 5 }, desc: "반전술식 효율 2배", type: "upgrade", effect: { reverseMult: 2.0 } },
  "저주 도구 강화석": { materials: { "저주 잔해": 15, "희귀 결정": 3 }, desc: "모든 스탯 10% 증가", type: "upgrade", effect: { statMult: 1.1 } }
};

const MATERIAL_DROPS = {
  "저주 잔해": { rate: 0.6, min: 1, max: 3 },
  "저주의 손톱": { rate: 0.3, min: 1, max: 2 },
  "희귀 결정": { rate: 0.15, min: 1, max: 1 },
  "특급 저주의 파편": { rate: 0.05, min: 1, max: 1 }
};

function dropMaterials(enemyGrade) {
  const drops = {};
  let mult = 1;
  if (enemyGrade === "특급") mult = 3;
  else if (enemyGrade === "1급") mult = 2;
  
  for (const [material, data] of Object.entries(MATERIAL_DROPS)) {
    if (Math.random() < data.rate * mult) {
      const amount = Math.floor(Math.random() * (data.max - data.min + 1) + data.min) * mult;
      drops[material] = (drops[material] || 0) + amount;
    }
  }
  return drops;
}

function addMaterials(player, drops) {
  if (!player.materials) player.materials = {};
  for (const [mat, amount] of Object.entries(drops)) {
    player.materials[mat] = (player.materials[mat] || 0) + amount;
  }
}

function canCraft(player, recipeId) {
  const recipe = CRAFTING_RECIPES[recipeId];
  if (!recipe || !player.materials) return false;
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if ((player.materials[mat] || 0) < need) return false;
  }
  return true;
}

function craftItem(player, recipeId) {
  const recipe = CRAFTING_RECIPES[recipeId];
  if (!canCraft(player, recipeId)) return false;
  for (const [mat, need] of Object.entries(recipe.materials)) {
    player.materials[mat] -= need;
  }
  if (!player.craftedItems) player.craftedItems = [];
  player.craftedItems.push({ id: recipeId, craftedAt: Date.now() });
  if (recipe.effect) {
    if (!player.craftEffects) player.craftEffects = [];
    player.craftEffects.push(recipe.effect);
  }
  return true;
}

// ==================== RPG 캐릭터 데이터 ====================
const CHARACTERS = {
  이타도리: { name: "이타도리 유지", emoji: "🟠", grade: "준1급", atk: 90, def: 75, maxHp: 1000, domain: null, skills: [
    { name: "주먹질", minMastery: 0, dmg: 95, desc: "강력한 기본 주먹" },
    { name: "흑섬", minMastery: 15, dmg: 240, desc: "최대 저주 에너지 방출!" }
  ]},
  고죠: { name: "고조 사토루", emoji: "🔵", grade: "특급", atk: 130, def: 120, maxHp: 1800, domain: "무량공처", skills: [
    { name: "아오", minMastery: 0, dmg: 145, desc: "적을 끌어당긴다" },
    { name: "무량공처", minMastery: 30, dmg: 480, desc: "무한을 지배한다" }
  ]},
  스쿠나: { name: "료멘 스쿠나", emoji: "🔴", grade: "특급", atk: 140, def: 115, maxHp: 2500, domain: "복마어주자", skills: [
    { name: "해", minMastery: 0, dmg: 145, desc: "만물을 벤다" },
    { name: "세계를 가르는 참격", minMastery: 30, dmg: 600, desc: "세계를 벤다" }
  ]},
  유타: { name: "오코츠 유타", emoji: "🌟", grade: "특급", atk: 128, def: 112, maxHp: 1750, domain: "진안상애", skills: [
    { name: "모방술식", minMastery: 0, dmg: 135, desc: "술식 복사" },
    { name: "순애빔", minMastery: 30, dmg: 480, desc: "사랑의 빔" }
  ]},
  마키: { name: "마키 젠인", emoji: "⚪", grade: "준1급", atk: 122, def: 110, maxHp: 1300, domain: null, skills: [
    { name: "봉술", minMastery: 0, dmg: 122, desc: "저주 도구" },
    { name: "천개봉파", minMastery: 30, dmg: 400, desc: "천여 각성" }
  ]},
  토도: { name: "토도 아오이", emoji: "💪", grade: "1급", atk: 128, def: 108, maxHp: 1500, domain: null, skills: [
    { name: "부기우기", minMastery: 0, dmg: 130, desc: "위치 전환" },
    { name: "전투본능", minMastery: 30, dmg: 200, desc: "자기 버프" }
  ]},
  메구미: { name: "후시구로 메구미", emoji: "⚫", grade: "1급", atk: 110, def: 108, maxHp: 1250, domain: "강압암예정", skills: [
    { name: "옥견", minMastery: 0, dmg: 115, desc: "식신 소환" },
    { name: "후루베 유라유라", minMastery: 30, dmg: 380, desc: "마허라가라" }
  ]},
  노바라: { name: "쿠기사키 노바라", emoji: "🌸", grade: "1급", atk: 115, def: 95, maxHp: 1180, domain: null, skills: [
    { name: "망치질", minMastery: 0, dmg: 118, desc: "저주 못" },
    { name: "발화", minMastery: 30, dmg: 390, desc: "영혼 공명" }
  ]}
};

const REVERSE_CHARS = new Set(["고죠", "유타"]);
const GACHA_POOL = ["이타도리", "고죠", "메구미", "노바라", "나나미", "유타", "마키", "토도", "판다", "이누마키"];

function rollGacha() {
  const rand = Math.random();
  if (rand < 0.05) return "고죠";
  if (rand < 0.10) return "유타";
  if (rand < 0.15) return "스쿠나";
  return GACHA_POOL[Math.floor(Math.random() * GACHA_POOL.length)];
}

// ==================== 적 데이터 ====================
const ENEMIES = [
  { id: "e1", name: "저급 저주령", emoji: "👹", hp: 550, atk: 38, def: 12, xp: 75, crystals: 18, masteryXp: 1, grade: "3급" },
  { id: "e2", name: "1급 저주령", emoji: "👺", hp: 1100, atk: 80, def: 40, xp: 190, crystals: 40, masteryXp: 3, grade: "1급" },
  { id: "e3", name: "특급 저주령", emoji: "💀", hp: 2400, atk: 128, def: 72, xp: 440, crystals: 90, masteryXp: 7, grade: "특급" }
];

const JUJUTSU_ENEMIES = [
  { name: "약화된 저주령", emoji: "💧", hp: 300, atk: 25, def: 8, xp: 55, crystals: 12, points: 1 },
  { name: "중간급 저주령", emoji: "🌀", hp: 620, atk: 55, def: 28, xp: 115, crystals: 28, points: 2 },
  { name: "강화 저주령", emoji: "🔥", hp: 450, atk: 75, def: 22, xp: 95, crystals: 23, points: 1 }
];

// ==================== 인메모리 데이터 ====================
let players = {};
const battles = {};
const cullings = {};
const jujutsus = {};
const parties = {};
const pvpSessions = {};
let partyIdSeq = 1;

function getPlayer(userId, username = "플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id: userId, name: username, crystals: 500, xp: 0,
      owned: ["이타도리"], active: "이타도리",
      hp: 1000, maxHp: 1000, potion: 3, wins: 0, losses: 0,
      mastery: { 이타도리: 0 }, sukunaFingers: 0,
      materials: {}, craftedItems: [], craftEffects: [],
      dailyQuests: {}, weeklyQuests: {}, lastDaily: 0,
      lastDailyReset: null, lastWeeklyReset: null,
      statusEffects: [], skillCooldown: 0,
      pvpWins: 0, pvpLosses: 0
    };
  }
  const p = players[userId];
  if (p.name !== username && username !== "플레이어") p.name = username;
  return p;
}

function savePlayer(id) { saveDB(id, players[id]); }

function getMastery(player, charId) { return player.mastery?.[charId] || 0; }

function getCurrentSkill(player, charId) {
  const ch = CHARACTERS[charId];
  if (!ch) return { name: "기본 공격", dmg: 50 };
  const m = getMastery(player, charId);
  const available = ch.skills.filter(s => m >= s.minMastery);
  return available[available.length - 1] || ch.skills[0];
}

function getPlayerStats(player) {
  const ch = CHARACTERS[player.active];
  if (!ch) return { atk: 100, def: 100, maxHp: 1000 };
  
  let atk = ch.atk, def = ch.def, maxHp = ch.maxHp;
  const ms = checkMasterSkill(player, player.active);
  if (ms) {
    atk += ms.statBonus.atk;
    def += ms.statBonus.def;
    maxHp += ms.statBonus.hp;
  }
  
  if (player.active === "이타도리") {
    atk += (player.sukunaFingers || 0) * 10;
    def += (player.sukunaFingers || 0) * 6;
    maxHp += (player.sukunaFingers || 0) * 200;
  }
  
  player.maxHp = maxHp;
  return { atk, def, maxHp };
}

function calcDmgForPlayer(player, enemyDef) {
  const stats = getPlayerStats(player);
  const variance = 0.70 + Math.random() * 0.60;
  return Math.max(1, Math.floor((stats.atk * variance - enemyDef * 0.22)));
}

function calcSkillDmgForPlayer(player, baseDmg) {
  let dmg = baseDmg + Math.floor(Math.random() * 60);
  const ms = checkMasterSkill(player, player.active);
  if (ms) dmg = Math.floor(dmg * ms.dmgMult);
  return dmg;
}

function hpBar(cur, max, len = 10) {
  const pct = Math.max(0, Math.min(1, cur / max));
  const fill = Math.round(pct * len);
  return "🟩".repeat(fill) + "⬛".repeat(len - fill);
}

function getLevel(xp) { return Math.floor(xp / 200) + 1; }

// ==================== 임베드 함수 ====================
function profileEmbed(player) {
  const ch = CHARACTERS[player.active];
  const stats = getPlayerStats(player);
  const ms = checkMasterSkill(player, player.active);
  const msText = ms ? `\n🔥 **주력 술식**: ${ms.enhancedName} (${ms.dmgMult}배)` : "";
  const fingers = player.sukunaFingers || 0;
  
  return new EmbedBuilder()
    .setTitle(`${player.name}의 주술사 프로필`)
    .setColor(0xF5C842)
    .setDescription(`**${ch.emoji} ${ch.name}** [${ch.grade}]${msText}\n\`\`\`\n📊 스탯\n🗡️ ATK: ${stats.atk}\n🛡️ DEF: ${stats.def}\n💚 HP: ${player.hp}/${stats.maxHp}\n⭐ LV: ${getLevel(player.xp)}\n💎 크리스탈: ${player.crystals}\n🧪 회복약: ${player.potion}\n👹 손가락: ${fingers}/20\n⚔️ 전적: ${player.wins}승 ${player.losses}패\n\`\`\``)
    .setFooter({ text: "!술식 - 스킬 확인 | !퀘스트 - 일일/주간 퀘스트" });
}

function skillEmbed(player) {
  const ch = CHARACTERS[player.active];
  const mastery = getMastery(player, player.active);
  const ms = checkMasterSkill(player, player.active);
  const fx = getSkillEffect(getCurrentSkill(player, player.active).name);
  
  let skillsDesc = "";
  for (const s of ch.skills) {
    const unlocked = mastery >= s.minMastery;
    skillsDesc += `${unlocked ? "✅" : "🔒"} **${s.name}** - 피해 ${s.dmg} (숙련 ${s.minMastery})\n> ${s.desc}\n\n`;
  }
  
  if (ms) {
    const msFx = getSkillEffect(ms.skillName);
    skillsDesc += `\n${msFx.art}\n🔥 **주력 술식**: ${ms.enhancedName}\n💥 데미지 ${ms.dmgMult}배\n📋 조건: ${ms.condition.mastery ? `숙련도 ${ms.condition.mastery}` : ""} ${ms.condition.fingers ? `손가락 ${ms.condition.fingers}개` : ""}`;
  }
  
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name}의 술식 트리`)
    .setColor(0x7C5CFC)
    .setDescription(skillsDesc)
    .setFooter({ text: `현재 숙련도: ${mastery} | 전투 승리 시 상승` });
}

function questEmbed(player) {
  initQuests(player);
  
  let dailyDesc = "", weeklyDesc = "";
  for (const q of DAILY_QUESTS) {
    const prog = player.dailyQuests[q.id];
    const status = prog.completed ? "✅ 완료!" : `📊 ${prog.progress}/${q.target}`;
    dailyDesc += `**${q.name}**\n> ${q.desc} | ${status} | 보상: 💎${q.reward.crystals} ⭐${q.reward.xp}\n\n`;
  }
  
  for (const q of WEEKLY_QUESTS) {
    const prog = player.weeklyQuests[q.id];
    const status = prog.completed ? "✅ 완료!" : `📊 ${prog.progress}/${q.target}`;
    const fingerReward = q.reward.fingers ? ` 👹+${q.reward.fingers}` : "";
    weeklyDesc += `**${q.name}**\n> ${q.desc} | ${status} | 보상: 💎${q.reward.crystals} ⭐${q.reward.xp} 🧪${q.reward.potion || 0}${fingerReward}\n\n`;
  }
  
  return new EmbedBuilder()
    .setTitle("📋 퀘스트")
    .setColor(0xF5C842)
    .addFields(
      { name: "🌞 일일 퀘스트 (매일 초기화)", value: dailyDesc || "완료된 퀘스트 없음", inline: false },
      { name: "📅 주간 퀘스트 (매주 초기화)", value: weeklyDesc || "완료된 퀘스트 없음", inline: false }
    )
    .setFooter({ text: "전투, 컬링 등을 진행하면 자동 달성!" });
}

function craftingEmbed(player) {
  let recipes = "";
  for (const [name, recipe] of Object.entries(CRAFTING_RECIPES)) {
    const can = canCraft(player, name) ? "✅" : "❌";
    const mats = Object.entries(recipe.materials).map(([m, n]) => `${m}: ${n}`).join(", ");
    recipes += `**${name}** ${can}\n> ${recipe.desc}\n> 필요: ${mats}\n\n`;
  }
  
  let inv = "**📦 보유 재료**\n";
  if (player.materials && Object.keys(player.materials).length > 0) {
    for (const [mat, amt] of Object.entries(player.materials)) {
      inv += `> ${mat}: ${amt}개\n`;
    }
  } else {
    inv += "> 보유한 재료가 없습니다.\n";
  }
  
  return new EmbedBuilder()
    .setTitle("🔨 제작 시스템")
    .setColor(0xF5C842)
    .setDescription(recipes)
    .addFields({ name: inv, value: "!제작 [아이템이름] 으로 제작 가능", inline: false });
}

function gachaResultEmbed(charId, isNew, player) {
  const ch = CHARACTERS[charId];
  const skill = getCurrentSkill(player, charId);
  const fx = getSkillEffect(skill.name);
  
  return new EmbedBuilder()
    .setTitle(isNew ? `✨ NEW! ${ch.name} 획득!` : `🔄 중복 - ${ch.name} (+50💎)`)
    .setColor(isNew ? 0xF5C842 : 0x4a5568)
    .setDescription(`${fx.art}\n**${ch.emoji} ${ch.name}** [${ch.grade}]\n> ${skill.name} - 피해 ${skill.dmg}\n> *"${ch.skills[0].desc}"*`)
    .setFooter({ text: `💎 잔여 크리스탈: ${player.crystals}` });
}

function cullingEmbed(player, session) {
  const enemy = session.currentEnemy;
  const stats = getPlayerStats(player);
  return new EmbedBuilder()
    .setTitle(`🌊 컬링 게임 - WAVE ${session.wave}`)
    .setColor(0x7C5CFC)
    .setDescription(`${enemy.emoji} **${enemy.name}**\n${hpBar(session.enemyHp, enemy.hp)} ${session.enemyHp}/${enemy.hp}`)
    .addFields(
      { name: "내 상태", value: `${hpBar(player.hp, stats.maxHp)} ${player.hp}/${stats.maxHp}\n상태: ${statusStr(player.statusEffects)}`, inline: true },
      { name: "획득", value: `✨ ${session.totalXp} XP\n💎 ${session.totalCrystals}`, inline: true }
    );
}

function jujutsuEmbed(player, session, choices = null) {
  const stats = getPlayerStats(player);
  const embed = new EmbedBuilder()
    .setTitle(`🎯 사멸회유 - ${session.points}/10 포인트`)
    .setColor(0xF5C842)
    .setDescription(`내 HP: ${hpBar(player.hp, stats.maxHp)} ${player.hp}/${stats.maxHp}\n획득: ${session.totalXp} XP, ${session.totalCrystals}💎`);
  
  if (session.currentEnemy) {
    const enemy = session.currentEnemy;
    embed.addFields({ name: `${enemy.emoji} 현재 적`, value: `${hpBar(session.enemyHp, enemy.hp)} ${session.enemyHp}/${enemy.hp} (+${enemy.points}점)`, inline: true });
  }
  if (choices && choices.length > 0) {
    embed.addFields({ name: "⚔️ 적 선택", value: choices.map((c, i) => `**[${i + 1}]** ${c.emoji} ${c.name} (+${c.points}점)`).join("\n"), inline: false });
  }
  return embed;
}

// ==================== 버튼 ====================
function mkBattleButtons(player) {
  const canSkill = player.skillCooldown <= 0;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("b_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player.skillCooldown})`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("b_reverse").setLabel("♻ 반전").setStyle(ButtonStyle.Secondary).setDisabled(!REVERSE_CHARS.has(player.active)),
    new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary)
  );
}

function mkCullingButtons(player) {
  const canSkill = player.skillCooldown <= 0;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player.skillCooldown})`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("c_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary)
  );
}

function mkJujutsuButtons(player, choices) {
  const row = new ActionRowBuilder();
  for (let i = 0; i < Math.min(choices.length, 3); i++) {
    row.addComponents(new ButtonBuilder().setCustomId(`j_choice_${i}`).setLabel(`⚔️ ${choices[i].name}`).setStyle(ButtonStyle.Primary));
  }
  const canSkill = player.skillCooldown <= 0;
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("j_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 술식${canSkill ? "" : `(${player.skillCooldown})`}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("j_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary)
  );
  return [row, actionRow];
}

// ==================== 전투 핸들러 ====================
async function handleBattle(interaction, player, battle, action) {
  const enemy = battle.enemy;
  
  if (action === "b_attack") {
    const bf = checkBlackFlash(interaction.user.id);
    let dmg = calcDmgForPlayer(player, enemy.def);
    if (bf.success) dmg = Math.floor(dmg * bf.mult);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    
    const fx = getSkillEffect("주먹질");
    await interaction.update({ content: `${fx.art}\n⚔ ${dmg} 데미지!${bf.success ? ` 🌑 흑섬 ${bf.mult}배! (연속 ${bf.streak}회)` : ""}`, components: [mkBattleButtons(player)] });
    
    if (enemy.currentHp <= 0) {
      const xpGain = enemy.xp;
      const crystalGain = enemy.crystals;
      player.xp += xpGain;
      player.crystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + (enemy.masteryXp || 1);
      player.wins++;
      const drops = dropMaterials(enemy.grade || "3급");
      addMaterials(player, drops);
      updateQuestProgress(player, "battle_win", 1);
      if (bf.success) updateQuestProgress(player, "black_flash", 1);
      delete battles[interaction.user.id];
      const embed = new EmbedBuilder().setTitle("🏆 승리!").setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${enemy.masteryXp || 1} 숙련도\n📦 획득: ${Object.entries(drops).map(([n,a])=>`${n}+${a}`).join(", ") || "없음"}`);
      await interaction.editReply({ embeds: [embed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "b_skill") {
    const skill = getCurrentSkill(player, player.active);
    const bf = checkBlackFlash(interaction.user.id);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    if (bf.success) dmg = Math.floor(dmg * bf.mult);
    enemy.currentHp = Math.max(0, enemy.currentHp - dmg);
    player.skillCooldown = 5;
    
    const fx = getSkillEffect(skill.name);
    await interaction.update({ content: `${fx.art}\n🌀 ${skill.name}! ${dmg} 데미지!${bf.success ? ` 🌑 흑섬 ${bf.mult}배!` : ""}\n> *"${fx.flavorText}"*`, components: [mkBattleButtons(player)] });
    
    if (enemy.currentHp <= 0) {
      const xpGain = enemy.xp;
      const crystalGain = enemy.crystals;
      player.xp += xpGain;
      player.crystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + (enemy.masteryXp || 2);
      player.wins++;
      const drops = dropMaterials(enemy.grade || "3급");
      addMaterials(player, drops);
      updateQuestProgress(player, "battle_win", 1);
      if (bf.success) updateQuestProgress(player, "black_flash", 1);
      delete battles[interaction.user.id];
      const embed = new EmbedBuilder().setTitle("🏆 승리!").setColor(0xF5C842)
        .setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎, +${enemy.masteryXp || 2} 숙련도\n📦 획득: ${Object.entries(drops).map(([n,a])=>`${n}+${a}`).join(", ") || "없음"}`);
      await interaction.editReply({ embeds: [embed], components: [] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "b_reverse" && REVERSE_CHARS.has(player.active)) {
    const stats = getPlayerStats(player);
    const healAmount = Math.floor(stats.maxHp * 0.4);
    player.hp = Math.min(stats.maxHp, player.hp + healAmount);
    await interaction.update({ content: `♻ 반전술식! ${healAmount} HP 회복!`, components: [mkBattleButtons(player)] });
  }
  
  if (action === "b_run") {
    delete battles[interaction.user.id];
    await interaction.update({ content: "🏃 전투에서 도주했습니다!", components: [] });
    return;
  }
  
  // 적 턴
  const enemyDmg = Math.max(1, Math.floor(enemy.atk * (0.7 + Math.random() * 0.6) - getPlayerStats(player).def * 0.22));
  player.hp = Math.max(0, player.hp - enemyDmg);
  await interaction.followUp({ content: `💥 ${enemy.name}의 공격! ${enemyDmg} 데미지! (남은 HP: ${player.hp})`, ephemeral: false });
  
  if (player.hp <= 0) {
    player.losses++;
    delete battles[interaction.user.id];
    await interaction.editReply({ content: "💀 패배했습니다...", components: [] });
  }
  
  if (player.skillCooldown > 0) player.skillCooldown--;
  savePlayer(interaction.user.id);
}

// ==================== 컬링 핸들러 ====================
async function handleCulling(interaction, player, culling, action) {
  const enemy = culling.currentEnemy;
  
  if (action === "c_attack") {
    const bf = checkBlackFlash(interaction.user.id);
    let dmg = calcDmgForPlayer(player, enemy.def);
    if (bf.success) dmg = Math.floor(dmg * bf.mult);
    culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    
    await interaction.update({ embeds: [cullingEmbed(player, culling)], components: [mkCullingButtons(player)] });
    
    if (culling.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      culling.totalXp += xpGain;
      culling.totalCrystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + (enemy.masteryXp || 1);
      const drops = dropMaterials(enemy.grade || "3급");
      addMaterials(player, drops);
      updateQuestProgress(player, "culling_wave", 1);
      if (bf.success) updateQuestProgress(player, "black_flash", 1);
      
      culling.wave++;
      const newEnemy = { ...ENEMIES[Math.min(culling.wave - 1, ENEMIES.length - 1)] };
      newEnemy.hp = Math.floor(newEnemy.hp * (1 + culling.wave * 0.05));
      newEnemy.atk = Math.floor(newEnemy.atk * (1 + culling.wave * 0.03));
      culling.currentEnemy = newEnemy;
      culling.enemyHp = newEnemy.hp;
      
      await interaction.editReply({ embeds: [cullingEmbed(player, culling).setDescription(`✅ 처치! +${xpGain} XP, +${crystalGain}💎\n📦 드랍: ${Object.entries(drops).map(([n,a])=>`${n}+${a}`).join(", ") || "없음"}`)], components: [mkCullingButtons(player)] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "c_skill") {
    const skill = getCurrentSkill(player, player.active);
    const bf = checkBlackFlash(interaction.user.id);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    if (bf.success) dmg = Math.floor(dmg * bf.mult);
    culling.enemyHp = Math.max(0, culling.enemyHp - dmg);
    player.skillCooldown = 5;
    
    const fx = getSkillEffect(skill.name);
    await interaction.update({ embeds: [cullingEmbed(player, culling)], components: [mkCullingButtons(player)] });
    await interaction.followUp({ content: `${fx.art}\n🌀 ${skill.name}! ${dmg} 데미지!${bf.success ? ` 🌑 흑섬 ${bf.mult}배!` : ""}`, ephemeral: false });
    
    if (culling.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      culling.totalXp += xpGain;
      culling.totalCrystals += crystalGain;
      player.mastery[player.active] = (player.mastery[player.active] || 0) + (enemy.masteryXp || 2);
      const drops = dropMaterials(enemy.grade || "3급");
      addMaterials(player, drops);
      updateQuestProgress(player, "culling_wave", 1);
      if (bf.success) updateQuestProgress(player, "black_flash", 1);
      
      culling.wave++;
      const newEnemy = { ...ENEMIES[Math.min(culling.wave - 1, ENEMIES.length - 1)] };
      newEnemy.hp = Math.floor(newEnemy.hp * (1 + culling.wave * 0.05));
      culling.currentEnemy = newEnemy;
      culling.enemyHp = newEnemy.hp;
      
      await interaction.editReply({ embeds: [cullingEmbed(player, culling).setDescription(`✅ 처치! +${xpGain} XP, +${crystalGain}💎`)], components: [mkCullingButtons(player)] });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "c_escape") {
    player.xp += culling.totalXp;
    player.crystals += culling.totalCrystals;
    delete cullings[interaction.user.id];
    await interaction.update({ content: `🏳 컬링 종료! 획득: +${culling.totalXp} XP, +${culling.totalCrystals}💎`, embeds: [], components: [] });
    savePlayer(interaction.user.id);
    return;
  }
  
  // 적 턴
  const enemyDmg = Math.max(1, Math.floor(enemy.atk * (0.7 + Math.random() * 0.6) - getPlayerStats(player).def * 0.22));
  player.hp = Math.max(0, player.hp - enemyDmg);
  await interaction.followUp({ content: `💥 ${enemy.name}의 공격! ${enemyDmg} 데미지!`, ephemeral: false });
  
  if (player.hp <= 0) {
    delete cullings[interaction.user.id];
    await interaction.editReply({ content: "💀 컬링에서 패배했습니다...", components: [] });
  }
  
  if (player.skillCooldown > 0) player.skillCooldown--;
  savePlayer(interaction.user.id);
}

// ==================== 사멸회유 핸들러 ====================
async function handleJujutsu(interaction, player, jujutsu, action) {
  const enemy = jujutsu.currentEnemy;
  
  if (action === "j_attack" && enemy) {
    const bf = checkBlackFlash(interaction.user.id);
    let dmg = calcDmgForPlayer(player, enemy.def);
    if (bf.success) dmg = Math.floor(dmg * bf.mult);
    jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - dmg);
    
    await interaction.update({ embeds: [jujutsuEmbed(player, jujutsu)], components: mkJujutsuButtons(player, [])[1] });
    
    if (jujutsu.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      jujutsu.totalXp += xpGain;
      jujutsu.totalCrystals += crystalGain;
      jujutsu.points += enemy.points;
      updateQuestProgress(player, "jujutsu_point", enemy.points);
      if (bf.success) updateQuestProgress(player, "black_flash", 1);
      
      if (jujutsu.points >= 10) {
        player.xp += jujutsu.totalXp;
        player.crystals += jujutsu.totalCrystals;
        delete jujutsus[interaction.user.id];
        await interaction.editReply({ content: `🏆 사멸회유 완료! +${jujutsu.totalXp} XP, +${jujutsu.totalCrystals}💎`, embeds: [], components: [] });
        savePlayer(interaction.user.id);
        return;
      }
      
      jujutsu.wave++;
      const newChoices = [...JUJUTSU_ENEMIES];
      jujutsu.choices = newChoices;
      jujutsu.currentEnemy = null;
      await interaction.editReply({ embeds: [jujutsuEmbed(player, jujutsu, newChoices)], components: mkJujutsuButtons(player, newChoices) });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "j_skill" && enemy) {
    const skill = getCurrentSkill(player, player.active);
    const bf = checkBlackFlash(interaction.user.id);
    let dmg = calcSkillDmgForPlayer(player, skill.dmg);
    if (bf.success) dmg = Math.floor(dmg * bf.mult);
    jujutsu.enemyHp = Math.max(0, jujutsu.enemyHp - dmg);
    player.skillCooldown = 5;
    
    const fx = getSkillEffect(skill.name);
    await interaction.update({ embeds: [jujutsuEmbed(player, jujutsu)], components: mkJujutsuButtons(player, [])[1] });
    await interaction.followUp({ content: `${fx.art}\n🌀 ${skill.name}! ${dmg} 데미지!`, ephemeral: false });
    
    if (jujutsu.enemyHp <= 0) {
      const xpGain = Math.floor(enemy.xp);
      const crystalGain = Math.floor(enemy.crystals);
      jujutsu.totalXp += xpGain;
      jujutsu.totalCrystals += crystalGain;
      jujutsu.points += enemy.points;
      updateQuestProgress(player, "jujutsu_point", enemy.points);
      if (bf.success) updateQuestProgress(player, "black_flash", 1);
      
      if (jujutsu.points >= 10) {
        player.xp += jujutsu.totalXp;
        player.crystals += jujutsu.totalCrystals;
        delete jujutsus[interaction.user.id];
        await interaction.editReply({ content: `🏆 사멸회유 완료! +${jujutsu.totalXp} XP, +${jujutsu.totalCrystals}💎`, embeds: [], components: [] });
        savePlayer(interaction.user.id);
        return;
      }
      
      jujutsu.wave++;
      const newChoices = [...JUJUTSU_ENEMIES];
      jujutsu.choices = newChoices;
      jujutsu.currentEnemy = null;
      await interaction.editReply({ embeds: [jujutsuEmbed(player, jujutsu, newChoices)], components: mkJujutsuButtons(player, newChoices) });
      savePlayer(interaction.user.id);
      return;
    }
  }
  
  if (action === "j_escape") {
    player.xp += jujutsu.totalXp;
    player.crystals += jujutsu.totalCrystals;
    delete jujutsus[interaction.user.id];
    await interaction.update({ content: `🏳 사멸회유 종료! 획득: +${jujutsu.totalXp} XP, +${jujutsu.totalCrystals}💎`, embeds: [], components: [] });
    savePlayer(interaction.user.id);
    return;
  }
  
  // 적 턴
  if (enemy) {
    const enemyDmg = Math.max(1, Math.floor(enemy.atk * (0.7 + Math.random() * 0.6) - getPlayerStats(player).def * 0.22));
    player.hp = Math.max(0, player.hp - enemyDmg);
    await interaction.followUp({ content: `💥 ${enemy.name}의 공격! ${enemyDmg} 데미지!`, ephemeral: false });
    
    if (player.hp <= 0) {
      delete jujutsus[interaction.user.id];
      await interaction.editReply({ content: "💀 사멸회유에서 패배했습니다...", components: [] });
    }
  }
  
  if (player.skillCooldown > 0) player.skillCooldown--;
  savePlayer(interaction.user.id);
}

// ==================== 봇 이벤트 ====================
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await initDB();
  players = await loadDB();
  console.log("🚀 주술회전 통합 봇 활성화");
  console.log("📋 명령어: !캐릭터선택, !프로필, !도감, !dev, !전투, !내정보, !술식, !퀘스트, !제작, !출석, !회복, !손가락, !컬링, !사멸회유, !가챠, !활성");
});

// 버튼 인터랙션
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  const player = getPlayer(userId, interaction.user.username);
  
  if (interaction.customId.startsWith("b_")) {
    const battle = battles[userId];
    if (!battle) return interaction.reply({ content: "진행 중인 전투 없음", ephemeral: true });
    await handleBattle(interaction, player, battle, interaction.customId);
    return;
  }
  
  if (interaction.customId.startsWith("c_")) {
    const culling = cullings[userId];
    if (!culling) return interaction.reply({ content: "진행 중인 컬링 없음", ephemeral: true });
    await handleCulling(interaction, player, culling, interaction.customId);
    return;
  }
  
  if (interaction.customId.startsWith("j_choice_")) {
    const jujutsu = jujutsus[userId];
    if (!jujutsu || !jujutsu.choices) return;
    const idx = parseInt(interaction.customId.split("_")[2]);
    const choice = jujutsu.choices[idx];
    if (choice) {
      jujutsu.currentEnemy = { ...choice, currentHp: choice.hp };
      jujutsu.enemyHp = choice.hp;
      jujutsu.choices = null;
      await interaction.update({ embeds: [jujutsuEmbed(player, jujutsu)], components: mkJujutsuButtons(player, [])[1] });
    }
    return;
  }
  
  if (interaction.customId.startsWith("j_")) {
    const jujutsu = jujutsus[userId];
    if (!jujutsu) return interaction.reply({ content: "진행 중인 사멸회유 없음", ephemeral: true });
    await handleJujutsu(interaction, player, jujutsu, interaction.customId);
    return;
  }
});

// 메시지 명령어
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  if (!content.startsWith("!")) return;
  
  const args = content.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const userId = message.author.id;
  let player = getPlayer(userId, message.author.username);
  
  // ===== GIF 프로필 명령어 =====
  if (cmd === "캐릭터선택") {
    const name = args[1];
    if (!name) return message.reply("사용법: !캐릭터선택 [이름]\n예: !캐릭터선택 고죠");
    if (!GIF_CHARACTERS[name]) return message.reply(`❌ 존재하지 않는 캐릭터\n사용 가능: ${Object.keys(GIF_CHARACTERS).join(", ")}`);
    gifUserData.set(userId, name);
    return message.reply(`✨ **${name}** (${GIF_CHARACTERS[name].title}) 캐릭터 장착 완료!`);
  }
  
  if (cmd === "프로필") {
    const selected = gifUserData.get(userId);
    if (!selected) return message.reply("⚠️ 먼저 !캐릭터선택 으로 캐릭터를 골라주세요!");
    try {
      const img = await renderGIF(message.author, GIF_CHARACTERS[selected]);
      return message.reply({ files: [img] });
    } catch(e) {
      console.error(e);
      return message.reply("❌ GIF 프로필 생성 실패");
    }
  }
  
  if (cmd === "도감") {
    let desc = "";
    for (const [name, data] of Object.entries(GIF_CHARACTERS)) {
      desc += `**${name}** - ${data.title}\n📖 ${data.desc}\n🎨 컬러: ${data.color}\n\n`;
    }
    const embed = new EmbedBuilder().setTitle("📚 주술회전 캐릭터 도감").setDescription(desc).setColor(0xff6b6b).setFooter({ text: `총 ${Object.keys(GIF_CHARACTERS).length}명 | !캐릭터선택 [이름] 으로 장착` });
    return message.reply({ embeds: [embed] });
  }
  
  if (cmd === "dev") {
    const embed = new EmbedBuilder().setTitle("👨‍💻 봇 개발자 정보").setColor(0x00ff00)
      .setDescription("**주술회전 통합 봇 v3.0**\n🎨 GIF 프로필 + RPG + 퀘스트 + 제작 + 흑섬 + 주력술식")
      .addFields(
        { name: "📋 명령어", value: "`!캐릭터선택` `!프로필` `!도감` `!dev`\n`!전투` `!컬링` `!사멸회유` `!내정보` `!술식` `!퀘스트` `!제작` `!가챠` `!활성` `!출석` `!회복` `!손가락`", inline: false },
        { name: "🎮 캐릭터", value: `${Object.keys(GIF_CHARACTERS).length}명 (GIF)\n${Object.keys(CHARACTERS).length}명 (RPG)`, inline: true },
        { name: "💡 팁", value: "공격 후 0.3~0.7초 사이 재공격 시 흑섬 발동!", inline: true }
      );
    return message.reply({ embeds: [embed] });
  }
  
  // ===== RPG 명령어 =====
  if (cmd === "전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중!");
    const enemy = { ...ENEMIES[0], currentHp: ENEMIES[0].hp };
    battles[userId] = { enemy };
    const stats = getPlayerStats(player);
    const embed = new EmbedBuilder().setTitle("⚔️ 전투 시작!").setColor(0xff0000)
      .setDescription(`**${enemy.name}** 등장!\n내 HP: ${player.hp}/${stats.maxHp}\n적 HP: ${enemy.currentHp}/${enemy.hp}`);
    await message.reply({ embeds: [embed], components: [mkBattleButtons(player)] });
  }
  
  if (cmd === "내정보") {
    await message.reply({ embeds: [profileEmbed(player)] });
  }
  
  if (cmd === "술식") {
    await message.reply({ embeds: [skillEmbed(player)] });
  }
  
  if (cmd === "퀘스트") {
    await message.reply({ embeds: [questEmbed(player)] });
  }
  
  if (cmd === "제작") {
    const itemName = args.slice(1).join(" ");
    if (!itemName) {
      await message.reply({ embeds: [craftingEmbed(player)] });
      return;
    }
    if (craftItem(player, itemName)) {
      savePlayer(userId);
      await message.reply(`✅ **${itemName}** 제작 성공!`);
    } else {
      await message.reply(`❌ 재료 부족 또는 존재하지 않는 아이템: ${itemName}`);
    }
  }
  
  if (cmd === "출석") {
    const now = Date.now();
    const last = player.lastDaily || 0;
    if (now - last < 86400000) {
      const remaining = Math.ceil((86400000 - (now - last)) / 3600000);
      return message.reply(`⏰ 이미 출석했습니다! ${remaining}시간 후 가능`);
    }
    const streakBonus = Math.min(player.dailyStreak || 0, 30);
    const totalCrystals = 100 + streakBonus * 5;
    player.crystals += totalCrystals;
    player.lastDaily = now;
    player.dailyStreak = (player.dailyStreak || 0) + 1;
    await message.reply(`✅ 출석 체크! +${totalCrystals}💎 (연속 ${player.dailyStreak}일)`);
    savePlayer(userId);
  }
  
  if (cmd === "회복") {
    if (player.potion <= 0) return message.reply("❌ 회복약이 없습니다! 전투에서 획득하세요.");
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    player.potion--;
    await message.reply(`✅ HP가 가득 회복되었습니다! (남은 회복약: ${player.potion}개)`);
    savePlayer(userId);
  }
  
  if (cmd === "손가락") {
    const fingers = player.sukunaFingers || 0;
    await message.reply(`👹 **스쿠나 손가락**: ${fingers}/20\n${fingers >= 20 ? "🔴 완전 각성!" : fingers >= 15 ? "🔴 각성 Lv.4" : fingers >= 10 ? "🟠 각성 Lv.3" : fingers >= 5 ? "🟡 각성 Lv.2" : fingers >= 1 ? "🟢 각성 Lv.1" : "봉인 중"}`);
  }
  
  if (cmd === "컬링") {
    if (cullings[userId]) return message.reply("🌊 이미 컬링 중!");
    const firstEnemy = { ...ENEMIES[0], hp: ENEMIES[0].hp, atk: ENEMIES[0].atk, def: ENEMIES[0].def, xp: ENEMIES[0].xp, crystals: ENEMIES[0].crystals };
    cullings[userId] = {
      wave: 1, kills: 0, totalXp: 0, totalCrystals: 0,
      currentEnemy: firstEnemy, enemyHp: firstEnemy.hp
    };
    await message.reply({ embeds: [cullingEmbed(player, cullings[userId])], components: [mkCullingButtons(player)] });
  }
  
  if (cmd === "사멸회유") {
    if (jujutsus[userId]) return message.reply("🎯 이미 사멸회유 중!");
    const choices = [...JUJUTSU_ENEMIES];
    jujutsus[userId] = {
      wave: 1, points: 0, totalXp: 0, totalCrystals: 0,
      choices, currentEnemy: null
    };
    await message.reply({ embeds: [jujutsuEmbed(player, jujutsus[userId], choices)], components: mkJujutsuButtons(player, choices) });
  }
  
  if (cmd === "가챠") {
    const count = parseInt(args[1]) || 1;
    if (count !== 1 && count !== 10) return message.reply("❌ 1회 또는 10회만 가능! 사용법: !가챠 1 또는 !가챠 10");
    const cost = count === 1 ? 150 : 1350;
    if (player.crystals < cost) return message.reply(`💎 크리스탈 부족! 필요: ${cost}`);
    
    player.crystals -= cost;
    const msg = await message.reply("🔮 주술 소환 의식 진행 중...");
    await new Promise(r => setTimeout(r, 2000));
    
    if (count === 1) {
      const result = rollGacha();
      const isNew = !player.owned.includes(result);
      if (isNew) player.owned.push(result);
      else player.crystals += 50;
      await msg.edit({ embeds: [gachaResultEmbed(result, isNew, player)] });
    } else {
      let results = [];
      let newOnes = [];
      let dupCrystals = 0;
      for (let i = 0; i < 10; i++) {
        const r = rollGacha();
        results.push(r);
        if (!player.owned.includes(r)) newOnes.push(r);
        else dupCrystals += 50;
      }
      for (const id of newOnes) player.owned.push(id);
      player.crystals += dupCrystals;
      
      const sorted = [...results].sort();
      const lines = sorted.map(id => {
        const ch = CHARACTERS[id];
        return `${ch.emoji} **${ch.name}** [${ch.grade}]${newOnes.includes(id) ? " ✨NEW!" : ""}`;
      }).join("\n");
      const embed = new EmbedBuilder().setTitle("🎲 10연차 결과").setColor(0x7C5CFC).setDescription(lines)
        .addFields({ name: "✨ 신규", value: newOnes.length ? newOnes.map(id => CHARACTERS[id].name).join(", ") : "없음", inline: true })
        .addFields({ name: "💎 보상", value: `+${dupCrystals}`, inline: true });
      await msg.edit({ embeds: [embed] });
    }
    savePlayer(userId);
  }
  
  if (cmd === "활성") {
    const charId = args[1];
    if (!charId) return message.reply("사용법: !활성 [캐릭터이름]\n예: !활성 고죠");
    if (!CHARACTERS[charId]) return message.reply(`❌ 존재하지 않는 캐릭터! 보유한 캐릭터: ${player.owned.join(", ")}`);
    if (!player.owned.includes(charId)) return message.reply("❌ 해당 캐릭터를 보유하지 않았습니다!");
    player.active = charId;
    const stats = getPlayerStats(player);
    player.hp = stats.maxHp;
    await message.reply(`✅ 활성 캐릭터를 **${CHARACTERS[charId].name}**(으)로 변경! HP가 회복되었습니다.`);
    savePlayer(userId);
  }
  
  if (cmd === "도움말") {
    const embed = new EmbedBuilder().setTitle("🔱 주술회전 통합 봇 명령어").setColor(0xF5C842)
      .setDescription(`
**🎨 GIF 프로필**
\`!캐릭터선택 [이름]\` - GIF 캐릭터 장착
\`!프로필\` - GIF 프로필 생성
\`!도감\` - 캐릭터 도감
\`!dev\` - 개발자 정보

**⚔️ RPG 전투**
\`!전투\` - 일반 전투
\`!컬링\` - 웨이브 컬링
\`!사멸회유\` - 포인트 모드
\`!내정보\` - 내 정보
\`!술식\` - 스킬 트리
\`!퀘스트\` - 일일/주간 퀘스트
\`!제작\` - 아이템 제작
\`!가챠 [1/10]\` - 캐릭터 뽑기
\`!활성 [이름]\` - 주력 변경
\`!출석\` - 매일 보상
\`!회복\` - HP 회복
\`!손가락\` - 스쿠나 손가락

**💡 흑섬 팁**: 공격 후 0.3~0.7초 사이 재공격 시 2.5배 데미지!
`);
    await message.reply({ embeds: [embed] });
  }
});

client.login(TOKEN);
