cat > /home/claude/bot.js << 'ENDOFFILE'
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
} = require("discord.js");

// ── GIF 프로필용 캔버스 (선택적 로드)
let createCanvas, loadImage, GIFEncoder;
try {
  ({ createCanvas, loadImage } = require("@napi-rs/canvas"));
  GIFEncoder = require("gif-encoder-2");
} catch(e) { console.log("⚠️ canvas/gif 라이브러리 없음 — GIF 프로필 비활성화"); }

// ════════════════════════════════════════════════════════
// ── HTTP 헬스체크
// ════════════════════════════════════════════════════════
const app = express();
app.get("/", (_, res) => res.send("🔱 주술회전 RPG 봇 가동 중"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 HTTP 포트 ${process.env.PORT || 3000}`));

// ════════════════════════════════════════════════════════
// ── PostgreSQL
// ════════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => console.error("PostgreSQL 풀 오류:", err.message));

async function dbInit() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS players (user_id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    console.log("✅ PostgreSQL 테이블 준비");
  } catch(e) { console.log("⚠️ DB 연결 실패, 메모리 모드"); }
}
async function dbLoad() {
  try {
    const res = await pool.query("SELECT user_id, data FROM players");
    const obj = {};
    for (const row of res.rows) obj[row.user_id] = row.data;
    console.log(`✅ DB 로드: ${res.rows.length}명`);
    return obj;
  } catch(e) { console.log("⚠️ DB 로드 실패"); return {}; }
}
async function dbSave(userId, data) {
  try {
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO players(user_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET data=$2,updated_at=NOW()`,
        [userId, JSON.stringify(data)]
      );
    } finally { c.release(); }
  } catch(e) { console.error(`DB 저장 오류[${userId}]:`, e.message); }
}
const saveQueue = new Map(), savePending = new Set();
function savePlayer(userId) {
  if (!players[userId]) return;
  if (saveQueue.has(userId)) clearTimeout(saveQueue.get(userId));
  const t = setTimeout(async () => {
    saveQueue.delete(userId);
    if (savePending.has(userId)) { savePlayer(userId); return; }
    savePending.add(userId);
    try { await dbSave(userId, players[userId]); }
    catch(e) { setTimeout(() => savePlayer(userId), 5000); }
    finally { savePending.delete(userId); }
  }, 300);
  saveQueue.set(userId, t);
}
async function savePlayerNow(userId) {
  if (!players[userId]) return;
  if (saveQueue.has(userId)) { clearTimeout(saveQueue.get(userId)); saveQueue.delete(userId); }
  savePending.add(userId);
  try { await dbSave(userId, players[userId]); }
  catch(e) { setTimeout(() => savePlayer(userId), 3000); }
  finally { savePending.delete(userId); }
}
setInterval(async () => {
  for (const uid of Object.keys(players)) {
    if (!saveQueue.has(uid) && !savePending.has(uid)) {
      try { await dbSave(uid, players[uid]); } catch(e) {}
    }
  }
}, 3*60*1000);

// ════════════════════════════════════════════════════════
// ── Discord 클라이언트
// ════════════════════════════════════════════════════════
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error("❌ DISCORD_TOKEN 없음!"); process.exit(1); }

const DEV_IDS = new Set(["1284771557633425470","1397218266505678881"]);
const isDev = (id) => DEV_IDS.has(id);

// ════════════════════════════════════════════════════════
// ── 등급/색상
// ════════════════════════════════════════════════════════
const JJK_GRADE_COLOR = {
  "특급":0xF5C842,"준특급":0xff8c00,"1급":0x7C5CFC,"준1급":0x9b72cf,
  "2급":0x4ade80,"3급":0x94a3b8,"4급":0x64748b,
};
const JJK_GRADE_EMOJI = {
  "특급":"🔱","준특급":"💠","1급":"⭐⭐","준1급":"⭐","2급":"🔹🔹","3급":"🔹","4급":"◽",
};
const JJK_GRADE_LABEL = {
  "특급":"【 특 급 】","준특급":"【준특급】","1급":"【 1 급 】","준1급":"【준 1급】",
  "2급":"【 2 급 】","3급":"【 3 급 】","4급":"【 4 급 】",
};

// ════════════════════════════════════════════════════════
// ── 상태이상
// ════════════════════════════════════════════════════════
const STATUS_EFFECTS = {
  poison:{ id:"poison",name:"독",emoji:"☠️",desc:"매 턴 최대HP의 5% 피해",duration:3 },
  burn:{ id:"burn",name:"화상",emoji:"🔥",desc:"매 턴 최대HP의 8% 피해",duration:2 },
  freeze:{ id:"freeze",name:"빙결",emoji:"❄️",desc:"1턴 행동 불가",duration:1 },
  weaken:{ id:"weaken",name:"약화",emoji:"💔",desc:"공격력 30% 감소",duration:2 },
  stun:{ id:"stun",name:"기절",emoji:"⚡",desc:"1턴 행동 불가",duration:1 },
  battleInstinct:{ id:"battleInstinct",name:"전투본능",emoji:"🔥💪",desc:"공격력 40% 증가, 회피율 25% 증가",duration:3 },
};
function applyStatus(target, statusId) {
  if (!target.statusEffects) target.statusEffects = [];
  const ex = target.statusEffects.find(s => s.id === statusId);
  if (ex) ex.turns = STATUS_EFFECTS[statusId].duration;
  else target.statusEffects.push({ id:statusId, turns:STATUS_EFFECTS[statusId].duration });
}
function tickStatus(target, maxHp) {
  if (!target.statusEffects || !target.statusEffects.length) return { dmg:0, expired:[], log:[] };
  let totalDmg=0; const expired=[],log=[];
  for (const se of target.statusEffects) {
    const def = STATUS_EFFECTS[se.id];
    if (!def) { se.turns=0; continue; }
    if (se.id==="poison") { const d=Math.max(1,Math.floor(maxHp*0.05)); totalDmg+=d; log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`); }
    if (se.id==="burn")   { const d=Math.max(1,Math.floor(maxHp*0.08)); totalDmg+=d; log.push(`${def.emoji} **${def.name}** — **${d}** 피해!`); }
    se.turns--;
    if (se.turns<=0) expired.push(se.id);
  }
  target.statusEffects = target.statusEffects.filter(s=>s.turns>0);
  if (totalDmg>0) target.hp = Math.max(0, target.hp - totalDmg);
  return { dmg:totalDmg, expired, log };
}
function statusStr(se) {
  if (!se||!se.length) return "없음";
  return se.map(s=>`${STATUS_EFFECTS[s.id]?.emoji||""}${STATUS_EFFECTS[s.id]?.name||s.id}(${s.turns}턴)`).join(" ");
}
function isIncapacitated(se) { return !!(se&&se.some(s=>s.id==="freeze"||s.id==="stun")); }
function getWeakenMult(se) {
  let m=1;
  if (se&&se.some(s=>s.id==="weaken")) m*=0.7;
  if (se&&se.some(s=>s.id==="battleInstinct")) m*=1.4;
  return m;
}
function getBattleInstinctEvade(se) { return !!(se&&se.some(s=>s.id==="battleInstinct")); }
function rollHit(defenderSE) {
  const base=0.05, bonus=getBattleInstinctEvade(defenderSE)?0.25:0;
  return Math.random()>(base+bonus);
}

// ════════════════════════════════════════════════════════
// ── 흑섬(Black Flash) 시스템
// ════════════════════════════════════════════════════════
// 흑섬: 공격/술식 시 일정 확률로 발동, 연속 공격 성공 시 타이밍 창 열림
const BLACK_FLASH_BASE_CHANCE = 0.15; // 기본 15%
const BLACK_FLASH_STREAK_BONUS = 0.10; // 연속 공격마다 +10%
const BLACK_FLASH_MULTIPLIER = 2.5;   // 데미지 2.5배

function rollBlackFlash(player) {
  const streakBonus = Math.min((player.attackStreak||0)*BLACK_FLASH_STREAK_BONUS, 0.40);
  const chance = BLACK_FLASH_BASE_CHANCE + streakBonus;
  return Math.random() < chance;
}

// ════════════════════════════════════════════════════════
// ── 주력 술식(Signature Technique) 시스템
// ════════════════════════════════════════════════════════
// 특정 술식을 충분히 사용하면 "주력 술식"으로 지정 → 강화 효과
const SIG_TECH_THRESHOLD = 50; // 해당 술식 50회 사용 시 주력 지정 가능
const SIG_TECH_BONUS = {
  dmgMult: 1.35,       // 데미지 35% 증가
  cdReduce: 2,         // 쿨다운 2 감소
  statusChanceBonus: 0.20, // 상태이상 확률 20% 상승
};

function getSigTechBonus(player, skillName) {
  if (player.sigTech && player.sigTech === skillName) return SIG_TECH_BONUS;
  return { dmgMult:1, cdReduce:0, statusChanceBonus:0 };
}

function trackSkillUse(player, skillName) {
  if (!player.skillUseCount) player.skillUseCount = {};
  player.skillUseCount[skillName] = (player.skillUseCount[skillName]||0)+1;
}

function canSetSigTech(player, skillName) {
  return (player.skillUseCount?.[skillName]||0) >= SIG_TECH_THRESHOLD;
}

// ════════════════════════════════════════════════════════
// ── 스쿠나 손가락
// ════════════════════════════════════════════════════════
const SUKUNA_FINGER_MAX = 20;
function getFingerBonus(fingers) {
  return {
    atkBonus: Math.floor(fingers*10),
    defBonus: Math.floor(fingers*6),
    hpBonus: fingers*200,
    label: fingers>=20?"🔴 스쿠나 완전 각성":fingers>=15?"🔴 스쿠나 각성 Lv.4":fingers>=10?"🟠 스쿠나 각성 Lv.3":fingers>=5?"🟡 스쿠나 각성 Lv.2":fingers>=1?"🟢 스쿠나 각성 Lv.1":"스쿠나 봉인 중",
  };
}

// ════════════════════════════════════════════════════════
// ── 코가네 펫
// ════════════════════════════════════════════════════════
const KOGANE_GRADES = {
  "전설":{ color:0xF5C842,emoji:"🌟",stars:"★★★★★",rate:0.5,atkBonus:0.25,defBonus:0.20,hpBonus:0.20,xpBonus:0.30,crystalBonus:0.25,skill:"황금 포효",skillDesc:"전투 시작 시 적에게 추가 피해(ATK의 50%)",skillChance:0.35,passiveDesc:"ATK+25% DEF+20% HP+20% XP+30% 크리스탈+25%" },
  "특급":{ color:0xff8c00,emoji:"🔶",stars:"★★★★☆",rate:2.0,atkBonus:0.18,defBonus:0.15,hpBonus:0.15,xpBonus:0.20,crystalBonus:0.18,skill:"황금 이빨",skillDesc:"공격 시 15% 확률로 약화 부여",skillChance:0.15,passiveDesc:"ATK+18% DEF+15% HP+15% XP+20% 크리스탈+18%" },
  "1급":{ color:0x7C5CFC,emoji:"🔷",stars:"★★★☆☆",rate:8.0,atkBonus:0.12,defBonus:0.10,hpBonus:0.10,xpBonus:0.12,crystalBonus:0.10,skill:"황금 발톱",skillDesc:"공격 시 10% 확률로 추가타(ATK의 30%)",skillChance:0.10,passiveDesc:"ATK+12% DEF+10% HP+10% XP+12% 크리스탈+10%" },
  "2급":{ color:0x4ade80,emoji:"🟢",stars:"★★☆☆☆",rate:22.5,atkBonus:0.07,defBonus:0.06,hpBonus:0.06,xpBonus:0.07,crystalBonus:0.06,skill:"황금 보호막",skillDesc:"HP 30% 이하 시 1회 피해 50% 감소",skillChance:1.0,passiveDesc:"ATK+7% DEF+6% HP+6% XP+7% 크리스탈+6%" },
  "3급":{ color:0x94a3b8,emoji:"⚪",stars:"★☆☆☆☆",rate:67.0,atkBonus:0.03,defBonus:0.02,hpBonus:0.02,xpBonus:0.03,crystalBonus:0.02,skill:"황금 냄새",skillDesc:"전투 후 크리스탈 +5% 추가 획득",skillChance:1.0,passiveDesc:"ATK+3% DEF+2% HP+2% XP+3% 크리스탈+2%" },
};
const KOGANE_POOL = Object.entries(KOGANE_GRADES).map(([grade,g])=>({grade,rate:g.rate}));
function rollKogane() {
  const total = KOGANE_POOL.reduce((s,p)=>s+p.rate,0);
  let r = Math.random()*total;
  for (const e of KOGANE_POOL) { r-=e.rate; if(r<=0) return e.grade; }
  return "3급";
}
function getKoganeBonus(player) {
  if (!player.kogane?.grade) return {atk:1,def:1,hp:1,xp:1,crystal:1};
  const g = KOGANE_GRADES[player.kogane.grade];
  if (!g) return {atk:1,def:1,hp:1,xp:1,crystal:1};
  return { atk:1+g.atkBonus, def:1+g.defBonus, hp:1+g.hpBonus, xp:1+g.xpBonus, crystal:1+g.crystalBonus };
}

// ════════════════════════════════════════════════════════
// ── GIF 캐릭터 테마 (프로필용)
// ════════════════════════════════════════════════════════
const GIF_CHAR_THEMES = {
  itadori:{ color:"#f97316",glow:"#fb923c",title:"Vessel of Sukuna" },
  gojo:{ color:"#60a5fa",glow:"#3b82f6",title:"The Strongest" },
  megumi:{ color:"#1e293b",glow:"#334155",title:"Ten Shadows" },
  nobara:{ color:"#ec4899",glow:"#db2777",title:"Straw Doll" },
  nanami:{ color:"#facc15",glow:"#eab308",title:"Salaryman Sorcerer" },
  sukuna:{ color:"#ef4444",glow:"#dc2626",title:"King of Curses" },
  geto:{ color:"#a855f7",glow:"#9333ea",title:"Curse Manipulator" },
  maki:{ color:"#84cc16",glow:"#65a30d",title:"Heavenly Restriction" },
  panda:{ color:"#22c55e",glow:"#16a34a",title:"Cursed Corpse" },
  inumaki:{ color:"#38bdf8",glow:"#0ea5e9",title:"Cursed Speech" },
  yuta:{ color:"#d1d5db",glow:"#9ca3af",title:"Special Grade" },
  higuruma:{ color:"#f43f5e",glow:"#e11d48",title:"Judgement Sorcerer" },
  jogo:{ color:"#fb7185",glow:"#ef4444",title:"Volcano Curse" },
  dagon:{ color:"#06b6d4",glow:"#0891b2",title:"Ocean Curse" },
  hanami:{ color:"#10b981",glow:"#059669",title:"Nature Curse" },
  mahito:{ color:"#a78bfa",glow:"#8b5cf6",title:"Soul Manipulator" },
  todo:{ color:"#f59e0b",glow:"#d97706",title:"Boogie Woogie" },
  hakari:{ color:"#fde047",glow:"#facc15",title:"Gambler Domain" },
};

function roundRectPath(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

async function renderGIF(user, charId) {
  if (!createCanvas||!loadImage||!GIFEncoder) return null;
  const theme = GIF_CHAR_THEMES[charId]||{color:"#7c5cfc",glow:"#9b72cf",title:"Jujutsu Sorcerer"};
  const w=900,h=350;
  const encoder = new GIFEncoder(w,h);
  encoder.setRepeat(0); encoder.setDelay(70); encoder.setQuality(20); encoder.start();
  const canvas = createCanvas(w,h);
  const ctx = canvas.getContext("2d");
  let avatar;
  try { avatar = await loadImage(user.displayAvatarURL({extension:"png",size:512})); } catch(e) { return null; }
  for (let i=0;i<22;i++) {
    const pulse=Math.sin(i*0.3)*12, shake=Math.sin(i*0.5)*3;
    ctx.fillStyle="#0b0f1a"; ctx.fillRect(0,0,w,h);
    ctx.shadowColor=theme.glow; ctx.shadowBlur=35;
    const grad=ctx.createLinearGradient(0,0,w,h);
    grad.addColorStop(0,theme.color); grad.addColorStop(1,"#000");
    ctx.fillStyle=grad; roundRectPath(ctx,60,60+pulse,780,240,25); ctx.fill();
    ctx.shadowBlur=0;
    ctx.save(); ctx.beginPath(); ctx.arc(160+shake,180,80,0,Math.PI*2); ctx.clip();
    ctx.drawImage(avatar,80,100,160,160); ctx.restore();
    ctx.strokeStyle=theme.glow; ctx.lineWidth=6;
    ctx.beginPath(); ctx.arc(160,180,90+pulse,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle="#fff"; ctx.font="bold 34px sans-serif"; ctx.fillText(user.username,280,170);
    ctx.fillStyle="#93c5fd"; ctx.font="20px sans-serif"; ctx.fillText(theme.title,280,210);
    const ch=CHARACTERS[charId];
    if(ch){ ctx.fillStyle="#a5f3fc"; ctx.font="16px sans-serif"; ctx.fillText(`${ch.emoji} ${ch.name} [${ch.grade}]`,280,245); }
    encoder.addFrame(ctx);
  }
  encoder.finish();
  return new AttachmentBuilder(encoder.out.getData(),{name:"profile.gif"});
}

// ════════════════════════════════════════════════════════
// ── 스킬 이펙트 아트
// ════════════════════════════════════════════════════════
const SKILL_EFFECTS = {
  "주먹질":{ art:"```\n  💥  \n ▓▓▓▓▓\n  💥  \n```",color:0xff6b35,flavorText:"저주 에너지를 주먹에 집중시킨다!" },
  "다이버전트 주먹":{ art:"```\n ⚡💥⚡\n▓▓▓▓▓▓▓\n ⚡💥⚡\n```",color:0xff4500,flavorText:"발산하는 저주 에너지 — 몸의 내부에서 폭발!" },
  "흑섬":{ art:"```\n🌑🌑🌑🌑🌑\n⬛ 黑 閃 ⬛\n🌑🌑🌑🌑🌑\n```",color:0x1a0a2e,flavorText:"순간적으로 발산되는 최대 저주 에너지!" },
  "어주자":{ art:"```\n👹✨👹✨👹\n✨ 廻 夏 ✨\n👹✨👹✨👹\n```",color:0xb5451b,flavorText:"스쿠나의 힘이 몸을 가득 채운다..." },
  "스쿠나 발현":{ art:"```\n🔴👹🔴👹🔴\n👹 両 面 宿 儺 👹\n🔴👹🔴👹🔴\n```",color:0x8b0000,flavorText:"저주의 왕이 이타도리의 몸을 장악한다!" },
  "아오":{ art:"```\n  🔵🔵🔵  \n🔵  蒼  🔵\n  🔵🔵🔵  \n```",color:0x0066ff,flavorText:"무한에 의한 인력 — 모든 것을 끌어당긴다" },
  "아카":{ art:"```\n  🔴🔴🔴  \n🔴  赫  🔴\n  🔴🔴🔴  \n```",color:0xff0033,flavorText:"무한에 의한 척력 — 모든 것을 날려버린다" },
  "무라사키":{ art:"```\n🔴⚡🔵⚡🔴\n⚡  紫  ⚡\n🔵⚡🔴⚡🔵\n```",color:0x9900ff,flavorText:"아오와 아카의 융합 — 허공을 찢는 허수!" },
  "무량공처":{ art:"```\n∞∞∞∞∞∞∞∞∞\n∞ 無 量 空 処 ∞\n∞∞∞∞∞∞∞∞∞\n```",color:0x00ffff,flavorText:"\"나는 최강이니까\" — 무한이 세계를 지배한다" },
  "옥견":{ art:"```\n  🐕🐕🐕  \n🐕  玉  🐕\n  🐕🐕🐕  \n```",color:0x4a4a8a,flavorText:"식신 옥견 소환!" },
  "탈토":{ art:"```\n  🐯🐯🐯  \n🐯  脱  🐯\n  🐯🐯🐯  \n```",color:0xff8800,flavorText:"식신 대호 소환 — 강력한 발톱이 적을 찢는다!" },
  "만상":{ art:"```\n🌑🐕🌑🐯🌑\n🐯 萬 象 🐕\n🌑🐯🌑🐕🌑\n```",color:0x2d1b69,flavorText:"열 가지 식신이 일제히 소환된다!" },
  "후루베 유라유라":{ art:"```\n💀✨💀✨💀\n✨ 振 魂 ✨\n💀✨💀✨💀\n```",color:0x8b0000,flavorText:"마허라가라 강림 — 최강의 식신이 깨어난다!" },
  "망치질":{ art:"```\n  🔨🔨🔨  \n⚡  釘  ⚡\n  🔨🔨🔨  \n```",color:0xff69b4,flavorText:"저주 못을 적의 영혼에 박아넣는다!" },
  "공명":{ art:"```\n🌸💥🌸💥🌸\n💥 共 鳴 💥\n🌸💥🌸💥🌸\n```",color:0xff1493,flavorText:"허수아비를 통한 공명 피해 — 영혼이 직접 타격된다!" },
  "철정":{ art:"```\n⚡🔨⚡🔨⚡\n🔨 鉄 釘 🔨\n⚡🔨⚡🔨⚡\n```",color:0xdc143c,flavorText:"저주 에너지 주입 — 못이 몸 속에서 폭발한다!" },
  "발화":{ art:"```\n🔥🌸🔥🌸🔥\n🌸 発 火 🌸\n🔥🌸🔥🌸🔥\n```",color:0xff4500,flavorText:"모든 못에 동시 폭발 공명 — 영혼이 불타오른다!" },
  "해":{ art:"```\n  ✂️✂️✂️  \n✂️  解  ✂️\n  ✂️✂️✂️  \n```",color:0xcc0000,flavorText:"만물을 베어내는 저주의 왕의 손톱!" },
  "팔":{ art:"```\n🌌✂️🌌✂️🌌\n✂️  捌  ✂️\n🌌✂️🌌✂️🌌\n```",color:0x8b0000,flavorText:"공간 자체를 베어내는 절대적 술식!" },
  "푸가":{ art:"```\n💀🔥💀🔥💀\n🔥 不 雅 🔥\n💀🔥💀🔥💀\n```",color:0x4a0000,flavorText:"닿는 모든 것을 분해한다 — 저주의 왕의 진면목!" },
  "복마어주자":{ art:"```\n👑🌑👑🌑👑\n🌑伏魔御廚子🌑\n👑🌑👑🌑👑\n```",color:0x2a0000,flavorText:"천지개벽 — 저주의 왕의 궁극 영역전개!" },
  "모방술식":{ art:"```\n  🌟🌟🌟  \n🌟  模  🌟\n  🌟🌟🌟  \n```",color:0xffd700,flavorText:"타인의 술식을 완벽하게 복사한다!" },
  "리카 소환":{ art:"```\n💜👸💜👸💜\n👸  里  香  👸\n💜👸💜👸💜\n```",color:0x9400d3,flavorText:"저주의 여왕 리카 소환 — 최강의 저주된 영혼!" },
  "순애빔":{ art:"```\n💜💛💜💛💜\n💛 純 愛 砲 💛\n💜💛💜💛💜\n```",color:0xff00ff,flavorText:"사랑의 에너지가 파괴적인 빔으로 변환된다!" },
  "진안상애":{ art:"```\n🌟💜🌟💜🌟\n💜真贋相愛💜\n🌟💜🌟💜🌟\n```",color:0x6600cc,flavorText:"사랑과 저주의 경계가 무너진다 — 궁극의 영역!" },
  "부기우기":{ art:"```\n🎵💪🎵💪🎵\n💪 Boogie 💪\n🎵💪🎵💪🎵\n```",color:0x1e90ff,flavorText:"\"댄스홀 가수!\" — 보조공격술 위치 전환! 빙결의 한기!" },
  "브루탈 펀치":{ art:"```\n💥🔥💥🔥💥\n🔥BRUTAL🔥\n💥🔥💥🔥💥\n```",color:0xff2200,flavorText:"최대 저주력을 실은 파괴적 일격!" },
  "전투본능":{ art:"```\n⚔️🔥⚔️🔥⚔️\n🔥戦闘本能🔥\n⚔️🔥⚔️🔥⚔️\n```",color:0xff8c00,flavorText:"전사의 본능이 각성한다! 공격력·회피 극대화!" },
  "둔기 공격":{ art:"```\n  🔨🔨🔨  \n💼  NA  💼\n  🔨🔨🔨  \n```",color:0xcc8800,flavorText:"단단한 둔기로 정확한 타격!" },
  "칠할삼분":{ art:"```\n7️⃣3️⃣7️⃣3️⃣7️⃣\n  7  :  3  \n7️⃣3️⃣7️⃣3️⃣7️⃣\n```",color:0xff6600,flavorText:"7:3의 비율 — 약점을 정확히 관통한다!" },
  "십수할":{ art:"```\n💢💢💢💢💢\n  十 數 割  \n💢💢💢💢💢\n```",color:0xcc3300,flavorText:"열 배의 저주 에너지를 한계까지 방출!" },
  "초과근무":{ art:"```\n⏰💥⏰💥⏰\n💥 殘 業 💥\n⏰💥⏰💥⏰\n```",color:0xff0000,flavorText:"\"초과 근무는 사절이지만... 이건 일이 아니다.\"" },
  "험한 도박":{ art:"```\n🎰💥🎰💥🎰\n💥 賭 博 💥\n🎰💥🎰💥🎰\n```",color:0xffd700,flavorText:"운을 믿어라! 도박사의 일격!" },
  "질풍열차":{ art:"```\n🚂💨🚂💨🚂\n💨 疾 風 💨\n🚂💨🚂💨🚂\n```",color:0xff8800,flavorText:"질풍처럼 돌진하는 강력한 타격!" },
  "유한 소설":{ art:"```\n📖✨📖✨📖\n✨ 有 限 ✨\n📖✨📖✨📖\n```",color:0x44ccff,flavorText:"불멸의 몸으로 한계를 초월한다!" },
  "질풍강운":{ art:"```\n🎰⚡🎰⚡🎰\n⚡疾風強運⚡\n🎰⚡🎰⚡🎰\n```",color:0xf5c842,flavorText:"운이 터진다! 영역전개 — 질풍강운!" },
  "_default":{ art:"```\n  ✨✨✨  \n✨ 術 式 ✨\n  ✨✨✨  \n```",color:0x7c5cfc,flavorText:"저주 에너지가 폭발한다!" },
};
function getSkillEffect(name) { return SKILL_EFFECTS[name]||SKILL_EFFECTS["_default"]; }

// ════════════════════════════════════════════════════════
// ── 캐릭터 데이터
// ════════════════════════════════════════════════════════
const CHARACTERS = {
  itadori:{ name:"이타도리 유지",emoji:"🟠",grade:"준1급",atk:90,def:75,spd:85,maxHp:1000,domain:null,desc:"특급주술사 후보생. 스쿠나의 손가락을 삼킨 그릇.",lore:"\"남은 건 내가 어떻게 죽느냐다.\"",fingerSkills:true,
    skills:[
      {name:"주먹질",minMastery:0,dmg:95,desc:"강력한 기본 주먹 공격."},
      {name:"다이버전트 주먹",minMastery:5,dmg:160,desc:"저주 에너지를 실은 주먹.",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},
      {name:"흑섬",minMastery:15,dmg:240,desc:"최대 저주 에너지 방출!",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"어주자",minMastery:30,dmg:340,desc:"스쿠나의 힘을 빌린 궁극기.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},
      {name:"스쿠나 발현",minMastery:50,dmg:520,desc:"스쿠나가 몸을 장악! 10손가락 이상 필요.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ],
  },
  gojo:{ name:"고조 사토루",emoji:"🔵",grade:"특급",atk:130,def:120,spd:110,maxHp:1800,domain:"무량공처",desc:"최강의 주술사. 무량공처를 구사한다.",lore:"\"사람들이 왜 내가 최강이라고 하는지 알아?\"",
    skills:[
      {name:"아오",minMastery:0,dmg:145,desc:"적들을 끌어당겨서 공격한다."},
      {name:"아카",minMastery:5,dmg:220,desc:"적들을 날려서 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"무라사키",minMastery:15,dmg:320,desc:"아오와 아카를 합쳐서 발사.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"무량공처",minMastery:30,dmg:480,desc:"무한을 지배하는 궁극술식.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ],
  },
  megumi:{ name:"후시구로 메구미",emoji:"⚫",grade:"1급",atk:110,def:108,spd:100,maxHp:1250,domain:"강압암예정",desc:"식신술을 구사하는 주술사.",lore:"\"나는 선한 사람을 구하기 위해 싸운다.\"",
    skills:[
      {name:"옥견",minMastery:0,dmg:115,desc:"식신 옥견을 소환한다."},
      {name:"탈토",minMastery:5,dmg:180,desc:"식신 대호를 소환한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"만상",minMastery:15,dmg:265,desc:"열 가지 식신을 소환한다.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},
      {name:"후루베 유라유라",minMastery:30,dmg:380,desc:"최강의 식신, 마허라가라 강림.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ],
  },
  nobara:{ name:"쿠기사키 노바라",emoji:"🌸",grade:"1급",atk:115,def:95,spd:105,maxHp:1180,domain:null,desc:"망치를 이용해 영혼에 공격 가능한 주술사.",lore:"\"도쿄에 올 때부터 각오는 되어 있었어.\"",
    skills:[
      {name:"망치질",minMastery:0,dmg:118,desc:"저주 못을 박는다."},
      {name:"공명",minMastery:5,dmg:195,desc:"허수아비를 통해 공명 피해.",statusApply:{target:"enemy",statusId:"poison",chance:0.5}},
      {name:"철정",minMastery:15,dmg:280,desc:"저주 에너지 주입 못을 박는다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"발화",minMastery:30,dmg:390,desc:"모든 못에 동시 폭발 공명.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}},
    ],
  },
  nanami:{ name:"나나미 켄토",emoji:"🟡",grade:"1급",atk:118,def:108,spd:90,maxHp:1380,domain:null,desc:"1급 주술사. 합리적 판단의 소유자.",lore:"\"초과 근무는 사절이지만... 이건 일이 아닌 의무다.\"",
    skills:[
      {name:"둔기 공격",minMastery:0,dmg:120,desc:"단단한 둔기로 타격한다."},
      {name:"칠할삼분",minMastery:5,dmg:200,desc:"7:3 지점을 노린 약점 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"십수할",minMastery:15,dmg:290,desc:"열 배의 저주 에너지 방출."},
      {name:"초과근무",minMastery:30,dmg:410,desc:"한계를 넘어선 폭발적 강화."},
    ],
  },
  sukuna:{ name:"료멘 스쿠나",emoji:"🔴",grade:"특급",atk:140,def:115,spd:120,maxHp:2500,domain:"복마어주자",desc:"저주의 왕. [개발자 전용]",lore:"\"약한 놈이 강한 놈을 거스르는 건 죄악이다.\"",
    skills:[
      {name:"해",minMastery:0,dmg:145,desc:"날카로운 손톱으로 베어낸다.",statusApply:{target:"enemy",statusId:"burn",chance:0.4}},
      {name:"팔",minMastery:5,dmg:235,desc:"공간 자체를 베어낸다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"푸가",minMastery:15,dmg:345,desc:"닿는 모든 것을 분해한다.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},
      {name:"복마어주자",minMastery:30,dmg:500,desc:"천지개벽의 궁극 영역전개.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}},
    ],
  },
  geto:{ name:"게토 스구루",emoji:"🟢",grade:"특급",atk:115,def:105,spd:100,maxHp:1600,domain:null,desc:"전 특급 주술사. 저주를 다루는 달인.",lore:"\"주술사는 비주술사를 지켜야 한다.\"",
    skills:[
      {name:"저주 방출",minMastery:0,dmg:125,desc:"저급 저주령을 방출한다."},
      {name:"최대출력",minMastery:5,dmg:210,desc:"저주령을 전력으로 방출.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},
      {name:"저주영조종",minMastery:15,dmg:300,desc:"수천의 저주령을 조종한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"감로대법",minMastery:30,dmg:425,desc:"감로대법으로 모든 저주 흡수.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
    ],
  },
  maki:{ name:"마키 젠인",emoji:"⚪",grade:"준1급",atk:122,def:110,spd:115,maxHp:1300,domain:null,desc:"HP 30% 이하 시 천여주박 각성!",lore:"\"젠인 가문 — 그 이름을 내가 직접 끝내주지.\"",awakening:{threshold:0.30,dmgMult:2.0,label:"천여주박 각성"},
    skills:[
      {name:"봉술",minMastery:0,dmg:122,desc:"저주 도구 봉으로 타격."},
      {name:"저주창",minMastery:5,dmg:200,desc:"저주 도구 창을 투척한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"저주도구술",minMastery:15,dmg:285,desc:"다양한 저주 도구를 구사.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"천개봉파",minMastery:30,dmg:400,desc:"수천의 저주 도구 연속 공격.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ],
  },
  panda:{ name:"판다",emoji:"🐼",grade:"2급",atk:105,def:118,spd:85,maxHp:1400,domain:null,desc:"저주로 만든 특이체질의 주술사.",lore:"\"난 판다야. 진짜 판다.\"",
    skills:[
      {name:"박치기",minMastery:0,dmg:108,desc:"머리로 힘차게 들이받는다.",statusApply:{target:"enemy",statusId:"stun",chance:0.2}},
      {name:"곰 발바닥",minMastery:5,dmg:175,desc:"두꺼운 발바닥으로 내리친다."},
      {name:"팬더 변신",minMastery:15,dmg:255,desc:"진짜 팬더로 변신해 공격.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"고릴라 변신",minMastery:30,dmg:360,desc:"고릴라 형태로 폭발적 강화.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
    ],
  },
  inumaki:{ name:"이누마키 토게",emoji:"🟤",grade:"준1급",atk:112,def:90,spd:110,maxHp:1120,domain:null,desc:"주술언어를 구사하는 준1급 주술사.",lore:"\"연어알— (그냥 따라가.)\"",
    skills:[
      {name:"멈춰라",minMastery:0,dmg:115,desc:"상대의 움직임을 봉쇄한다.",statusApply:{target:"enemy",statusId:"freeze",chance:0.5}},
      {name:"달려라",minMastery:5,dmg:180,desc:"상대를 무작위로 달리게 한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"주술언어",minMastery:15,dmg:265,desc:"강력한 주술 명령을 내린다.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
      {name:"폭발해라",minMastery:30,dmg:375,desc:"상대를 그 자리에서 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.8}},
    ],
  },
  yuta:{ name:"오코츠 유타",emoji:"🌟",grade:"특급",atk:128,def:112,spd:115,maxHp:1750,domain:"진안상애",desc:"특급 주술사. 리카의 저주를 다루는 최강급.",lore:"\"리카... 나는 아직 살아야 해.\"",
    skills:[
      {name:"모방술식",minMastery:0,dmg:135,desc:"다른 술식을 모방해 공격한다."},
      {name:"리카 소환",minMastery:5,dmg:220,desc:"저주의 여왕 리카를 소환한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"순애빔",minMastery:15,dmg:340,desc:"리카와의 순수한 사랑을 에너지로 발사.",statusApply:{target:"enemy",statusId:"burn",chance:0.6}},
      {name:"진안상애",minMastery:30,dmg:480,desc:"영역전개로 모든 것을 사랑으로 파괴.",statusApply:{target:"enemy",statusId:"freeze",chance:0.9}},
    ],
  },
  higuruma:{ name:"히구루마 히로미",emoji:"⚖️",grade:"1급",atk:118,def:105,spd:95,maxHp:1320,domain:"주복사사",desc:"전직 변호사 출신 주술사.",lore:"\"이 법정에서는 — 내가 판사다.\"",
    skills:[
      {name:"저주도구",minMastery:0,dmg:120,desc:"저주 에너지를 담은 도구로 공격."},
      {name:"몰수",minMastery:5,dmg:195,desc:"상대의 술식을 몰수한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.7}},
      {name:"사형판결",minMastery:15,dmg:285,desc:"재판 결과에 따른 강력한 제재.",statusApply:{target:"enemy",statusId:"stun",chance:0.5}},
      {name:"집행인 인형",minMastery:30,dmg:410,desc:"집행인 인형을 소환해 즉시 처형.",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}},
    ],
  },
  jogo:{ name:"죠고",emoji:"🌋",grade:"특급",atk:125,def:100,spd:105,maxHp:1680,domain:"개관철위산",desc:"화염을 다루는 준특급 저주령.",lore:"\"인간이야말로 진정한 저주다.\"",
    skills:[
      {name:"화염 분사",minMastery:0,dmg:130,desc:"강렬한 불꽃을 내뿜는다.",statusApply:{target:"enemy",statusId:"burn",chance:0.5}},
      {name:"용암 폭발",minMastery:5,dmg:215,desc:"발밑의 용암을 폭발시킨다.",statusApply:{target:"enemy",statusId:"burn",chance:0.7}},
      {name:"극번 운",minMastery:15,dmg:315,desc:"하늘에서 불타는 운석을 소환한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"개관철위산",minMastery:30,dmg:460,desc:"화산을 소환하는 궁극 영역전개.",statusApply:{target:"enemy",statusId:"burn",chance:1.0}},
    ],
  },
  dagon:{ name:"다곤",emoji:"🌊",grade:"특급",atk:118,def:108,spd:96,maxHp:1620,domain:"탕온평선",desc:"수중 저주령.",lore:"\"물은 모든 것을 삼킨다.\"",
    skills:[
      {name:"물고기 소환",minMastery:0,dmg:125,desc:"날카로운 물고기 떼를 소환한다.",statusApply:{target:"enemy",statusId:"poison",chance:0.4}},
      {name:"해수 폭발",minMastery:5,dmg:205,desc:"강력한 해수를 압축해 발사한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.5}},
      {name:"조류 소용돌이",minMastery:15,dmg:295,desc:"거대한 물의 소용돌이로 공격한다.",statusApply:{target:"enemy",statusId:"freeze",chance:0.4}},
      {name:"탕온평선",minMastery:30,dmg:450,desc:"무수한 물고기로 가득 찬 영역전개.",statusApply:{target:"enemy",statusId:"poison",chance:0.9}},
    ],
  },
  hanami:{ name:"하나미",emoji:"🌿",grade:"특급",atk:115,def:118,spd:93,maxHp:1750,domain:null,desc:"식물 저주령.",lore:"\"자연은 인간의 적이 아니다.\"",
    skills:[
      {name:"나무뿌리 채찍",minMastery:0,dmg:122,desc:"나무뿌리를 채찍처럼 휘두른다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.3}},
      {name:"꽃비",minMastery:5,dmg:198,desc:"독성 꽃가루를 비처럼 쏟아낸다.",statusApply:{target:"enemy",statusId:"poison",chance:0.6}},
      {name:"대지의 저주",minMastery:15,dmg:285,desc:"대지 전체에 저주 에너지를 퍼뜨린다.",statusApply:{target:"enemy",statusId:"poison",chance:0.7}},
      {name:"재앙의 꽃",minMastery:30,dmg:425,desc:"거대한 꽃을 소환해 모든 것을 흡수한다.",statusApply:{target:"enemy",statusId:"stun",chance:0.6}},
    ],
  },
  mahito:{ name:"마히토",emoji:"🩸",grade:"특급",atk:120,def:98,spd:110,maxHp:1560,domain:"자폐원돈과",desc:"영혼을 자유자재로 변형하는 저주령.",lore:"\"영혼이 육체를 만드는 거야.\"",
    skills:[
      {name:"영혼 변형",minMastery:0,dmg:128,desc:"영혼을 변형해 직접 타격한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"무위전변",minMastery:5,dmg:212,desc:"접촉한 신체를 기괴하게 변형한다.",statusApply:{target:"enemy",statusId:"stun",chance:0.4}},
      {name:"편사지경체",minMastery:15,dmg:308,desc:"신체를 무한히 변형해 공격한다.",statusApply:{target:"enemy",statusId:"weaken",chance:0.6}},
      {name:"자폐원돈과",minMastery:30,dmg:455,desc:"영혼과 육체의 경계를 무너뜨리는 영역.",statusApply:{target:"enemy",statusId:"freeze",chance:0.8}},
    ],
  },
  todo:{ name:"토도 아오이",emoji:"💪",grade:"1급",atk:128,def:108,spd:112,maxHp:1500,domain:null,desc:"보조 공격술(부기우기)을 구사하는 1급 주술사.",lore:"\"너의 이상형은 어떤 여자야?\"",
    skills:[
      {name:"부기우기",minMastery:0,dmg:130,desc:"보조공격술 — 위치 전환 + 빙결 40%.",statusApply:{target:"enemy",statusId:"freeze",chance:0.40}},
      {name:"브루탈 펀치",minMastery:5,dmg:215,desc:"최대 저주력을 실은 파괴적 주먹.",statusApply:{target:"enemy",statusId:"weaken",chance:0.30}},
      {name:"흑섬",minMastery:15,dmg:320,desc:"이타도리에게 배운 흑섬!",statusApply:{target:"enemy",statusId:"burn",chance:0.45}},
      {name:"전투본능",minMastery:30,dmg:200,desc:"자신에게 전투본능 버프! ATK↑ 회피↑ 3턴",statusApply:{target:"self",statusId:"battleInstinct",chance:1.0}},
    ],
  },
  hakari:{ name:"하카리 키리토",emoji:"🎰",grade:"준1급",atk:125,def:100,spd:108,maxHp:1650,domain:"질풍강운",desc:"복권 술식을 사용하는 주술사.",lore:"\"운도 실력이다! 철저하게 즐기자!\"",
    skills:[
      {name:"험한 도박",minMastery:0,dmg:125,desc:"운에 맡긴 도박 공격!",statusApply:{target:"enemy",statusId:"stun",chance:0.3}},
      {name:"질풍열차",minMastery:5,dmg:210,desc:"강력한 열차처럼 돌진!",statusApply:{target:"enemy",statusId:"weaken",chance:0.4}},
      {name:"유한 소설",minMastery:15,dmg:320,desc:"불멸의 몸으로 싸운다!",statusApply:{target:"self",statusId:"battleInstinct",chance:0.6}},
      {name:"질풍강운",minMastery:30,dmg:480,desc:"영역전개 — 운이 터진다!",statusApply:{target:"enemy",statusId:"freeze",chance:0.7}},
    ],
  },
};

// ════════════════════════════════════════════════════════
// ── 적 데이터
// ════════════════════════════════════════════════════════
const ENEMIES = [
  {id:"e1",name:"저급 저주령",emoji:"👹",hp:550,atk:38,def:12,xp:75,crystals:18,masteryXp:1,fingers:0,statusAttack:null},
  {id:"e2",name:"1급 저주령",emoji:"👺",hp:1100,atk:80,def:40,xp:190,crystals:40,masteryXp:3,fingers:0,statusAttack:{statusId:"poison",chance:0.3}},
  {id:"e3",name:"특급 저주령",emoji:"💀",hp:2400,atk:128,def:72,xp:440,crystals:90,masteryXp:7,fingers:1,statusAttack:{statusId:"burn",chance:0.4}},
  {id:"e4",name:"저주의 왕 (보스)",emoji:"👑",hp:5500,atk:195,def:110,xp:1000,crystals:200,masteryXp:15,fingers:3,statusAttack:{statusId:"weaken",chance:0.5}},
];
const JUJUTSU_ENEMIES = [
  {id:"j1",name:"약화된 저주령",emoji:"💧",hp:300,atk:25,def:8,xp:55,crystals:12,masteryXp:1,points:1,fingers:0,statusAttack:null,desc:"⚡ 빠르지만 약함 (1포인트)"},
  {id:"j2",name:"중간급 저주령",emoji:"🌀",hp:620,atk:55,def:28,xp:115,crystals:28,masteryXp:2,points:1,fingers:0,statusAttack:{statusId:"weaken",chance:0.2},desc:"⚖️ 균형잡힌 몹 (1포인트)"},
  {id:"j3",name:"강화 저주령",emoji:"🔥",hp:450,atk:75,def:22,xp:95,crystals:23,masteryXp:2,points:1,fingers:0,statusAttack:{statusId:"burn",chance:0.35},desc:"💥 공격적이지만 방어 낮음 (1포인트)"},
  {id:"j4",name:"특수 저주령",emoji:"☠️",hp:960,atk:88,def:48,xp:190,crystals:45,masteryXp:4,points:2,fingers:0,statusAttack:{statusId:"poison",chance:0.4},desc:"🧪 독 공격! (2포인트)"},
  {id:"j5",name:"엘리트 저주령",emoji:"💀",hp:1380,atk:108,def:60,xp:280,crystals:70,masteryXp:6,points:3,fingers:1,statusAttack:{statusId:"burn",chance:0.5},desc:"⚔️ 강력한 엘리트 (3포인트)"},
  {id:"j6",name:"사멸회유 수호자",emoji:"👹",hp:2100,atk:135,def:82,xp:440,crystals:100,masteryXp:10,points:5,fingers:2,statusAttack:{statusId:"weaken",chance:0.6},desc:"🏆 최강 수호자 (5포인트)"},
];

// ════════════════════════════════════════════════════════
// ── 가챠 풀
// ════════════════════════════════════════════════════════
const GACHA_POOL = [
  {id:"gojo",rate:0.3},{id:"yuta",rate:0.45},{id:"geto",rate:0.9},
  {id:"jogo",rate:0.6},{id:"mahito",rate:0.6},{id:"hanami",rate:0.7},
  {id:"dagon",rate:0.7},{id:"itadori",rate:2.5},{id:"megumi",rate:6.0},
  {id:"nanami",rate:6.0},{id:"maki",rate:6.5},{id:"nobara",rate:6.5},
  {id:"higuruma",rate:6.5},{id:"todo",rate:5.0},{id:"panda",rate:32.0},
  {id:"inumaki",rate:23.75},{id:"hakari",rate:5.0},
];
const GACHA_RARITY = {
  "특급":{stars:"★★★★★",color:0xF5C842,effect:"✨🔱✨🔱✨",flash:"LEGENDARY"},
  "준특급":{stars:"★★★★☆",color:0xff8c00,effect:"💠💠💠💠💠",flash:"EPIC"},
  "1급":{stars:"★★★☆☆",color:0x7C5CFC,effect:"⭐⭐⭐⭐",flash:"RARE"},
  "준1급":{stars:"★★★☆☆",color:0x9b72cf,effect:"⭐⭐⭐",flash:"RARE"},
  "2급":{stars:"★★☆☆☆",color:0x4ade80,effect:"🔹🔹🔹",flash:"UNCOMMON"},
  "3급":{stars:"★☆☆☆☆",color:0x94a3b8,effect:"◽◽",flash:"COMMON"},
};
function rollGacha(count=1) {
  const total = GACHA_POOL.reduce((s,p)=>s+p.rate,0);
  return Array.from({length:count},()=>{
    let r=Math.random()*total;
    for (const e of GACHA_POOL) { r-=e.rate; if(r<=0) return e.id; }
    return GACHA_POOL[GACHA_POOL.length-1].id;
  });
}
const REVERSE_CHARS = new Set(["gojo","yuta"]);
const CODES = { "release":{crystals:200}, "sorryforbugs":{crystals:1000} };

// ════════════════════════════════════════════════════════
// ── 인메모리 세션
// ════════════════════════════════════════════════════════
let players = {};
const battles={}, cullings={}, jujutsus={}, parties={}, partyInvites={}, pvpSessions={}, pvpChallenges={};
let _partyIdSeq=1, _pvpIdSeq=1;

// ════════════════════════════════════════════════════════
// ── 플레이어 유틸
// ════════════════════════════════════════════════════════
function getPlayer(userId, username="플레이어") {
  if (!players[userId]) {
    players[userId] = {
      id:userId, name:username, crystals:500, xp:0,
      owned:["itadori"], active:"itadori",
      hp:CHARACTERS["itadori"].maxHp, potion:3,
      wins:0, losses:0,
      mastery:{itadori:0},
      reverseOutput:1.0, reverseCooldown:0,
      cullingBest:0, jujutsuBest:0,
      usedCodes:[], lastDaily:0,
      pvpWins:0, pvpLosses:0,
      statusEffects:[], skillCooldown:0,
      dailyStreak:0,
      sukunaFingers:0,
      kogane:null, koganeGachaCount:0,
      attackStreak:0,
      blackFlashCount:0,
      sigTech:null,
      skillUseCount:{},
    };
    savePlayer(userId);
  }
  const p = players[userId];
  let changed=false;
  if (p.name!==username&&username!=="플레이어") { p.name=username; changed=true; }
  const defaults={
    reverseOutput:1.0,reverseCooldown:0,mastery:{},cullingBest:0,jujutsuBest:0,
    usedCodes:[],lastDaily:0,pvpWins:0,pvpLosses:0,statusEffects:[],skillCooldown:0,
    dailyStreak:0,sukunaFingers:0,kogane:null,koganeGachaCount:0,
    attackStreak:0,blackFlashCount:0,sigTech:null,skillUseCount:{},
  };
  for (const [k,v] of Object.entries(defaults)) {
    if (p[k]===undefined) { p[k]=typeof v==="object"&&v!==null?JSON.parse(JSON.stringify(v)):v; changed=true; }
  }
  if (!p.id) { p.id=userId; changed=true; }
  if (changed) savePlayer(userId);
  return p;
}

function getMastery(player, charId) { return player.mastery?.[charId]||0; }
function getAvailableSkills(player, charId) {
  const m=getMastery(player,charId);
  return CHARACTERS[charId].skills.filter(s=>{
    if (m<s.minMastery) return false;
    if (s.name==="스쿠나 발현"&&(player.sukunaFingers||0)<10) return false;
    return true;
  });
}
function getCurrentSkill(player, charId) {
  const skills=getAvailableSkills(player,charId);
  return skills[skills.length-1]||CHARACTERS[charId].skills[0];
}
function getNextSkill(player, charId) {
  const m=getMastery(player,charId);
  return CHARACTERS[charId].skills.find(s=>s.minMastery>m)||null;
}
function getPlayerStats(player) {
  const ch=CHARACTERS[player.active];
  const kb=getKoganeBonus(player);
  if (player.active!=="itadori") return {
    atk:Math.floor(ch.atk*kb.atk),
    def:Math.floor(ch.def*kb.def),
    maxHp:Math.floor(ch.maxHp*kb.hp),
  };
  const bonus=getFingerBonus(player.sukunaFingers||0);
  return {
    atk:Math.floor((ch.atk+bonus.atkBonus)*kb.atk),
    def:Math.floor((ch.def+bonus.defBonus)*kb.def),
    maxHp:Math.floor((ch.maxHp+bonus.hpBonus)*kb.hp),
  };
}
function masteryBar(mastery,charId) {
  const tiers=CHARACTERS[charId].skills.map(s=>s.minMastery);
  const max=tiers[tiers.length-1];
  if (mastery>=max) return "`[MAX]` 모든 스킬 해금!";
  const next=tiers.find(t=>t>mastery)||max;
  const prev=[...tiers].reverse().find(t=>t<=mastery)||0;
  const fill=Math.round(((mastery-prev)/(next-prev))*10);
  return "`"+"█".repeat(Math.max(0,fill))+"░".repeat(Math.max(0,10-fill))+"`"+` ${mastery}/${next}`;
}
function getLevel(xp) { return Math.floor(xp/200)+1; }
function hpBar(cur,max,len=10) {
  const pct=Math.max(0,Math.min(1,cur/max));
  const fill=Math.round(pct*len);
  const color=pct>0.5?"🟩":pct>0.25?"🟨":"🟥";
  return color.repeat(Math.max(0,fill))+"⬛".repeat(Math.max(0,len-fill));
}
function isMakiAwakened(player) {
  if (player.active!=="maki") return false;
  const stats=getPlayerStats(player);
  return player.hp<=Math.floor(stats.maxHp*CHARACTERS["maki"].awakening.threshold);
}
function calcDmg(atk,def,mult=1) {
  const v=0.70+Math.random()*0.60;
  return Math.max(1,Math.floor((atk*v-def*0.22)*mult));
}
function calcDmgForPlayer(player,enemyDef,baseMult=1) {
  const stats=getPlayerStats(player);
  let mult=baseMult*getWeakenMult(player.statusEffects);
  if (isMakiAwakened(player)) mult*=CHARACTERS["maki"].awakening.dmgMult;
  return calcDmg(stats.atk,enemyDef,mult);
}
function calcSkillDmgForPlayer(player,baseSkillDmg,skillName="") {
  let dmg=baseSkillDmg+Math.floor(Math.random()*60);
  dmg=Math.floor(dmg*getWeakenMult(player.statusEffects));
  if (isMakiAwakened(player)) dmg=Math.floor(dmg*CHARACTERS["maki"].awakening.dmgMult);
  if (player.active==="itadori") {
    const bonus=getFingerBonus(player.sukunaFingers||0);
    dmg=Math.floor(dmg*(1+bonus.atkBonus/120));
  }
  const kb=getKoganeBonus(player);
  dmg=Math.floor(dmg*kb.atk);
  // 주력 술식 보너스
  if (skillName) {
    const sig=getSigTechBonus(player,skillName);
    dmg=Math.floor(dmg*sig.dmgMult);
  }
  return dmg;
}

// 흑섬 처리 — 공격/술식 뒤 호출, 발동 시 데미지 반환(이미 계산된 dmg에 배율 적용)
function tryBlackFlash(player, dmg) {
  if (rollBlackFlash(player)) {
    player.attackStreak = 0;
    player.blackFlashCount = (player.blackFlashCount||0)+1;
    return { triggered:true, dmg:Math.floor(dmg*BLACK_FLASH_MULTIPLIER) };
  }
  player.attackStreak = (player.attackStreak||0)+1;
  return { triggered:false, dmg };
}

function applySkillStatus(skill, defenderObj, attackerObj=null) {
  if (!skill.statusApply) return [];
  const {target,statusId,chance}=skill.statusApply;
  // 주력 술식 보너스 적용
  const sigBonus = attackerObj ? getSigTechBonus(attackerObj, skill.name).statusChanceBonus : 0;
  if (Math.random()>(chance+sigBonus)) return [];
  const def=STATUS_EFFECTS[statusId];
  if (target==="enemy") { applyStatus(defenderObj,statusId); return [`${def.emoji} **${def.name}** 상태이상 적용! (${def.duration}턴)`]; }
  if (target==="self"&&attackerObj) { applyStatus(attackerObj,statusId); return [`${def.emoji} **${def.name}** 발동! (${def.duration}턴)`]; }
  return [];
}
function tickCooldowns(player) {
  if (player.reverseCooldown>0) player.reverseCooldown--;
  if (player.skillCooldown>0) player.skillCooldown--;
}

// ════════════════════════════════════════════════════════
// ── 파티 유틸
// ════════════════════════════════════════════════════════
function getPartyId(userId) { return Object.keys(parties).find(pid=>parties[pid]?.members?.includes(userId))||null; }
function getParty(userId) { const pid=getPartyId(userId); return pid?parties[pid]:null; }
function getPvpSessionByUser(userId) { return Object.values(pvpSessions).find(s=>s.p1Id===userId||s.p2Id===userId)||null; }
function pvpOpponent(session,userId) {
  if (session.p1Id===userId) return {id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2",domainKey:"domainUsed2"};
  return {id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1",domainKey:"domainUsed1"};
}
function pvpSelf(session,userId) {
  if (session.p1Id===userId) return {id:session.p1Id,hpKey:"hp1",statusKey:"status1",skillCdKey:"skillCd1",reverseCdKey:"reverseCd1",domainKey:"domainUsed1"};
  return {id:session.p2Id,hpKey:"hp2",statusKey:"status2",skillCdKey:"skillCd2",reverseCdKey:"reverseCd2",domainKey:"domainUsed2"};
}
function getCullingPool(wave) {
  if (wave<=3) return ["e1","e1","e1","e2"];
  if (wave<=7) return ["e1","e2","e2","e2","e3"];
  if (wave<=14) return ["e2","e2","e3","e3","e3"];
  return ["e2","e3","e3","e4","e4"];
}
function pickCullingEnemy(wave) {
  const pool=getCullingPool(wave);
  const id=pool[Math.floor(Math.random()*pool.length)];
  const base=ENEMIES.find(e=>e.id===id);
  const scale=1+(wave-1)*0.05;
  return {...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),currentHp:Math.floor(base.hp*scale),statusEffects:[]};
}
function generateJujutsuChoices(wave) {
  const pool=wave<=3?["j1","j1","j2","j3"]:wave<=7?["j2","j3","j3","j4"]:wave<=12?["j3","j4","j4","j5"]:["j4","j5","j5","j6"];
  const ids=[];
  for (const id of [...pool].sort(()=>Math.random()-0.5)) { if(!ids.includes(id)) ids.push(id); if(ids.length===3) break; }
  while(ids.length<3) { const fb=pool[Math.floor(Math.random()*pool.length)]; if(!ids.includes(fb)) ids.push(fb); }
  return ids.slice(0,3).map(id=>{
    const base=JUJUTSU_ENEMIES.find(e=>e.id===id);
    const scale=1+(wave-1)*0.04;
    return {...base,hp:Math.floor(base.hp*scale),atk:Math.floor(base.atk*scale),def:Math.floor(base.def*scale),xp:Math.floor(base.xp*scale),crystals:Math.floor(base.crystals*scale),statusEffects:[]};
  });
}

// ════════════════════════════════════════════════════════
// ── 임베드 함수들
// ════════════════════════════════════════════════════════
function profileEmbed(player) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const skill=getCurrentSkill(player,player.active);
  const next=getNextSkill(player,player.active);
  const mastery=getMastery(player,player.active);
  const awakened=isMakiAwakened(player);
  const lv=getLevel(player.xp);
  const hpPct=Math.max(0,player.hp)/stats.maxHp;
  const xpNow=player.xp%200;
  const fingers=player.sukunaFingers||0;
  const fingerBonus=getFingerBonus(fingers);
  const kb=getKoganeBonus(player);
  const kogane=player.kogane;
  const kg=kogane?KOGANE_GRADES[kogane.grade]:null;
  const gradeInfo=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  const sigTech=player.sigTech;

  const HP_LEN=18, hpFill=Math.round(hpPct*HP_LEN);
  const hpColor=hpPct>0.6?"🟢":hpPct>0.3?"🟡":"🔴";
  const hpBarStr=`${hpColor} \`${"█".repeat(Math.max(0,hpFill))}${"░".repeat(Math.max(0,HP_LEN-hpFill))}\` **${Math.max(0,player.hp)}**/**${stats.maxHp}**`;
  const XP_LEN=18, xpFill=Math.round((xpNow/200)*XP_LEN);
  const xpBarStr=`📊 \`${"▰".repeat(Math.max(0,xpFill))}${"▱".repeat(Math.max(0,XP_LEN-xpFill))}\` **${xpNow}**/200`;

  const cardBlock=[
    "```",
    `╔══════════════════════════════════╗`,
    `║  ${ch.emoji}  ${ch.name.padEnd(26)}  ║`,
    `║  ${gradeInfo.stars}  ${ch.grade.padEnd(22)}  ║`,
    `║  ${ch.lore?.slice(0,34).padEnd(34)||ch.desc.slice(0,34).padEnd(34)}  ║`,
    `╠══════════════════════════════════╣`,
    `║  🗡 ATK ${String(stats.atk).padEnd(6)} 🛡 DEF ${String(stats.def).padEnd(6)} 💨 ${String(ch.spd).padEnd(4)}  ║`,
    `║  🌌 영역: ${(ch.domain||"없음").padEnd(24)}  ║`,
    awakened?`║  🔥 ≪ 천여주박 각성 ≫ — DMG×2  ║`:"",
    sigTech?`║  ⚡ 주력술식: ${sigTech.padEnd(22)}  ║`:"",
    `╚══════════════════════════════════╝`,
    "```",
  ].filter(Boolean).join("\n");

  const fingerBar=fingers>0?`> 👹 **스쿠나 손가락** \`${"█".repeat(fingers)}${"░".repeat(SUKUNA_FINGER_MAX-fingers)}\` **${fingers}/${SUKUNA_FINGER_MAX}** — ${fingerBonus.label}`:"";
  const koganeLine=kogane&&kg?`> ${kg.emoji} **코가네 [${kogane.grade}]** — ${kg.passiveDesc}`:`> 🐾 코가네 없음 — \`!코가네가챠\` (200💎)`;
  const bfLine=`> ⚡ 흑섬 발동 횟수: **${player.blackFlashCount||0}**회`;

  const skillListLines=CHARACTERS[player.active].skills.map((s,idx)=>{
    const unlocked=mastery>=s.minMastery;
    const isCurrent=skill.name===s.name;
    const fingerLock=s.name==="스쿠나 발현"&&fingers<10;
    const ok=unlocked&&!fingerLock;
    const icon=ok?["∞","↗","✳","⊕","⬡","◈"][idx]||"◆":"🔒";
    const isSig=sigTech===s.name?"⚡주력":"";
    const useCount=player.skillUseCount?.[s.name]||0;
    const canSig=useCount>=SIG_TECH_THRESHOLD;
    const sigMark=canSig&&!isSig?" (주력지정가능)":"";
    const statusNote=s.statusApply?` [${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${Math.round(s.statusApply.chance*100)}%]`:"";
    const curMark=isCurrent?" ◀ 현재":"";
    return `> ${icon} **${s.name}**${statusNote}${isSig}${sigMark}${curMark}\n> ⠀  *${s.desc}* (사용:${useCount}회)`;
  }).join("\n");

  const embed=new EmbedBuilder()
    .setTitle(awakened?`🔥 ≪ 천여주박 각성 ≫  ${player.name}의 카드`:`${gradeInfo.effect}  ${player.name}의 주술사 카드  ${gradeInfo.effect}`)
    .setColor(awakened?0xFF2200:gradeInfo.color)
    .setDescription([cardBlock,koganeLine,fingerBar,bfLine].filter(Boolean).join("\n"))
    .addFields(
      {name:"┌─ 🏅 주술사 정보 ─┐",value:[`> 🎖️ **LV.${lv}**  /  총 XP: **${player.xp}**`,`> ${xpBarStr}`,`> 💎 **${player.crystals}** 크리스탈   🧪 회복약 **${player.potion}개**`,`> ⚔️ 일반 \`${player.wins}승 ${player.losses}패\`   /   PvP \`${player.pvpWins}승 ${player.pvpLosses}패\``,`> 🌊 컬링 최고: **${player.cullingBest}** WAVE   🎯 사멸: **${player.jujutsuBest}pt**`].join("\n"),inline:false},
      {name:"┌─ 💚 전투 상태 ─┐",value:[`> ${hpBarStr}`,`> 🩸 상태이상: **${statusStr(player.statusEffects)}**`,`> ⚡ 술식 CD: ${player.skillCooldown>0?`**${player.skillCooldown}턴**`:"✅ 즉시"}   ♻ 반전 CD: ${player.reverseCooldown>0?`**${player.reverseCooldown}턴**`:"✅ 즉시"}`,kogane&&kg?`> 🐾 코가네 보너스: ATK×${kb.atk.toFixed(2)} DEF×${kb.def.toFixed(2)} HP×${kb.hp.toFixed(2)}`:""].filter(Boolean).join("\n"),inline:false},
      {name:"┌─ 🌀 SKILLS ─┐",value:[skillListLines,`> 📈 숙련도: ${masteryBar(mastery,player.active)}`,next?`> ⬆️ 다음 해금: **${next.name}** *(숙련 ${next.minMastery})*`:`> 🏆 **모든 스킬 해금!**`,sigTech?`> ⚡ 주력 술식: **${sigTech}** (DMG+35%, 상태이상확률+20%, CD-2)`:"> ⚡ 주력 술식 미지정 (`!주력술식 [스킬명]`)"].join("\n"),inline:false},
      {name:"┌─ 📦 보유 캐릭터 ─┐",value:player.owned.map(id=>{const c=CHARACTERS[id];const m=getMastery(player,id);const cur=getCurrentSkill(player,id);const ri=GACHA_RARITY[c.grade]||GACHA_RARITY["3급"];return `> ${id===player.active?"▶️":"　"} ${c.emoji} **${c.name}** \`${c.grade}\` ${ri.stars} · 숙련 \`${m}\` · \`${cur.name}\``}).join("\n")||"> 없음",inline:false},
    )
    .setFooter({text:`!전투 !컬링 !사멸회유 !결투 !가챠 !도감 !주력술식 | ${player.name}`})
    .setTimestamp();
  return embed;
}

function docanEmbed() {
  const charList = Object.entries(CHARACTERS).map(([id,ch])=>{
    const ri=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
    const inGacha=GACHA_POOL.find(g=>g.id===id);
    const rate=inGacha?`${inGacha.rate}%`:"비가챠";
    return `${ch.emoji} **${ch.name}** \`[${ch.grade}]\` ${ri.stars} — ${rate} | ATK${ch.atk} DEF${ch.def} HP${ch.maxHp}`;
  });
  return new EmbedBuilder()
    .setTitle("📖 주술사 도감")
    .setColor(0x7c5cfc)
    .setDescription(charList.join("\n"))
    .addFields({name:"📊 가챠 확률",value:GACHA_POOL.map(p=>`${CHARACTERS[p.id].emoji} **${CHARACTERS[p.id].name}** — ${p.rate}%`).join("\n"),inline:false})
    .setFooter({text:"!도감으로 전체 캐릭터 정보 확인"});
}

function charDetailEmbed(charId) {
  const ch=CHARACTERS[charId];
  if (!ch) return null;
  const ri=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ${ch.name} — ${ch.grade} ${ri.stars}`)
    .setColor(ri.color)
    .setDescription([`> *"${ch.lore||ch.desc}"*`,`> ${ch.desc}`,`> 🌌 영역전개: **${ch.domain||"없음"}**`].join("\n"))
    .addFields(
      {name:"📊 기본 스탯",value:`🗡️ ATK: **${ch.atk}**\n🛡️ DEF: **${ch.def}**\n💨 SPD: **${ch.spd}**\n💚 HP: **${ch.maxHp}**`,inline:true},
      {name:"🌀 스킬 목록",value:ch.skills.map((s,i)=>`\`${i+1}\` **${s.name}** (DMG:${s.dmg}, 숙련:${s.minMastery})\n└ ${s.desc}`).join("\n"),inline:false},
    )
    .setFooter({text:`!도감 ${charId} 으로 상세 정보 확인`});
}

function sigTechEmbed(player) {
  const charId=player.active;
  const lines=CHARACTERS[charId].skills.map(s=>{
    const useCount=player.skillUseCount?.[s.name]||0;
    const progress=Math.min(useCount,SIG_TECH_THRESHOLD);
    const bar="█".repeat(Math.floor(progress/5))+"░".repeat(Math.max(0,10-Math.floor(progress/5)));
    const isSig=player.sigTech===s.name;
    const canSet=useCount>=SIG_TECH_THRESHOLD;
    return `${isSig?"⚡**주력**":canSet?"✅":"🔒"} **${s.name}** \`${bar}\` ${useCount}/${SIG_TECH_THRESHOLD}회${isSig?" ← 현재 주력술식":""}${canSet&&!isSig?" (지정 가능!)":""}`;
  });
  return new EmbedBuilder()
    .setTitle(`⚡ 주력 술식 시스템 — ${CHARACTERS[charId].name}`)
    .setColor(0xf5c842)
    .setDescription([
      "> **주력 술식**이란? 특정 술식을 **50회** 사용하면 주력으로 지정할 수 있습니다.",
      "> 주력 술식 효과: **DMG +35%**, **상태이상 확률 +20%**, **쿨다운 -2**",
      "> `!주력술식 [스킬명]`으로 지정하세요.",
      "",
      ...lines,
    ].join("\n"))
    .setFooter({text:"주력 술식은 하나만 지정 가능합니다."});
}

function blackFlashEmbed(dmg, totalBf, streak) {
  return new EmbedBuilder()
    .setTitle("⚡✨ 흑섬(Black Flash) 발동! ✨⚡")
    .setColor(0x1a0a2e)
    .setDescription([
      "```",
      "🌑🌑🌑🌑🌑🌑🌑🌑🌑🌑",
      "⬛  黑   閃  —  Black Flash  ⬛",
      "🌑🌑🌑🌑🌑🌑🌑🌑🌑🌑",
      "```",
      `> **저주 에너지가 순간적으로 수렴했다!**`,
      `> 💥 흑섬 데미지: **${dmg}** (×${BLACK_FLASH_MULTIPLIER})`,
      `> ⚡ 누적 흑섬: **${totalBf}**회`,
      streak>0?`> 🔥 연속 공격 스트릭: **${streak}** (흑섬 확률 증가 중!)`:"",
    ].filter(Boolean).join("\n"))
    .setFooter({text:"흑섬은 연속 공격 시 확률이 높아집니다!"});
}

function koganeProfileEmbed(player) {
  const kogane=player.kogane;
  if (!kogane) return new EmbedBuilder().setTitle("🐾 코가네 — 황금 개 펫").setColor(0x4a5568).setDescription("> **코가네** 미획득!\n> 💎 **200 크리스탈**로 `!코가네가챠` 사용하세요.").setFooter({text:"!코가네가챠 (200💎)"});
  const g=KOGANE_GRADES[kogane.grade];
  return new EmbedBuilder().setTitle(`${g.emoji} 코가네 — [${kogane.grade}] ${g.stars}`).setColor(g.color).setDescription([`> **패시브:** ${g.passiveDesc}`,`> **스킬:** 🐾 **${g.skill}** — ${g.skillDesc}`,`> **발동 확률:** ${Math.round(g.skillChance*100)}%`].join("\n")).addFields({name:"📊 스탯",value:`ATK +${Math.round(g.atkBonus*100)}% | DEF +${Math.round(g.defBonus*100)}% | HP +${Math.round(g.hpBonus*100)}%\nXP +${Math.round(g.xpBonus*100)}% | 크리스탈 +${Math.round(g.crystalBonus*100)}%`,inline:false},{name:"🎲 가챠",value:`총 **${player.koganeGachaCount||0}**회 소환`,inline:true}).setFooter({text:"!코가네가챠 (200💎)"});
}

function koganeGachaEmbed(grade, isUpgrade, player, oldGrade) {
  const g=KOGANE_GRADES[grade];
  const upgraded=isUpgrade&&oldGrade;
  return new EmbedBuilder()
    .setTitle(upgraded?`${g.emoji} 코가네 등급 상승! ${oldGrade} → ${grade}!`:`${g.emoji} 코가네 소환! [${grade}] ${g.stars}`)
    .setColor(g.color)
    .setDescription([upgraded?`> ⬆️ **등급 상승!!** ${oldGrade} → **${grade}**`:`> 🐾 **코가네 [${grade}]** 소환!`,`> **패시브:** ${g.passiveDesc}`,`> **스킬:** ${g.skill} — ${g.skillDesc}`,!upgraded?`\n> ⚠️ 기존보다 낮은 등급 — 교체되지 않았습니다.\n> 💎 **+50** 보상 지급!`:""].filter(Boolean).join("\n"))
    .setFooter({text:`총 소환: ${player.koganeGachaCount}회 | 잔여: ${player.crystals}💎`});
}

function gachaLoadingEmbed(stage=1) {
  const frames=[
    {title:"🔮 주술 소환 의식 — 준비",color:0x0a0a1e,desc:"```\n？  ？  ？  ？  ？\n저주 에너지가 수렴하기 시작한다...\n```"},
    {title:"⚡ 저주 에너지 최대 수렴 중...",color:0x1a0533,desc:"```\n⚡  ✦  ⚡  ✦  ⚡\n    ？？？\n⚡  ✦  ⚡  ✦  ⚡\n```"},
  ];
  const f=frames[stage-1]||frames[0];
  return new EmbedBuilder().setTitle(f.title).setColor(f.color).setDescription(f.desc);
}
function gachaRevealEmbed(grade) {
  const info=GACHA_RARITY[grade]||GACHA_RARITY["3급"];
  return new EmbedBuilder().setTitle(`${info.effect} ${grade} 등급의 기운이 느껴진다!`).setColor(info.color).setDescription(`> *${info.stars}  —  ${info.flash}!*`);
}
function gachaResultEmbed(charId,isNew,player) {
  const ch=CHARACTERS[charId];
  const info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"];
  const skill=getCurrentSkill(player,charId);
  return new EmbedBuilder()
    .setTitle(isNew?`${info.effect} ✨ NEW! — ${ch.name} 획득!`:`${info.effect} 중복 — ${ch.name} (+50💎)`)
    .setColor(isNew?info.color:0x4a5568)
    .setDescription([`> *"${ch.lore||ch.desc}"*`].join("\n"))
    .addFields({name:"🌌 영역전개",value:ch.domain||"없음",inline:true},{name:"🔥 초기 술식",value:`\`${skill.name}\` (DMG ${skill.dmg})`,inline:true},{name:"📖 설명",value:ch.desc,inline:false})
    .setFooter({text:`💎 잔여: ${player.crystals} | !가챠10 으로 10연차`});
}
function gacha10ResultEmbed(results,newOnes,dupCrystals,player) {
  const sorted=[...results].sort((a,b)=>{ const o=["특급","준특급","1급","준1급","2급","3급"]; return o.indexOf(CHARACTERS[a].grade)-o.indexOf(CHARACTERS[b].grade); });
  const lines=sorted.map(id=>{ const ch=CHARACTERS[id]; const info=GACHA_RARITY[ch.grade]||GACHA_RARITY["3급"]; const isN=newOnes.includes(id); return `${ch.emoji} ${info.stars} **${ch.name}** \`[${ch.grade}]\`${isN?" **✨NEW!**":""}`; });
  const legendaries=results.filter(id=>CHARACTERS[id].grade==="특급");
  return new EmbedBuilder()
    .setTitle(legendaries.length>0?`🔱 ⚡⚡ 10연차 — 전설 등급 획득!! ⚡⚡ 🔱`:`🎲 10회 주술 소환 결과`)
    .setColor(legendaries.length>0?0xF5C842:0x7c5cfc)
    .setDescription(lines.join("\n"))
    .addFields({name:"✨ 신규",value:newOnes.length?newOnes.map(id=>`${CHARACTERS[id].emoji} ${CHARACTERS[id].name}`).join(", "):"없음",inline:true},{name:"🔄 중복 보상",value:`**+${dupCrystals}** 💎`,inline:true},{name:"💎 잔여",value:`**${player.crystals}**`,inline:true})
    .setFooter({text:"!가챠 1회(150💎) | !가챠10 10회(1350💎)"});
}

function skillEmbed(player) {
  const id=player.active;
  const ch=CHARACTERS[id];
  const mastery=getMastery(player,id);
  const awakened=isMakiAwakened(player);
  const fingers=player.sukunaFingers||0;
  const sigTech=player.sigTech;
  return new EmbedBuilder()
    .setTitle(`${ch.emoji} ≪ 술식 트리 ≫ ${ch.name}${awakened?" 🔥[각성]":""}`)
    .setColor(awakened?0xFF2200:JJK_GRADE_COLOR[ch.grade])
    .setDescription([`> ${ch.lore||ch.desc}`,`> 📈 **숙련도** ${masteryBar(mastery,id)}`,`> 🌌 **영역** \`${ch.domain||"없음"}\``,id==="itadori"?`> 👹 **손가락** \`${fingers}/${SUKUNA_FINGER_MAX}\` — ${getFingerBonus(fingers).label}`:"",awakened?`> 🔥 **천여주박 각성 중** — 모든 데미지 **2배**!`:"",sigTech?`> ⚡ **주력 술식:** ${sigTech} (DMG+35% 상태이상+20% CD-2)`:""].filter(Boolean).join("\n"))
    .addFields(ch.skills.map((s,idx)=>{
      const unlocked=mastery>=s.minMastery;
      const fingerLock=s.name==="스쿠나 발현"&&fingers<10;
      const available=unlocked&&!fingerLock;
      const fx=getSkillEffect(s.name);
      const useCount=player.skillUseCount?.[s.name]||0;
      const isSig=sigTech===s.name;
      const canSig=useCount>=SIG_TECH_THRESHOLD;
      const statusNote=s.statusApply?` \`${STATUS_EFFECTS[s.statusApply.statusId]?.emoji}${STATUS_EFFECTS[s.statusApply.statusId]?.name} ${Math.round(s.statusApply.chance*100)}%\``:"";
      const dmgDisplay=awakened?`~~${s.dmg}~~ → **${s.dmg*2}**🔥`:isSig?`**${Math.floor(s.dmg*SIG_TECH_BONUS.dmgMult)}** ⚡`:`**${s.dmg}**`;
      return {
        name:`${available?"✅":"🔒"} ${isSig?"⚡[주력] ":""}[${idx+1}] **${s.name}** — 피해 ${dmgDisplay}${statusNote} (숙련:${s.minMastery}, 사용:${useCount}/${SIG_TECH_THRESHOLD})`,
        value:[`> ${s.desc}`,available?fx.art:`> ${!unlocked?"🔒 숙련도 부족":"👹 손가락 10개 이상 필요"}`,available?`> *${fx.flavorText}*`:"",canSig&&!isSig?"> ✨ **주력 지정 가능!** `!주력술식 스킬명`":""].filter(Boolean).join("\n"),
        inline:false,
      };
    }))
    .setFooter({text:"전투 승리 시 숙련도 상승! | 흑섬은 연속 공격 시 확률 증가"});
}

function cullingEmbed(player,session,log=[]) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const enemy=session.currentEnemy;
  const awakened=isMakiAwakened(player);
  return new EmbedBuilder()
    .setTitle(`${awakened?"🔥 ":""}⚔️ 컬링 게임 — 🌊 WAVE ${session.wave}`)
    .setColor(awakened?0xFF2200:session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 새 파도가 밀려온다!")
    .addFields(
      {name:`${ch.emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`${awakened?" 🔥각성":""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\` ♻반전: \`${player.reverseCooldown>0?player.reverseCooldown+"턴":"가능"}\``,inline:true},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(session.enemyHp,enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}`,inline:true},
      {name:"📊 현황",value:`WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP / **${session.totalCrystals}**💎`,inline:false},
    )
    .setFooter({text:`현재 스킬: ${getCurrentSkill(player,player.active).name} | 최고: WAVE ${player.cullingBest} | ⚡흑섬: ${player.blackFlashCount}회`});
}

function jujutsuEmbed(player,session,log=[],choices=null) {
  const ch=CHARACTERS[player.active];
  const stats=getPlayerStats(player);
  const awakened=isMakiAwakened(player);
  const embed=new EmbedBuilder()
    .setTitle(`🎯 사멸회유 — WAVE ${session.wave} | 포인트 **${session.points}**/15`)
    .setColor(session.points>=10?0xF5C842:session.points>=5?0xff8c00:0x7C5CFC)
    .setDescription(log.join("\n")||"🎯 사멸회유 진행 중!")
    .addFields(
      {name:`${ch.emoji} 내 HP`,value:`${hpBar(player.hp,stats.maxHp)} \`${Math.max(0,player.hp)}/${stats.maxHp}\`${awakened?" 🔥각성":""}\n상태: ${statusStr(player.statusEffects)}\n⚡술식: \`${player.skillCooldown>0?player.skillCooldown+"턴":"가능"}\``,inline:false},
      {name:"🎯 포인트",value:`${"🟦".repeat(Math.min(session.points,15))}${"⬜".repeat(Math.max(0,15-session.points))} **${session.points}/15**`,inline:false},
    );
  if (session.currentEnemy) {
    const enemy=session.currentEnemy;
    embed.addFields({name:`${enemy.emoji} 현재 적: ${enemy.name}`,value:`${hpBar(session.enemyHp,enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects)}\n포인트: +${enemy.points}점`,inline:false});
  }
  if (choices) embed.addFields({name:"⚔️ 다음 적 선택",value:choices.map((c,i)=>`**[${i+1}]** ${c.emoji} ${c.name} — HP:\`${c.hp}\` | +${c.points}점\n└ ${c.desc}`).join("\n"),inline:false});
  embed.setFooter({text:`최고: ${player.jujutsuBest}포인트 | 15포인트 달성 시 보너스! | ⚡흑섬: ${player.blackFlashCount}회`});
  return embed;
}

function pvpEmbed(session,log=[]) {
  const p1=players[session.p1Id], p2=players[session.p2Id];
  if (!p1||!p2) return new EmbedBuilder().setTitle("오류").setDescription("플레이어 정보 없음");
  const ch1=CHARACTERS[p1.active], ch2=CHARACTERS[p2.active];
  const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
  const turnName=session.turn===session.p1Id?p1.name:p2.name;
  return new EmbedBuilder()
    .setTitle(`⚔️ PvP 결투  ${p1.name} VS ${p2.name}`)
    .setColor(0xF5C842)
    .setDescription(log.join("\n")||"⚔️ 결투 시작!")
    .addFields(
      {name:`${ch1.emoji} ${p1.name} [${ch1.grade}]`,value:`${hpBar(session.hp1,s1.maxHp)} \`${Math.max(0,session.hp1)}/${s1.maxHp}\`\n상태: ${statusStr(session.status1)}\n⚡술식: \`${session.skillCd1>0?session.skillCd1+"턴":"가능"}\``,inline:true},
      {name:`${ch2.emoji} ${p2.name} [${ch2.grade}]`,value:`${hpBar(session.hp2,s2.maxHp)} \`${Math.max(0,session.hp2)}/${s2.maxHp}\`\n상태: ${statusStr(session.status2)}\n⚡술식: \`${session.skillCd2>0?session.skillCd2+"턴":"가능"}\``,inline:true},
      {name:"🎯 현재 턴",value:`**${turnName}**의 차례 (라운드 ${session.round})`,inline:false},
    )
    .setFooter({text:"술식: 5턴 쿨다운 | 반전: 3턴(고조/유타) | 회피율 5%"});
}

function partyCullingEmbed(party,session,log=[]) {
  const enemy=session.currentEnemy;
  const memberLines=party.members.map(uid=>{
    const p=players[uid]; if(!p) return `> ❓ 알 수 없음`;
    const ch=CHARACTERS[p.active]; const stats=getPlayerStats(p);
    const hpPct=Math.max(0,p.hp)/stats.maxHp;
    const hpIcon=hpPct>0.5?"🟢":hpPct>0.25?"🟡":"🔴";
    return `> ${party.leader===uid?"👑":"👤"} **${p.name}** ${ch.emoji} ${hpIcon} \`${Math.max(0,p.hp)}/${stats.maxHp}\` | ${statusStr(p.statusEffects)}`;
  }).join("\n");
  return new EmbedBuilder()
    .setTitle(`⚔️ [파티] 컬링 — 🌊 WAVE ${session.wave}`)
    .setColor(session.wave>=15?0xF5C842:session.wave>=8?0xe63946:0x7C5CFC)
    .setDescription(log.join("\n")||"⚔️ 파티 컬링 진행 중!")
    .addFields(
      {name:`👥 파티원 (${party.members.length}명)`,value:memberLines||"없음",inline:false},
      {name:`${enemy.emoji} ${enemy.name}`,value:`${hpBar(Math.max(0,session.enemyHp),enemy.hp)} \`${Math.max(0,session.enemyHp)}/${enemy.hp}\`\n상태: ${statusStr(enemy.statusEffects||[])}`,inline:false},
      {name:"📊 현황",value:`WAVE **${session.wave}** | 처치 **${session.kills}** | **${session.totalXp}** XP`,inline:false},
    )
    .setFooter({text:"파티원 누구나 버튼을 눌러 행동 가능!"});
}

// ════════════════════════════════════════════════════════
// ── 버튼 팩토리
// ════════════════════════════════════════════════════════
const mkBattleButtons=(player)=>new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("b_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("b_skill").setLabel(`🌀 술식${player?.skillCooldown>0?`(${player.skillCooldown}턴)`:""}`).setStyle(ButtonStyle.Primary).setDisabled((player?.skillCooldown||0)>0),
  new ButtonBuilder().setCustomId("b_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("b_reverse").setLabel(`♻ 반전${player?.reverseCooldown>0?`(${player.reverseCooldown}턴)`:""}`).setStyle(ButtonStyle.Secondary).setDisabled((player?.reverseCooldown||0)>0||!REVERSE_CHARS.has(player?.active)),
  new ButtonBuilder().setCustomId("b_run").setLabel("🏃 도주").setStyle(ButtonStyle.Secondary),
);
const mkCullingButtons=(player)=>new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("c_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("c_skill").setLabel(`🌀 술식${player?.skillCooldown>0?`(${player.skillCooldown}턴)`:""}`).setStyle(ButtonStyle.Primary).setDisabled((player?.skillCooldown||0)>0),
  new ButtonBuilder().setCustomId("c_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("c_reverse").setLabel(`♻ 반전${player?.reverseCooldown>0?`(${player.reverseCooldown}턴)`:""}`).setStyle(ButtonStyle.Secondary).setDisabled((player?.reverseCooldown||0)>0||!REVERSE_CHARS.has(player?.active)),
  new ButtonBuilder().setCustomId("c_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
);
const mkJujutsuFightButtons=(player)=>new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("j_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId("j_skill").setLabel(`🌀 술식${player?.skillCooldown>0?`(${player.skillCooldown}턴)`:""}`).setStyle(ButtonStyle.Primary).setDisabled((player?.skillCooldown||0)>0),
  new ButtonBuilder().setCustomId("j_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("j_reverse").setLabel(`♻ 반전${player?.reverseCooldown>0?`(${player.reverseCooldown}턴)`:""}`).setStyle(ButtonStyle.Secondary).setDisabled((player?.reverseCooldown||0)>0||!REVERSE_CHARS.has(player?.active)),
  new ButtonBuilder().setCustomId("j_escape").setLabel("🏳 철수").setStyle(ButtonStyle.Secondary),
);
function mkJujutsuButtons(player,choices) {
  const rows=[];
  if (choices&&choices.length) {
    const row=new ActionRowBuilder();
    for (let i=0;i<Math.min(choices.length,3);i++) row.addComponents(new ButtonBuilder().setCustomId(`j_choice_${i}`).setLabel(`⚔️ ${choices[i].name}`).setStyle(ButtonStyle.Primary));
    rows.push(row);
  }
  rows.push(mkJujutsuFightButtons(player));
  return rows;
}
const mkPvpButtons=(session,userId)=>{
  const self=pvpSelf(session,userId);
  const canSkill=session[self.skillCdKey]<=0, canReverse=session[self.reverseCdKey]<=0;
  const player=players[userId];
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("p_attack").setLabel("⚔ 공격").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("p_skill").setLabel(`🌀 술식${canSkill?"":"(✖)"}`).setStyle(ButtonStyle.Primary).setDisabled(!canSkill),
    new ButtonBuilder().setCustomId("p_domain").setLabel("🌌 영역전개").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("p_reverse").setLabel(`♻ 반전${canReverse?"":"(✖)"}`).setStyle(ButtonStyle.Secondary).setDisabled(!canReverse||!REVERSE_CHARS.has(player?.active)),
    new ButtonBuilder().setCustomId("p_surrender").setLabel("🏳 항복").setStyle(ButtonStyle.Secondary),
  );
};

// ════════════════════════════════════════════════════════
// ── 전투 핸들러 (일반)
// ════════════════════════════════════════════════════════
async function handleBattleAction(interaction, player, battle, action) {
  const enemy=battle.enemy;
  const stats=getPlayerStats(player);

  if (action==="b_attack") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({content:"⚡ 공격이 빗나갔다!",embeds:[],components:[mkBattleButtons(player)]}); }
    let dmg=calcDmgForPlayer(player,enemy.def);
    const bf=tryBlackFlash(player,dmg);
    const bfTriggered=bf.triggered; dmg=bf.dmg;
    enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
    const log=[`⚔ **${dmg}** 데미지!${bfTriggered?" ⚡**흑섬 발동!**":""}`];
    if (enemy.statusAttack&&Math.random()<enemy.statusAttack.chance) { applyStatus(player,enemy.statusAttack.statusId); log.push(`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} 상태이상!`); }
    const embed=new EmbedBuilder().setTitle(bfTriggered?"⚡ 흑섬 발동! 일반 공격!":"⚔ 일반 공격!").setColor(bfTriggered?0x1a0a2e:0xff6b35).setDescription(log.join("\n")).addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} ${Math.max(0,player.hp)}`,inline:true},{name:"적 HP",value:`${hpBar(enemy.currentHp,enemy.hp)} ${Math.max(0,enemy.currentHp)}`,inline:true});
    await interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
    if (bfTriggered) await interaction.followUp({embeds:[blackFlashEmbed(dmg,player.blackFlashCount,player.attackStreak)],ephemeral:false}).catch(()=>{});
    if (enemy.currentHp<=0) return endBattle(interaction,player,battle,true);
  }
  if (action==="b_skill") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const skill=getCurrentSkill(player,player.active);
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({content:"⚡ 술식이 빗나갔다!",embeds:[],components:[mkBattleButtons(player)]}); }
    trackSkillUse(player,skill.name);
    let dmg=calcSkillDmgForPlayer(player,skill.dmg,skill.name);
    const bf=tryBlackFlash(player,dmg);
    const bfTriggered=bf.triggered; dmg=bf.dmg;
    enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
    const statusLog=applySkillStatus(skill,enemy,player);
    let cd=5; if(player.sigTech===skill.name) cd=Math.max(1,5-SIG_TECH_BONUS.cdReduce);
    player.skillCooldown=cd;
    const fx=getSkillEffect(skill.name);
    const embed=new EmbedBuilder().setTitle(`${bfTriggered?"⚡ 흑섬! ":""}${skill.name}!`).setColor(bfTriggered?0x1a0a2e:fx.color).setDescription([fx.art,`> *"${fx.flavorText}"*`,`**${dmg}** 데미지!${bfTriggered?" ⚡**흑섬 발동!**":""}`, ...statusLog].join("\n")).addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} ${Math.max(0,player.hp)}`,inline:true},{name:"적 HP",value:`${hpBar(enemy.currentHp,enemy.hp)} ${Math.max(0,enemy.currentHp)}`,inline:true});
    await interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
    if (bfTriggered) await interaction.followUp({embeds:[blackFlashEmbed(dmg,player.blackFlashCount,player.attackStreak)],ephemeral:false}).catch(()=>{});
    if (enemy.currentHp<=0) return endBattle(interaction,player,battle,true);
  }
  if (action==="b_domain") {
    const ch=CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({content:"❌ 이 캐릭터는 영역전개가 없습니다!",ephemeral:true});
    const dmg=Math.floor(stats.atk*2.5);
    enemy.currentHp=Math.max(0,enemy.currentHp-dmg);
    const embed=new EmbedBuilder().setTitle(`🌌 ${ch.domain}!`).setColor(0x00ffff).setDescription(`**${dmg}** 데미지! 영역전개 발동!`).addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} ${Math.max(0,player.hp)}`,inline:true},{name:"적 HP",value:`${hpBar(enemy.currentHp,enemy.hp)} ${Math.max(0,enemy.currentHp)}`,inline:true});
    await interaction.update({embeds:[embed],components:[mkBattleButtons(player)]});
    if (enemy.currentHp<=0) return endBattle(interaction,player,battle,true);
  }
  if (action==="b_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 이 캐릭터는 반전술식 불가!",ephemeral:true});
    const healAmount=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+healAmount);
    player.reverseCooldown=3;
    await interaction.update({embeds:[new EmbedBuilder().setTitle("♻ 반전술식!").setColor(0x00ff88).setDescription(`**${healAmount}** HP 회복!`).addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} ${player.hp}`,inline:true})],components:[mkBattleButtons(player)]});
  }
  if (action==="b_run") { delete battles[interaction.user.id]; return interaction.update({content:"🏃 전투에서 도주했습니다!",embeds:[],components:[]}); }

  // 적 턴
  if (player.hp>0&&enemy.currentHp>0) {
    const hit=rollHit(player.statusEffects);
    let dmg=0,sLog=[];
    if (hit) {
      dmg=calcDmg(enemy.atk,stats.def);
      player.hp=Math.max(0,player.hp-dmg);
      if (enemy.statusAttack&&Math.random()<enemy.statusAttack.chance) { applyStatus(player,enemy.statusAttack.statusId); sLog=[`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} 상태이상!`]; }
    } else sLog=["⚡ 적 공격 빗나감!"];
    const tick=tickStatus(player,stats.maxHp);
    const embed=new EmbedBuilder().setTitle(`${enemy.name}의 공격!`).setColor(0xff4444).setDescription([hit?`**${dmg}** 데미지!`:"빗나감!",...sLog,...tick.log].join("\n")).addFields({name:"내 HP",value:`${hpBar(player.hp,stats.maxHp)} ${Math.max(0,player.hp)}`,inline:true},{name:"적 HP",value:`${hpBar(enemy.currentHp,enemy.hp)} ${Math.max(0,enemy.currentHp)}`,inline:true});
    await interaction.editReply({embeds:[embed],components:[mkBattleButtons(player)]});
    if (player.hp<=0) return endBattle(interaction,player,battle,false);
    tickCooldowns(player);
  }
  savePlayer(interaction.user.id);
}

async function endBattle(interaction,player,battle,win) {
  const enemy=battle.enemy;
  if (win) {
    const kb=getKoganeBonus(player);
    const xpGain=Math.floor(enemy.xp*(kb.xp||1));
    const crystalGain=Math.floor(enemy.crystals*(kb.crystal||1));
    player.xp+=xpGain; player.crystals+=crystalGain;
    player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
    if (enemy.fingers) player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
    player.wins++; player.potion=Math.min(player.potion+1,10);
    delete battles[interaction.user.id];
    await interaction.editReply({embeds:[new EmbedBuilder().setTitle("🏆 승리!").setColor(0xF5C842).setDescription(`**${enemy.name}** 처치!\n+${xpGain} XP, +${crystalGain}💎\n⚡흑섬: ${player.blackFlashCount}회 누적`)],components:[]});
  } else {
    player.losses++; delete battles[interaction.user.id];
    await interaction.editReply({embeds:[new EmbedBuilder().setTitle("💀 패배...").setColor(0xe63946).setDescription("전투에서 패배했습니다!")],components:[]});
  }
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════
// ── 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handleCullingAction(interaction, player, culling, action) {
  const enemy=culling.currentEnemy;
  const stats=getPlayerStats(player);

  if (action==="c_attack") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({embeds:[cullingEmbed(player,culling,["⚡ 공격 빗나감!"])],components:[mkCullingButtons(player)]}); }
    let dmg=calcDmgForPlayer(player,enemy.def);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    culling.enemyHp=Math.max(0,culling.enemyHp-dmg);
    const log=[`⚔ **${dmg}** 데미지!${bf.triggered?" ⚡**흑섬!**":""}`];
    await interaction.update({embeds:[cullingEmbed(player,culling,log)],components:[mkCullingButtons(player)]});
    if (bf.triggered) await interaction.followUp({embeds:[blackFlashEmbed(dmg,player.blackFlashCount,player.attackStreak)],ephemeral:false}).catch(()=>{});
    if (culling.enemyHp<=0) return advanceCulling(interaction,player,culling,enemy);
  }
  if (action==="c_skill") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const skill=getCurrentSkill(player,player.active);
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({embeds:[cullingEmbed(player,culling,["⚡ 술식 빗나감!"])],components:[mkCullingButtons(player)]}); }
    trackSkillUse(player,skill.name);
    let dmg=calcSkillDmgForPlayer(player,skill.dmg,skill.name);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    culling.enemyHp=Math.max(0,culling.enemyHp-dmg);
    const statusLog=applySkillStatus(skill,enemy,player);
    let cd=5; if(player.sigTech===skill.name) cd=Math.max(1,5-SIG_TECH_BONUS.cdReduce);
    player.skillCooldown=cd;
    const log=[`🌀 **${skill.name}** ${dmg} 데미지!${bf.triggered?" ⚡**흑섬!**":""}`, ...statusLog];
    await interaction.update({embeds:[cullingEmbed(player,culling,log)],components:[mkCullingButtons(player)]});
    if (bf.triggered) await interaction.followUp({embeds:[blackFlashEmbed(dmg,player.blackFlashCount,player.attackStreak)],ephemeral:false}).catch(()=>{});
    if (culling.enemyHp<=0) return advanceCulling(interaction,player,culling,enemy);
  }
  if (action==="c_domain") {
    const ch=CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({content:"❌ 영역전개 없음!",ephemeral:true});
    const dmg=Math.floor(stats.atk*2.5);
    culling.enemyHp=Math.max(0,culling.enemyHp-dmg);
    await interaction.update({embeds:[cullingEmbed(player,culling,[`🌌 ${ch.domain}! **${dmg}** 데미지!`])],components:[mkCullingButtons(player)]});
    if (culling.enemyHp<=0) return advanceCulling(interaction,player,culling,enemy);
  }
  if (action==="c_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    await interaction.update({embeds:[cullingEmbed(player,culling,[`♻ **${heal}** HP 회복!`])],components:[mkCullingButtons(player)]});
  }
  if (action==="c_escape") {
    player.xp+=culling.totalXp; player.crystals+=culling.totalCrystals;
    delete cullings[interaction.user.id];
    await interaction.update({embeds:[new EmbedBuilder().setTitle("🏳 컬링 종료").setColor(0x4a5568).setDescription(`WAVE ${culling.wave-1}까지!\n+${culling.totalXp} XP, +${culling.totalCrystals}💎`)],components:[]});
    savePlayer(interaction.user.id); return;
  }
  // 적 턴
  if (player.hp>0&&culling.enemyHp>0) {
    const hit=rollHit(player.statusEffects);
    let dmg=0,sLog=[];
    if (hit) {
      dmg=calcDmg(enemy.atk,stats.def); player.hp=Math.max(0,player.hp-dmg);
      if (enemy.statusAttack&&Math.random()<enemy.statusAttack.chance) { applyStatus(player,enemy.statusAttack.statusId); sLog=[`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} 상태이상!`]; }
    } else sLog=["⚡ 적 빗나감!"];
    const tick=tickStatus(player,stats.maxHp);
    await interaction.editReply({embeds:[cullingEmbed(player,culling,[hit?`💥 **${dmg}** 데미지!`:"빗나감!",...sLog,...tick.log])],components:[mkCullingButtons(player)]});
    if (player.hp<=0) {
      player.xp+=culling.totalXp; player.crystals+=culling.totalCrystals;
      delete cullings[interaction.user.id];
      await interaction.editReply({embeds:[new EmbedBuilder().setTitle("💀 패배!").setColor(0xe63946).setDescription(`WAVE ${culling.wave}에서 패배!\n+${culling.totalXp} XP, +${culling.totalCrystals}💎`)],components:[]});
      savePlayer(interaction.user.id); return;
    }
    tickCooldowns(player);
  }
  savePlayer(interaction.user.id);
}

async function advanceCulling(interaction,player,culling,enemy) {
  const kb=getKoganeBonus(player);
  const xpGain=Math.floor(enemy.xp*(kb.xp||1)), crystalGain=Math.floor(enemy.crystals*(kb.crystal||1));
  culling.totalXp+=xpGain; culling.totalCrystals+=crystalGain;
  player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
  if (enemy.fingers) player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
  culling.kills++; culling.wave++;
  if (culling.wave>player.cullingBest) player.cullingBest=culling.wave;
  culling.currentEnemy=pickCullingEnemy(culling.wave); culling.enemyHp=culling.currentEnemy.hp;
  await interaction.editReply({embeds:[cullingEmbed(player,culling,[`✅ **${enemy.name}** 처치! WAVE ${culling.wave}`,`+${xpGain} XP, +${crystalGain}💎`])],components:[mkCullingButtons(player)]});
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════
// ── 사멸회유 핸들러
// ════════════════════════════════════════════════════════
async function handleJujutsuAction(interaction, player, jujutsu, action) {
  const enemy=jujutsu.currentEnemy;
  const stats=getPlayerStats(player);

  if (action==="j_attack") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if (!enemy) return interaction.reply({content:"❌ 적을 먼저 선택하세요!",ephemeral:true});
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({embeds:[jujutsuEmbed(player,jujutsu,["⚡ 공격 빗나감!"])],components:mkJujutsuButtons(player,[])}); }
    let dmg=calcDmgForPlayer(player,enemy.def);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    jujutsu.enemyHp=Math.max(0,jujutsu.enemyHp-dmg);
    const log=[`⚔ **${dmg}** 데미지!${bf.triggered?" ⚡**흑섬!**":""}`];
    await interaction.update({embeds:[jujutsuEmbed(player,jujutsu,log)],components:mkJujutsuButtons(player,[])});
    if (bf.triggered) await interaction.followUp({embeds:[blackFlashEmbed(dmg,player.blackFlashCount,player.attackStreak)],ephemeral:false}).catch(()=>{});
    if (jujutsu.enemyHp<=0) return advanceJujutsu(interaction,player,jujutsu,enemy);
  }
  if (action==="j_skill") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if (!enemy) return interaction.reply({content:"❌ 적을 먼저 선택하세요!",ephemeral:true});
    const skill=getCurrentSkill(player,player.active);
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({embeds:[jujutsuEmbed(player,jujutsu,["⚡ 술식 빗나감!"])],components:mkJujutsuButtons(player,[])}); }
    trackSkillUse(player,skill.name);
    let dmg=calcSkillDmgForPlayer(player,skill.dmg,skill.name);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    jujutsu.enemyHp=Math.max(0,jujutsu.enemyHp-dmg);
    const statusLog=applySkillStatus(skill,enemy,player);
    let cd=5; if(player.sigTech===skill.name) cd=Math.max(1,5-SIG_TECH_BONUS.cdReduce);
    player.skillCooldown=cd;
    const log=[`🌀 **${skill.name}** ${dmg} 데미지!${bf.triggered?" ⚡**흑섬!**":""}`, ...statusLog];
    await interaction.update({embeds:[jujutsuEmbed(player,jujutsu,log)],components:mkJujutsuButtons(player,[])});
    if (bf.triggered) await interaction.followUp({embeds:[blackFlashEmbed(dmg,player.blackFlashCount,player.attackStreak)],ephemeral:false}).catch(()=>{});
    if (jujutsu.enemyHp<=0) return advanceJujutsu(interaction,player,jujutsu,enemy);
  }
  if (action==="j_domain") {
    const ch=CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({content:"❌ 영역전개 없음!",ephemeral:true});
    if (!enemy) return interaction.reply({content:"❌ 적을 먼저 선택하세요!",ephemeral:true});
    const dmg=Math.floor(stats.atk*2.5);
    jujutsu.enemyHp=Math.max(0,jujutsu.enemyHp-dmg);
    await interaction.update({embeds:[jujutsuEmbed(player,jujutsu,[`🌌 ${ch.domain}! **${dmg}** 데미지!`])],components:mkJujutsuButtons(player,[])});
    if (jujutsu.enemyHp<=0) return advanceJujutsu(interaction,player,jujutsu,enemy);
  }
  if (action==="j_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    await interaction.update({embeds:[jujutsuEmbed(player,jujutsu,[`♻ **${heal}** HP 회복!`])],components:mkJujutsuButtons(player,[])});
  }
  if (action==="j_escape") {
    player.xp+=jujutsu.totalXp; player.crystals+=jujutsu.totalCrystals;
    if (jujutsu.points>player.jujutsuBest) player.jujutsuBest=jujutsu.points;
    delete jujutsus[interaction.user.id];
    await interaction.update({embeds:[new EmbedBuilder().setTitle("🏳 사멸회유 종료").setColor(0x4a5568).setDescription(`${jujutsu.points}포인트!\n+${jujutsu.totalXp} XP, +${jujutsu.totalCrystals}💎`)],components:[]});
    savePlayer(interaction.user.id); return;
  }
  // 적 턴
  if (enemy&&player.hp>0&&jujutsu.enemyHp>0) {
    const hit=rollHit(player.statusEffects);
    let dmg=0,sLog=[];
    if (hit) {
      dmg=calcDmg(enemy.atk,stats.def); player.hp=Math.max(0,player.hp-dmg);
      if (enemy.statusAttack&&Math.random()<enemy.statusAttack.chance) { applyStatus(player,enemy.statusAttack.statusId); sLog=[`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} 상태이상!`]; }
    } else sLog=["⚡ 적 빗나감!"];
    const tick=tickStatus(player,stats.maxHp);
    await interaction.editReply({embeds:[jujutsuEmbed(player,jujutsu,[hit?`💥 **${dmg}** 데미지!`:"빗나감!",...sLog,...tick.log])],components:mkJujutsuButtons(player,[])});
    if (player.hp<=0) {
      if (jujutsu.points>player.jujutsuBest) player.jujutsuBest=jujutsu.points;
      player.xp+=jujutsu.totalXp; player.crystals+=jujutsu.totalCrystals;
      delete jujutsus[interaction.user.id];
      await interaction.editReply({embeds:[new EmbedBuilder().setTitle("💀 패배!").setColor(0xe63946).setDescription("사멸회유에서 패배!")],components:[]});
      savePlayer(interaction.user.id); return;
    }
    tickCooldowns(player);
  }
  savePlayer(interaction.user.id);
}

async function advanceJujutsu(interaction,player,jujutsu,enemy) {
  const kb=getKoganeBonus(player);
  const xpGain=Math.floor(enemy.xp*(kb.xp||1)), crystalGain=Math.floor(enemy.crystals*(kb.crystal||1));
  jujutsu.totalXp+=xpGain; jujutsu.totalCrystals+=crystalGain;
  jujutsu.points+=enemy.points;
  player.mastery[player.active]=(player.mastery[player.active]||0)+(enemy.masteryXp||1);
  if (enemy.fingers) player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+enemy.fingers);
  if (jujutsu.points>=15) {
    const bonusCrystals=300,bonusXp=500;
    player.crystals+=bonusCrystals; player.xp+=bonusXp;
    if (jujutsu.points>player.jujutsuBest) player.jujutsuBest=jujutsu.points;
    delete jujutsus[interaction.user.id];
    await interaction.update({embeds:[new EmbedBuilder().setTitle("🏆 사멸회유 완료!").setColor(0xF5C842).setDescription(`15포인트 달성!\n보너스: +${bonusCrystals}💎, +${bonusXp} XP`)],components:[]});
    savePlayer(interaction.user.id); return;
  }
  jujutsu.wave++;
  const newChoices=generateJujutsuChoices(jujutsu.wave);
  jujutsu.choices=newChoices; jujutsu.currentEnemy=null;
  await interaction.update({embeds:[jujutsuEmbed(player,jujutsu,[`✅ **${enemy.name}** 처치! +${enemy.points}포인트`,`+${xpGain} XP, +${crystalGain}💎`],newChoices)],components:mkJujutsuButtons(player,newChoices)});
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════
// ── PvP 핸들러
// ════════════════════════════════════════════════════════
async function handlePvpAction(interaction, player, session, action) {
  const userId=interaction.user.id;
  const self=pvpSelf(session,userId), opp=pvpOpponent(session,userId);
  const oppPlayer=players[opp.id];
  if (!oppPlayer) return;

  if (action==="p_attack") {
    if (isIncapacitated(session[self.statusKey])) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if (!rollHit(session[opp.statusKey])) {
      session.turn=opp.id;
      return interaction.update({embeds:[pvpEmbed(session,["⚡ 공격 빗나감!"])],components:[mkPvpButtons(session,opp.id)]});
    }
    let dmg=calcDmgForPlayer(player,getPlayerStats(oppPlayer).def);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    session[opp.hpKey]=Math.max(0,session[opp.hpKey]-dmg);
    const log=[`⚔ **${dmg}** 데미지!${bf.triggered?" ⚡**흑섬!**":""}`];
    if (session[opp.hpKey]<=0) return endPvp(interaction,session,userId,opp.id);
    session.turn=opp.id;
    await interaction.update({embeds:[pvpEmbed(session,log)],components:[mkPvpButtons(session,opp.id)]});
  }
  if (action==="p_skill") {
    if (isIncapacitated(session[self.statusKey])) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const skill=getCurrentSkill(player,player.active);
    if (!rollHit(session[opp.statusKey])) {
      session.turn=opp.id;
      return interaction.update({embeds:[pvpEmbed(session,["⚡ 술식 빗나감!"])],components:[mkPvpButtons(session,opp.id)]});
    }
    trackSkillUse(player,skill.name);
    let dmg=calcSkillDmgForPlayer(player,skill.dmg,skill.name);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    session[opp.hpKey]=Math.max(0,session[opp.hpKey]-dmg);
    const fakeOpp={statusEffects:session[opp.statusKey]};
    const statusLog=applySkillStatus(skill,fakeOpp,player);
    session[opp.statusKey]=fakeOpp.statusEffects;
    let cd=5; if(player.sigTech===skill.name) cd=Math.max(1,5-SIG_TECH_BONUS.cdReduce);
    session[self.skillCdKey]=cd;
    const fx=getSkillEffect(skill.name);
    const log=[`🌀 **${skill.name}** ${dmg} 데미지!${bf.triggered?" ⚡흑섬!":""}`, ...statusLog];
    if (session[opp.hpKey]<=0) return endPvp(interaction,session,userId,opp.id);
    session.turn=opp.id;
    await interaction.update({embeds:[pvpEmbed(session,log)],components:[mkPvpButtons(session,opp.id)]});
  }
  if (action==="p_domain") {
    const ch=CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({content:"❌ 영역전개 없음!",ephemeral:true});
    if (session[self.domainKey]) return interaction.reply({content:"❌ 이미 영역전개 사용함!",ephemeral:true});
    const dmg=Math.floor(getPlayerStats(player).atk*2.5);
    session[opp.hpKey]=Math.max(0,session[opp.hpKey]-dmg);
    session[self.domainKey]=true;
    if (session[opp.hpKey]<=0) return endPvp(interaction,session,userId,opp.id);
    session.turn=opp.id;
    await interaction.update({embeds:[pvpEmbed(session,[`🌌 ${ch.domain}! **${dmg}** 데미지!`])],components:[mkPvpButtons(session,opp.id)]});
  }
  if (action==="p_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const stats=getPlayerStats(player);
    const heal=Math.floor(stats.maxHp*0.4);
    session[self.hpKey]=Math.min(stats.maxHp,session[self.hpKey]+heal);
    session[self.reverseCdKey]=3;
    session.turn=opp.id;
    await interaction.update({embeds:[pvpEmbed(session,[`♻ **${heal}** HP 회복!`])],components:[mkPvpButtons(session,opp.id)]});
  }
  if (action==="p_surrender") {
    player.pvpLosses++; oppPlayer.pvpWins++;
    delete pvpSessions[session.id];
    await interaction.update({embeds:[new EmbedBuilder().setTitle("🏳 항복").setColor(0xe63946).setDescription(`${player.name} 항복! ${oppPlayer.name} 승리!`)],components:[]});
    savePlayer(userId); savePlayer(opp.id); return;
  }
  // 상태이상 틱
  const t1={hp:session.hp1,statusEffects:session.status1}, t2={hp:session.hp2,statusEffects:session.status2};
  const tick1=tickStatus(t1,getPlayerStats(players[session.p1Id]).maxHp);
  const tick2=tickStatus(t2,getPlayerStats(players[session.p2Id]).maxHp);
  session.hp1=Math.max(0,session.hp1-tick1.dmg); session.hp2=Math.max(0,session.hp2-tick2.dmg);
  session.status1=t1.statusEffects; session.status2=t2.statusEffects;
  if (session.hp1<=0||session.hp2<=0) {
    const winnerId=session.hp2<=0?session.p1Id:session.p2Id;
    const loserId=session.hp2<=0?session.p2Id:session.p1Id;
    return endPvp(interaction,session,winnerId,loserId);
  }
  if (session.reverseCd1>0) session.reverseCd1--;
  if (session.reverseCd2>0) session.reverseCd2--;
  if (session.skillCd1>0) session.skillCd1--;
  if (session.skillCd2>0) session.skillCd2--;
  savePlayer(userId); savePlayer(opp.id);
}

async function endPvp(interaction,session,winnerId,loserId) {
  const winner=players[winnerId], loser=players[loserId];
  if (winner) { winner.pvpWins++; winner.crystals+=100; }
  if (loser) loser.pvpLosses++;
  delete pvpSessions[session.id];
  const embed=new EmbedBuilder().setTitle("🏆 PvP 종료!").setColor(0xF5C842).setDescription(`**${winner?.name||winnerId}** 승리! (+100💎)\n**${loser?.name||loserId}** 패배!`);
  try { await interaction.update({embeds:[embed],components:[]}); } catch(e) { try { await interaction.editReply({embeds:[embed],components:[]}); } catch(e2){} }
  if (winner) savePlayer(winnerId);
  if (loser) savePlayer(loserId);
}

// ════════════════════════════════════════════════════════
// ── 파티 컬링 핸들러
// ════════════════════════════════════════════════════════
async function handlePartyCullingAction(interaction, player, session, action) {
  const party=getParty(interaction.user.id);
  if (!party) return;
  const enemy=session.currentEnemy;

  if (action==="pc_attack") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({embeds:[partyCullingEmbed(party,session,["⚡ 공격 빗나감!"])],components:[mkCullingButtons(player)]}); }
    let dmg=calcDmgForPlayer(player,enemy.def);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    session.enemyHp=Math.max(0,session.enemyHp-dmg);
    const log=[`${player.name}의 공격! **${dmg}** 데미지!${bf.triggered?" ⚡흑섬!":""}`];
    await interaction.update({embeds:[partyCullingEmbed(party,session,log)],components:[mkCullingButtons(player)]});
    if (session.enemyHp<=0) return advancePartyCulling(interaction,player,party,session,enemy);
  }
  if (action==="pc_skill") {
    if (isIncapacitated(player.statusEffects)) return interaction.reply({content:"❌ 상태이상으로 행동 불가!",ephemeral:true});
    const skill=getCurrentSkill(player,player.active);
    if (!rollHit(enemy.statusEffects)) { player.attackStreak=0; return interaction.update({embeds:[partyCullingEmbed(party,session,["⚡ 술식 빗나감!"])],components:[mkCullingButtons(player)]}); }
    trackSkillUse(player,skill.name);
    let dmg=calcSkillDmgForPlayer(player,skill.dmg,skill.name);
    const bf=tryBlackFlash(player,dmg); dmg=bf.dmg;
    session.enemyHp=Math.max(0,session.enemyHp-dmg);
    const statusLog=applySkillStatus(skill,enemy,player);
    let cd=5; if(player.sigTech===skill.name) cd=Math.max(1,5-SIG_TECH_BONUS.cdReduce);
    player.skillCooldown=cd;
    await interaction.update({embeds:[partyCullingEmbed(party,session,[`🌀 ${player.name}의 **${skill.name}** ${dmg} 데미지!${bf.triggered?" ⚡흑섬!":""}`, ...statusLog])],components:[mkCullingButtons(player)]});
    if (session.enemyHp<=0) return advancePartyCulling(interaction,player,party,session,enemy);
  }
  if (action==="pc_domain") {
    const ch=CHARACTERS[player.active];
    if (!ch.domain) return interaction.reply({content:"❌ 영역전개 없음!",ephemeral:true});
    const dmg=Math.floor(getPlayerStats(player).atk*2.5);
    session.enemyHp=Math.max(0,session.enemyHp-dmg);
    await interaction.update({embeds:[partyCullingEmbed(party,session,[`🌌 ${player.name}의 ${ch.domain}! **${dmg}** 데미지!`])],components:[mkCullingButtons(player)]});
    if (session.enemyHp<=0) return advancePartyCulling(interaction,player,party,session,enemy);
  }
  if (action==="pc_reverse") {
    if (!REVERSE_CHARS.has(player.active)) return interaction.reply({content:"❌ 반전술식 불가!",ephemeral:true});
    const stats=getPlayerStats(player);
    const heal=Math.floor(stats.maxHp*0.4);
    player.hp=Math.min(stats.maxHp,player.hp+heal); player.reverseCooldown=3;
    await interaction.update({embeds:[partyCullingEmbed(party,session,[`♻ ${player.name} **${heal}** HP 회복!`])],components:[mkCullingButtons(player)]});
  }
  // 적 턴
  if (session.enemyHp>0) {
    const aliveMembers=party.members.filter(uid=>players[uid]?.hp>0);
    if (aliveMembers.length>0) {
      const targetId=aliveMembers[Math.floor(Math.random()*aliveMembers.length)];
      const target=players[targetId];
      const hit=rollHit(target.statusEffects);
      let dmg=0,sLog=[];
      if (hit) {
        dmg=calcDmg(enemy.atk,getPlayerStats(target).def); target.hp=Math.max(0,target.hp-dmg);
        if (enemy.statusAttack&&Math.random()<enemy.statusAttack.chance) { applyStatus(target,enemy.statusAttack.statusId); sLog=[`${STATUS_EFFECTS[enemy.statusAttack.statusId].emoji} 상태이상!`]; }
      } else sLog=["⚡ 빗나감!"];
      const tick=tickStatus(target,getPlayerStats(target).maxHp);
      await interaction.editReply({embeds:[partyCullingEmbed(party,session,[`💥 ${enemy.name} → ${target.name} ${hit?`**${dmg}** 데미지!`:"빗나감!"}`, ...sLog, ...tick.log])],components:[mkCullingButtons(player)]});
    }
    if (party.members.every(uid=>!players[uid]||players[uid].hp<=0)) {
      const totalXp=session.totalXp, totalCrystals=session.totalCrystals;
      for (const uid of party.members) { const p=players[uid]; if(p) { p.xp+=totalXp; p.crystals+=totalCrystals; savePlayer(uid); } }
      delete cullings[party.id];
      await interaction.editReply({embeds:[new EmbedBuilder().setTitle("💀 파티 전멸").setColor(0xe63946).setDescription(`WAVE ${session.wave}까지!\n각 +${totalXp} XP, +${totalCrystals}💎`)],components:[]});
      return;
    }
  }
  tickCooldowns(player);
  for (const uid of party.members) { if(players[uid]) tickCooldowns(players[uid]); }
  savePlayer(interaction.user.id);
}

async function advancePartyCulling(interaction,player,party,session,enemy) {
  const xpGain=Math.floor(enemy.xp/party.members.length), crystalGain=Math.floor(enemy.crystals/party.members.length);
  session.totalXp+=xpGain; session.totalCrystals+=crystalGain;
  for (const uid of party.members) { const p=players[uid]; if(p&&p.hp>0) { p.mastery[p.active]=(p.mastery[p.active]||0)+(enemy.masteryXp||1); } }
  session.kills++; session.wave++;
  if (session.wave>(party.bestWave||0)) party.bestWave=session.wave;
  session.currentEnemy=pickCullingEnemy(session.wave); session.enemyHp=session.currentEnemy.hp;
  await interaction.editReply({embeds:[partyCullingEmbed(party,session,[`✅ **${enemy.name}** 처치! WAVE ${session.wave}`,`각 +${xpGain} XP, +${crystalGain}💎`])],components:[mkCullingButtons(player)]});
  savePlayer(interaction.user.id);
}

// ════════════════════════════════════════════════════════
// ── ready 이벤트
// ════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ 로그인: ${client.user.tag}`);
  await dbInit();
  players = await dbLoad();
  console.log("🚀 주술회전 RPG 봇 활성화");
});

// ════════════════════════════════════════════════════════
// ── 버튼 인터랙션
// ════════════════════════════════════════════════════════
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const {customId, user} = interaction;
  const userId = user.id;
  const player = getPlayer(userId, user.username);

  try {
    // 일반 전투
    if (customId.startsWith("b_")) {
      const battle=battles[userId];
      if (!battle) return interaction.reply({content:"⚔️ 진행 중인 전투 없음.",ephemeral:true});
      return handleBattleAction(interaction,player,battle,customId);
    }
    // 컬링
    if (customId.startsWith("c_")) {
      const culling=cullings[userId];
      if (!culling) return interaction.reply({content:"🌊 진행 중인 컬링 없음.",ephemeral:true});
      return handleCullingAction(interaction,player,culling,customId);
    }
    // 사멸회유
    if (customId.startsWith("j_")) {
      const jujutsu=jujutsus[userId];
      if (!jujutsu) return interaction.reply({content:"🎯 진행 중인 사멸회유 없음.",ephemeral:true});
      if (customId.startsWith("j_choice_")) {
        const idx=parseInt(customId.split("_")[2]);
        if (jujutsu.choices&&jujutsu.choices[idx]) {
          jujutsu.currentEnemy=JSON.parse(JSON.stringify(jujutsu.choices[idx]));
          jujutsu.enemyHp=jujutsu.currentEnemy.hp;
          jujutsu.choices=null;
          await interaction.update({embeds:[jujutsuEmbed(player,jujutsu)],components:[mkJujutsuFightButtons(player)]});
        } else return interaction.reply({content:"❌ 잘못된 선택.",ephemeral:true});
        return;
      }
      return handleJujutsuAction(interaction,player,jujutsu,customId);
    }
    // 파티 초대
    if (customId.startsWith("party_invite_")) {
      const parts=customId.split("_");
      const act=parts[2], partyId=parts[3], targetId=parts[4];
      if (user.id!==targetId) return interaction.reply({content:"❌ 당신을 위한 초대가 아닙니다.",ephemeral:true});
      const invite=partyInvites[targetId];
      if (!invite||invite.partyId!==partyId) return interaction.reply({content:"❌ 만료된 초대.",ephemeral:true});
      if (act==="accept") {
        const party=parties[partyId];
        if (!party) return interaction.reply({content:"❌ 파티가 해체되었습니다.",ephemeral:true});
        if (party.members.length>=4) return interaction.reply({content:"❌ 파티 가득 참.",ephemeral:true});
        if (getPartyId(targetId)) return interaction.reply({content:"❌ 이미 다른 파티에 있습니다.",ephemeral:true});
        party.members.push(targetId); delete partyInvites[targetId];
        return interaction.update({content:`✅ 파티 참가! (${party.members.length}/4)`,embeds:[],components:[]});
      } else {
        delete partyInvites[targetId];
        return interaction.update({content:"❌ 파티 초대 거절.",embeds:[],components:[]});
      }
    }
    // PvP 도전
    if (customId.startsWith("pvp_challenge_")) {
      const parts=customId.split("_");
      const act=parts[2], challengerId=parts[3]; // pvp_challenge_accept_ID or pvp_challenge_decline_ID
      // customId format: pvp_challenge_accept_CHALLENGERID or pvp_challenge_decline_CHALLENGERID
      if (act==="accept") {
        const challenge=pvpChallenges[challengerId];
        if (!challenge||challenge.target!==user.id) return interaction.reply({content:"❌ 유효하지 않은 도전.",ephemeral:true});
        if (getPvpSessionByUser(user.id)||getPvpSessionByUser(challengerId)) return interaction.reply({content:"❌ 이미 PvP 중.",ephemeral:true});
        const p1=players[challengerId], p2=players[user.id];
        if (!p1||!p2) return interaction.reply({content:"❌ 플레이어 정보 없음.",ephemeral:true});
        const s1=getPlayerStats(p1), s2=getPlayerStats(p2);
        const sessionId=`${_pvpIdSeq++}`;
        pvpSessions[sessionId]={id:sessionId,p1Id:challengerId,p2Id:user.id,hp1:s1.maxHp,hp2:s2.maxHp,status1:[],status2:[],skillCd1:0,skillCd2:0,reverseCd1:0,reverseCd2:0,domainUsed1:false,domainUsed2:false,turn:challengerId,round:1};
        delete pvpChallenges[challengerId];
        return interaction.update({embeds:[pvpEmbed(pvpSessions[sessionId])],components:[mkPvpButtons(pvpSessions[sessionId],challengerId)]});
      } else {
        delete pvpChallenges[challengerId];
        return interaction.update({content:"❌ 상대방이 결투를 거절했습니다.",embeds:[],components:[]});
      }
    }
    // PvP 전투
    if (customId.startsWith("p_")) {
      const session=getPvpSessionByUser(userId);
      if (!session) return interaction.reply({content:"⚔️ 진행 중인 PvP 없음.",ephemeral:true});
      if (session.turn!==userId) return interaction.reply({content:"⏳ 당신의 턴이 아닙니다!",ephemeral:true});
      return handlePvpAction(interaction,player,session,customId);
    }
    // 파티 컬링
    if (customId.startsWith("pc_")) {
      const party=getParty(userId);
      if (!party) return interaction.reply({content:"👥 파티에 소속되어 있지 않습니다.",ephemeral:true});
      const session=cullings[party.id];
      if (!session) return interaction.reply({content:"🌊 진행 중인 파티 컬링 없음.",ephemeral:true});
      if ((players[userId]?.hp||0)<=0) return interaction.reply({content:"💀 전투 불능 상태!",ephemeral:true});
      return handlePartyCullingAction(interaction,player,session,customId);
    }
  } catch(e) {
    console.error("버튼 핸들러 오류:", e);
    try { await interaction.reply({content:"⚠️ 오류가 발생했습니다. 다시 시도해주세요.",ephemeral:true}); } catch(e2){}
  }
});

// ════════════════════════════════════════════════════════
// ── !명령어 핸들러
// ════════════════════════════════════════════════════════
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content=message.content.trim();
  if (!content.startsWith("!")) return;

  const args=content.slice(1).trim().split(/\s+/);
  const cmd=args[0].toLowerCase();
  const userId=message.author.id;
  const player=getPlayer(userId,message.author.username);

  try {

  // ── 프로필
  if (cmd==="프로필") {
    const gifAttachment=await renderGIF(message.author,player.active).catch(()=>null);
    if (gifAttachment) await message.reply({embeds:[profileEmbed(player)],files:[gifAttachment]});
    else await message.reply({embeds:[profileEmbed(player)]});
  }

  // ── 도감
  else if (cmd==="도감") {
    const sub=args[1]?.toLowerCase();
    if (sub&&CHARACTERS[sub]) await message.reply({embeds:[charDetailEmbed(sub)]});
    else await message.reply({embeds:[docanEmbed()]});
  }

  // ── 전투
  else if (cmd==="전투") {
    if (battles[userId]) return message.reply("❌ 이미 전투 중입니다!");
    const stats=getPlayerStats(player);
    if (player.hp<=0) { player.hp=stats.maxHp; savePlayer(userId); }
    const enemyTemplate=ENEMIES[Math.floor(Math.random()*3)]; // e1~e3 랜덤
    const enemy={...enemyTemplate,currentHp:enemyTemplate.hp,statusEffects:[]};
    battles[userId]={enemy};
    const embed=new EmbedBuilder().setTitle("⚔️ 전투 시작!").setColor(0xff0000).setDescription(`**${enemy.name}** 등장!\n> ${enemy.emoji} HP:${enemy.hp} ATK:${enemy.atk} DEF:${enemy.def}`).addFields({name:"내 HP",value:`${player.hp}/${stats.maxHp}`,inline:true},{name:"적 HP",value:`${enemy.currentHp}/${enemy.hp}`,inline:true});
    await message.reply({embeds:[embed],components:[mkBattleButtons(player)]});
  }

  // ── 술식
  else if (cmd==="술식") {
    await message.reply({embeds:[skillEmbed(player)]});
  }

  // ── 가챠
  else if (cmd==="가챠"||cmd==="가챠10") {
    const count=cmd==="가챠10"?10:(parseInt(args[1])||1);
    if (count!==1&&count!==10) return message.reply("❌ `!가챠 1` 또는 `!가챠 10`");
    const cost=count===1?150:1350;
    if (player.crystals<cost) return message.reply(`💎 크리스탈 부족! (필요: ${cost}, 보유: ${player.crystals})`);
    player.crystals-=cost;
    const loadingMsg=await message.reply({embeds:[gachaLoadingEmbed(1)]});
    await new Promise(r=>setTimeout(r,1500));
    await loadingMsg.edit({embeds:[gachaLoadingEmbed(2)]});
    await new Promise(r=>setTimeout(r,1500));
    if (count===1) {
      const result=rollGacha(1)[0];
      const isNew=!player.owned.includes(result);
      if (isNew) player.owned.push(result);
      else player.crystals+=50;
      if (!player.mastery[result]) player.mastery[result]=0;
      const grade=CHARACTERS[result].grade;
      await loadingMsg.edit({embeds:[gachaRevealEmbed(grade),gachaResultEmbed(result,isNew,player)]});
    } else {
      const results=rollGacha(10);
      const dupCrystals=results.filter(id=>player.owned.includes(id)).length*50;
      const newOnes=results.filter(id=>!player.owned.includes(id));
      for (const id of newOnes) { player.owned.push(id); if(!player.mastery[id]) player.mastery[id]=0; }
      player.crystals+=dupCrystals;
      await loadingMsg.edit({embeds:[gacha10ResultEmbed(results,newOnes,dupCrystals,player)]});
    }
    savePlayer(userId);
  }

  // ── 활성
  else if (cmd==="활성") {
    const charId=(args[1]||"").toLowerCase();
    if (!CHARACTERS[charId]) return message.reply("❌ 존재하지 않는 캐릭터!\n캐릭터 목록: `!도감`");
    if (!player.owned.includes(charId)) return message.reply("❌ 보유하지 않은 캐릭터!");
    player.active=charId;
    if (!player.mastery[charId]) player.mastery[charId]=0;
    const stats=getPlayerStats(player);
    player.hp=stats.maxHp;
    await message.reply(`✅ **${CHARACTERS[charId].name}**(으)로 변경! HP 회복 완료.`);
    savePlayer(userId);
  }

  // ── 출석
  else if (cmd==="출석") {
    const now=Date.now(), last=player.lastDaily||0;
    if (now-last<86400000) return message.reply(`⏰ 이미 출석! ${Math.ceil((86400000-(now-last))/3600000)}시간 후 가능.`);
    const streak=Math.min(player.dailyStreak||0,30);
    const total=100+streak*5;
    player.crystals+=total; player.lastDaily=now; player.dailyStreak=(player.dailyStreak||0)+1;
    await message.reply(`✅ 출석 체크! **+${total}💎** (연속 **${player.dailyStreak}**일)`);
    savePlayer(userId);
  }

  // ── 회복
  else if (cmd==="회복") {
    if (player.potion<=0) return message.reply("❌ 회복약 없음!");
    player.hp=getPlayerStats(player).maxHp; player.potion--;
    await message.reply(`✅ HP 완전 회복! (남은 회복약: **${player.potion}개**)`);
    savePlayer(userId);
  }

  // ── 코가네가챠
  else if (cmd==="코가네가챠") {
    if (player.crystals<200) return message.reply("💎 크리스탈 부족! (필요: 200)");
    player.crystals-=200; player.koganeGachaCount=(player.koganeGachaCount||0)+1;
    const grade=rollKogane();
    const gradeOrder=["3급","2급","1급","특급","전설"];
    const oldGrade=player.kogane?.grade;
    const isUpgrade=!player.kogane||gradeOrder.indexOf(grade)>gradeOrder.indexOf(oldGrade);
    if (isUpgrade) player.kogane={grade};
    else player.crystals+=50;
    await message.reply({embeds:[koganeGachaEmbed(grade,isUpgrade,player,isUpgrade?oldGrade:null)]});
    savePlayer(userId);
  }

  // ── 코가네
  else if (cmd==="코가네") {
    await message.reply({embeds:[koganeProfileEmbed(player)]});
  }

  // ── 손가락
  else if (cmd==="손가락") {
    const fingers=player.sukunaFingers||0;
    const bonus=getFingerBonus(fingers);
    const bar="█".repeat(fingers)+"░".repeat(SUKUNA_FINGER_MAX-fingers);
    await message.reply(`👹 **스쿠나 손가락**: \`${bar}\` **${fingers}/${SUKUNA_FINGER_MAX}**\n${bonus.label}\n🗡️ ATK +${bonus.atkBonus} | 🛡️ DEF +${bonus.defBonus} | 💚 HP +${bonus.hpBonus}`);
  }

  // ── 컬링
  else if (cmd==="컬링") {
    if (cullings[userId]) return message.reply("🌊 이미 컬링 중!");
    const stats=getPlayerStats(player);
    if (player.hp<=0) { player.hp=stats.maxHp; }
    const firstEnemy=pickCullingEnemy(1);
    cullings[userId]={wave:1,kills:0,totalXp:0,totalCrystals:0,currentEnemy:firstEnemy,enemyHp:firstEnemy.hp};
    await message.reply({embeds:[cullingEmbed(player,cullings[userId])],components:[mkCullingButtons(player)]});
  }

  // ── 사멸회유
  else if (cmd==="사멸회유") {
    if (jujutsus[userId]) return message.reply("🎯 이미 사멸회유 중!");
    const stats=getPlayerStats(player);
    if (player.hp<=0) { player.hp=stats.maxHp; }
    const choices=generateJujutsuChoices(1);
    jujutsus[userId]={wave:1,points:0,totalXp:0,totalCrystals:0,choices,currentEnemy:null,enemyHp:0};
    await message.reply({embeds:[jujutsuEmbed(player,jujutsus[userId],[],choices)],components:mkJujutsuButtons(player,choices)});
  }

  // ── 결투
  else if (cmd==="결투") {
    const target=message.mentions.users.first();
    if (!target) return message.reply("❌ @멘션으로 대상 지정!");
    if (target.id===userId) return message.reply("❌ 자신과 결투 불가!");
    if (target.bot) return message.reply("❌ 봇과 결투 불가!");
    if (getPvpSessionByUser(userId)||getPvpSessionByUser(target.id)) return message.reply("❌ 이미 PvP 중!");
    pvpChallenges[userId]={target:target.id};
    const embed=new EmbedBuilder().setTitle("⚔️ PvP 결투 신청").setDescription(`${target}님, ${message.author}님이 결투를 신청했습니다!`).setColor(0xF5C842).setFooter({text:"30초 내 수락/거절"});
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pvp_challenge_accept_${userId}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pvp_challenge_decline_${userId}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
    );
    await message.reply({content:`${target}`,embeds:[embed],components:[buttons]});
    setTimeout(()=>{ if(pvpChallenges[userId]) delete pvpChallenges[userId]; },30000);
  }

  // ── 파티생성
  else if (cmd==="파티생성") {
    if (getPartyId(userId)) return message.reply("❌ 이미 파티에 소속됨!");
    const partyId=`${_partyIdSeq++}`;
    parties[partyId]={id:partyId,leader:userId,members:[userId],bestWave:0};
    await message.reply(`✅ 파티 생성! ID: **${partyId}**\n\`!파티초대 @유저\`로 초대하세요.`);
  }

  // ── 파티초대
  else if (cmd==="파티초대") {
    const target=message.mentions.users.first();
    if (!target) return message.reply("❌ @멘션으로 초대!");
    const party=getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    if (party.leader!==userId) return message.reply("❌ 파티장만 초대 가능!");
    if (party.members.length>=4) return message.reply("❌ 파티 가득 참! (최대 4명)");
    if (getPartyId(target.id)) return message.reply("❌ 상대방이 이미 파티에 있음!");
    partyInvites[target.id]={partyId:party.id,inviter:userId};
    const embed=new EmbedBuilder().setTitle("👥 파티 초대").setDescription(`${target}님, ${message.author}님이 파티에 초대했습니다!`).setColor(0x4ade80);
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_invite_accept_${party.id}_${target.id}`).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`party_invite_decline_${party.id}_${target.id}`).setLabel("❌ 거절").setStyle(ButtonStyle.Danger)
    );
    await message.reply({content:`${target}`,embeds:[embed],components:[buttons]});
    setTimeout(()=>{ if(partyInvites[target.id]) delete partyInvites[target.id]; },60000);
  }

  // ── 파티나가기
  else if (cmd==="파티나가기") {
    const party=getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    const isLeader=party.leader===userId;
    party.members=party.members.filter(id=>id!==userId);
    if (party.members.length===0) delete parties[party.id];
    else if (isLeader) party.leader=party.members[0];
    await message.reply(`✅ 파티 탈퇴!${isLeader&&party.members?.length>0?" 새 파티장이 지정됨.":""}`);
  }

  // ── 파티컬링
  else if (cmd==="파티컬링") {
    const party=getParty(userId);
    if (!party) return message.reply("❌ 파티 없음!");
    if (party.leader!==userId) return message.reply("❌ 파티장만 시작 가능!");
    if (cullings[party.id]) return message.reply("🌊 이미 파티 컬링 중!");
    for (const uid of party.members) {
      const p=players[uid];
      if (p&&p.hp<=0) { const s=getPlayerStats(p); p.hp=s.maxHp; }
    }
    const firstEnemy=pickCullingEnemy(1);
    cullings[party.id]={wave:1,kills:0,totalXp:0,totalCrystals:0,currentEnemy:firstEnemy,enemyHp:firstEnemy.hp};
    await message.reply({embeds:[partyCullingEmbed(party,cullings[party.id])],components:[mkCullingButtons(player)]});
  }

  // ── 코드
  else if (cmd==="코드") {
    const code=(args[1]||"").toLowerCase();
    if (!code) return message.reply("❌ 코드 입력! `!코드 [코드명]`");
    if ((player.usedCodes||[]).includes(code)) return message.reply("❌ 이미 사용한 코드!");
    if (CODES[code]) {
      player.crystals+=(CODES[code].crystals||0);
      player.usedCodes.push(code);
      await message.reply(`✅ 코드 사용 완료! **+${CODES[code].crystals||0}💎**`);
      savePlayer(userId);
    } else message.reply("❌ 유효하지 않은 코드!");
  }

  // ── 주력술식
  else if (cmd==="주력술식") {
    const skillName=args.slice(1).join(" ");
    if (!skillName) return message.reply({embeds:[sigTechEmbed(player)]});
    const charId=player.active;
    const skill=CHARACTERS[charId].skills.find(s=>s.name===skillName);
    if (!skill) return message.reply(`❌ 존재하지 않는 술식입니다!\n현재 캐릭터의 스킬: ${CHARACTERS[charId].skills.map(s=>s.name).join(", ")}`);
    if (!canSetSigTech(player,skillName)) {
      const current=player.skillUseCount?.[skillName]||0;
      return message.reply(`❌ **${skillName}** 주력 지정 불가!\n현재 사용 횟수: **${current}/${SIG_TECH_THRESHOLD}**\n앞으로 **${SIG_TECH_THRESHOLD-current}**번 더 사용해야 합니다.`);
    }
    player.sigTech=skillName;
    await message.reply(`⚡ **${skillName}**을(를) 주력 술식으로 지정했습니다!\n> DMG +35% | 상태이상확률 +20% | 술식 쿨다운 -2`);
    savePlayer(userId);
  }

  // ── 도움말
  else if (cmd==="도움말"||cmd==="help") {
    const embed=new EmbedBuilder()
      .setTitle("🔱 주술회전 RPG 명령어")
      .setColor(0xF5C842)
      .setDescription([
        "**⚔️ 전투**",
        "`!전투` — 일반 전투 (랜덤 적)",
        "`!컬링` — 웨이브 무한 컬링",
        "`!사멸회유` — 포인트 수집 모드",
        "`!결투 @유저` — PvP 결투",
        "",
        "**👥 파티**",
        "`!파티생성` `!파티초대 @유저` `!파티나가기` `!파티컬링`",
        "",
        "**🎲 가챠/캐릭터**",
        "`!가챠 1` `!가챠 10` `!가챠10` — 캐릭터 뽑기 (150/1350💎)",
        "`!코가네가챠` — 펫 뽑기 (200💎)",
        "`!활성 [캐릭터ID]` — 주력 변경",
        "`!도감` `!도감 [캐릭터ID]` — 전체/상세 도감",
        "",
        "**⚡ 시스템**",
        "`!프로필` — 내 정보 (GIF 프로필 포함)",
        "`!술식` — 스킬 트리",
        "`!주력술식 [스킬명]` — 주력 술식 지정 (50회 사용 후)",
        "`!출석` — 매일 보상",
        "`!회복` — 회복약 사용",
        "`!손가락` — 스쿠나 손가락",
        "`!코가네` — 펫 정보",
        "`!코드 [코드]` — 쿠폰 사용",
        "",
        "**⚡ 흑섬 시스템**",
        "공격/술식 시 **15%** 확률로 발동, 연속 공격 시 확률 증가",
        "흑섬 발동 시 데미지 **×2.5배**!",
        "",
        "**⚡ 주력 술식 시스템**",
        "특정 술식 **50회** 사용 후 `!주력술식 스킬명`으로 지정",
        "지정 후 DMG **+35%**, 상태이상확률 **+20%**, 쿨다운 **-2**",
      ].join("\n"))
      .setFooter({text:"즐거운 게임 되세요! 🔱"});
    await message.reply({embeds:[embed]});
  }

  // ── 개발자 명령어
  else if (cmd==="dev"&&isDev(userId)) {
    const sub=args[1]?.toLowerCase();
    if (sub==="reset") {
      player.skillCooldown=0; player.reverseCooldown=0; player.attackStreak=0;
      player.statusEffects=[];
      await message.reply("✅ 쿨다운/상태이상 초기화!");
      savePlayer(userId);
    } else if (sub==="give") {
      const item=args[2], amount=parseInt(args[3])||1;
      if (item==="크리스탈") { player.crystals+=amount; }
      else if (item==="회복약") { player.potion+=amount; }
      else if (item==="손가락") { player.sukunaFingers=Math.min(SUKUNA_FINGER_MAX,(player.sukunaFingers||0)+amount); }
      else if (item==="xp") { player.xp+=amount; }
      else return message.reply("❌ 아이템: 크리스탈, 회복약, 손가락, xp");
      await message.reply(`✅ ${item} +${amount} 지급!`);
      savePlayer(userId);
    } else if (sub==="hp") {
      const stats=getPlayerStats(player);
      player.hp=stats.maxHp;
      await message.reply("✅ HP 최대 회복!");
      savePlayer(userId);
    } else if (sub==="mastery") {
      const amount=parseInt(args[2])||100;
      player.mastery[player.active]=(player.mastery[player.active]||0)+amount;
      await message.reply(`✅ 숙련도 +${amount}!`);
      savePlayer(userId);
    } else if (sub==="bf") {
      const amount=parseInt(args[2])||10;
      if (!player.skillUseCount) player.skillUseCount={};
      for (const s of CHARACTERS[player.active].skills) {
        player.skillUseCount[s.name]=(player.skillUseCount[s.name]||0)+amount;
      }
      await message.reply(`✅ 모든 스킬 사용 횟수 +${amount}! (주력술식 지정 가능 확인: !술식)`);
      savePlayer(userId);
    } else if (sub==="sukuna") {
      if (!player.owned.includes("sukuna")) { player.owned.push("sukuna"); player.mastery["sukuna"]=0; }
      player.active="sukuna"; const s=getPlayerStats(player); player.hp=s.maxHp;
      await message.reply("✅ 스쿠나 강제 활성화!");
      savePlayer(userId);
    } else {
      await message.reply("**!dev 명령어:**\n`!dev reset` — 쿨다운 초기화\n`!dev give [아이템] [수량]` — 아이템 지급\n`!dev hp` — HP 회복\n`!dev mastery [수량]` — 숙련도 지급\n`!dev bf [수량]` — 스킬 사용횟수 증가\n`!dev sukuna` — 스쿠나 활성화");
    }
  }

  } catch(e) {
    console.error(`명령어 오류 [${cmd}]:`, e);
    try { await message.reply("⚠️ 오류가 발생했습니다. 다시 시도해주세요."); } catch(e2){}
  }
});

// ════════════════════════════════════════════════════════
// ── 로그인
// ════════════════════════════════════════════════════════
client.login(TOKEN);
ENDOFFILE
echo "파일 작성 완료"
Output

Command argument is 137_101 bytes, exceeding the 100_000-byte per-argument limit. For large content, pipe via stdin or use a file-write API instead of embedding the content inline in the command. Argument preview: 'cat > /home/claude/bot.js << \'ENDOFFILE\'\nrequire("dotenv").config();\nconst express = require("express");\nconst { Pool } = require("pg");\nconst {\n  Client, GatewayIntentBits, EmbedBuilder,\n  ActionRowB'
