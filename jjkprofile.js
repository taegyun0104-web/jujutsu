// ==================== GIF 프로필 카드 (주술회전 테마) ====================
// 필요한 패키지: npm install canvas gifencoder

const { AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage } = require("canvas");
const GIFEncoder = require("gifencoder");
const { createWriteStream, readFileSync, unlinkSync } = require("fs");
const path = require("path");

// ==================== GIF 프로필 카드 생성 함수 ====================
async function createJJKGifProfileCard(player, stats, ch, avatarUrl) {
  const width = 600;
  const height = 800;
  const encoder = new GIFEncoder(width, height);
  
  const tempPath = path.join(__dirname, `jjk_profile_${player.id || Date.now()}.gif`);
  const stream = createWriteStream(tempPath);
  encoder.createReadStream().pipe(stream);
  
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(120);
  encoder.setQuality(10);
  
  for (let frame = 0; frame < 12; frame++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    
    // 배경
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#0a0a1a");
    grad.addColorStop(0.5, "#1a1a2e");
    grad.addColorStop(1, "#0d0d1a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    
    // 배경 문자
    ctx.font = "bold 80px 'Noto Sans KR'";
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fillText("呪", 50, 200);
    ctx.fillText("術", 450, 400);
    ctx.fillText("迴", 100, 600);
    ctx.fillText("戦", 480, 750);
    
    // 외곽 테두리
    const borderColors = ["#F5C842", "#ff8c00", "#e63946", "#7C5CFC"];
    const colorIdx = frame % borderColors.length;
    ctx.strokeStyle = borderColors[colorIdx];
    ctx.lineWidth = 6;
    ctx.strokeRect(12, 12, width - 24, height - 24);
    
    const pulse = Math.sin(frame * 0.5) * 0.3 + 0.7;
    ctx.strokeStyle = `rgba(245, 200, 66, ${pulse * 0.6})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 18, width - 36, height - 36);
    
    // 모서리 장식
    const cornerSize = 40;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#F5C842";
    ctx.beginPath();
    ctx.moveTo(12, 12 + cornerSize);
    ctx.lineTo(12, 12);
    ctx.lineTo(12 + cornerSize, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width - 12, 12 + cornerSize);
    ctx.lineTo(width - 12, 12);
    ctx.lineTo(width - 12 - cornerSize, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, height - 12 - cornerSize);
    ctx.lineTo(12, height - 12);
    ctx.lineTo(12 + cornerSize, height - 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width - 12, height - 12 - cornerSize);
    ctx.lineTo(width - 12, height - 12);
    ctx.lineTo(width - 12 - cornerSize, height - 12);
    ctx.stroke();
    
    // 디스코드 프로필 (오른쪽 상단)
    const avatarSize = 80;
    const avatarX = width - avatarSize - 25;
    const avatarY = 25;
    try {
      const avatarImg = await loadImage(avatarUrl);
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2 + 3, 0, Math.PI * 2);
      ctx.strokeStyle = `hsl(${frame * 30}, 80%, 60%)`;
      ctx.lineWidth = 3;
      ctx.stroke();
    } catch (e) {
      ctx.fillStyle = "#2a2a3e";
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize/2, avatarY + avatarSize/2, avatarSize/2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#aaa";
      ctx.font = "40px sans-serif";
      ctx.fillText("👤", avatarX + avatarSize/4, avatarY + avatarSize/1.5);
    }
    
    // 캐릭터 정보
    ctx.font = "bold 32px 'Noto Sans KR'";
    ctx.fillStyle = "#F5C842";
    ctx.textAlign = "center";
    ctx.fillText(ch.name, width / 2, 80);
    ctx.font = "18px 'Noto Sans KR'";
    ctx.fillStyle = "#ff8c00";
    const gradeLabel = {
      "특급": "【 특 급 】", "준특급": "【준특급】", "1급": "【 1 급 】",
      "준1급": "【준 1급】", "2급": "【 2 급 】", "3급": "【 3 급 】", "4급": "【 4 급 】"
    };
    ctx.fillText(gradeLabel[ch.grade] || `【 ${ch.grade} 】`, width / 2, 120);
    
    if (ch.domain) {
      ctx.font = "14px monospace";
      ctx.fillStyle = "#7C5CFC";
      ctx.fillText(`🌌 영역전개: ${ch.domain}`, width / 2, 150);
    }
    
    // HP 바
    const hpPercent = Math.max(0, player.hp) / stats.maxHp;
    const hpBarWidth = width - 100;
    const hpBarX = 50;
    const hpBarY = 190;
    ctx.fillStyle = "#330000";
    ctx.fillRect(hpBarX, hpBarY, hpBarWidth, 20);
    if (hpPercent > 0.6) ctx.fillStyle = "#4ade80";
    else if (hpPercent > 0.3) ctx.fillStyle = "#facc15";
    else ctx.fillStyle = "#ef4444";
    ctx.fillRect(hpBarX, hpBarY, hpBarWidth * hpPercent, 20);
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${Math.max(0, player.hp)}/${stats.maxHp} HP`, width / 2, hpBarY + 16);
    
    // 스탯
    ctx.font = "16px monospace";
    ctx.fillStyle = "#ddd";
    ctx.fillText(`🗡️ ATK ${stats.atk}    🛡️ DEF ${stats.def}    💨 SPD ${ch.spd}`, width / 2, 250);
    
    // 술식
    const getCurrentSkill = (p, active) => {
      const char = CHARACTERS[active];
      const mastery = p.mastery?.[active] || 0;
      const available = char.skills.filter(s => mastery >= s.minMastery);
      return available[available.length - 1] || char.skills[0];
    };
    const skill = getCurrentSkill(player, player.active);
    ctx.font = "bold 18px 'Noto Sans KR'";
    ctx.fillStyle = "#7C5CFC";
    ctx.fillText(`🌀 ${skill.name}`, width / 2, 300);
    ctx.font = "12px monospace";
    ctx.fillStyle = "#aaa";
    ctx.fillText(`피해 ${skill.dmg}  ·  숙련도 ${player.mastery?.[player.active] || 0}`, width / 2, 325);
    
    // 크리스탈 & XP
    ctx.font = "18px monospace";
    ctx.fillStyle = "#F5C842";
    ctx.fillText(`💎 ${player.crystals}`, width / 2 - 80, 380);
    ctx.fillStyle = "#4ade80";
    const getLevel = (xp) => Math.floor(xp / 200) + 1;
    ctx.fillText(`⭐ LV.${getLevel(player.xp)}`, width / 2 + 40, 380);
    
    // XP 바
    const xpNow = player.xp % 200;
    const xpPercent = xpNow / 200;
    ctx.fillStyle = "#2a2a3e";
    ctx.fillRect(hpBarX, 400, hpBarWidth, 12);
    ctx.fillStyle = "#F5C842";
    ctx.fillRect(hpBarX, 400, hpBarWidth * xpPercent, 12);
    ctx.font = "10px monospace";
    ctx.fillStyle = "#aaa";
    ctx.fillText(`XP ${xpNow}/200`, width / 2, 412);
    
    // 상태이상
    if (player.statusEffects && player.statusEffects.length > 0) {
      ctx.font = "14px monospace";
      ctx.fillStyle = "#ff6b6b";
      let statusText = player.statusEffects.map(s => {
        const STATUS_EFFECTS = {
          poison: { emoji: "☠️", name: "독" }, burn: { emoji: "🔥", name: "화상" },
          freeze: { emoji: "❄️", name: "빙결" }, weaken: { emoji: "💔", name: "약화" },
          stun: { emoji: "⚡", name: "기절" }, battleInstinct: { emoji: "🔥💪", name: "전투본능" }
        };
        const def = STATUS_EFFECTS[s.id];
        return def ? `${def.emoji} ${def.name}(${s.turns})` : s.id;
      }).join("  ");
      ctx.fillText(statusText, width / 2, 450);
    }
    
    // 하단 로고
    ctx.font = "italic 14px 'Noto Sans KR'";
    ctx.fillStyle = "rgba(245, 200, 66, 0.5)";
    ctx.fillText("🔱 JUJUTSU KAISEN · 呪術廻戦 🔱", width / 2, height - 25);
    
    // 반짝임 효과
    if (frame % 4 === 0) {
      ctx.fillStyle = `rgba(255, 200, 0, ${Math.random() * 0.1})`;
      ctx.fillRect(0, 0, width, height);
    }
    
    encoder.addFrame(ctx);
  }
  
  encoder.finish();
  await new Promise(resolve => stream.on("finish", resolve));
  const buffer = readFileSync(tempPath);
  unlinkSync(tempPath);
  return new AttachmentBuilder(buffer, { name: `jjk_profile_${player.id || Date.now()}.gif` });
}

// ==================== 프로필 명령어 (기존 profileEmbed 대체) ====================
// 슬래시 커맨드용
async function handleProfileSlash(interaction, player, CHARACTERS, getPlayerStats) {
  await interaction.deferReply();
  const stats = getPlayerStats(player);
  const ch = CHARACTERS[player.active];
  const avatarUrl = interaction.user.displayAvatarURL({ extension: "png", size: 256 });
  
  try {
    const gifBuffer = await createJJKGifProfileCard(player, stats, ch, avatarUrl);
    await interaction.editReply({ 
      content: `🔱 **${player.name}**님의 주술사 프로필`, 
      files: [gifBuffer] 
    });
  } catch (err) {
    console.error("GIF 생성 실패:", err);
    await interaction.editReply("❌ 프로필 카드 생성에 실패했습니다.");
  }
}

// 메시지 명령어용 (!프로필)
async function handleProfileMessage(message, player, CHARACTERS, getPlayerStats) {
  await message.channel.sendTyping();
  const stats = getPlayerStats(player);
  const ch = CHARACTERS[player.active];
  const avatarUrl = message.author.displayAvatarURL({ extension: "png", size: 256 });
  
  try {
    const gifBuffer = await createJJKGifProfileCard(player, stats, ch, avatarUrl);
    await message.reply({ 
      content: `🔱 **${player.name}**님의 주술사 프로필`, 
      files: [gifBuffer] 
    });
  } catch (err) {
    console.error("GIF 생성 실패:", err);
    await message.reply("❌ 프로필 카드 생성에 실패했습니다.");
  }
}

// ==================== 내보내기 ====================
module.exports = { createJJKGifProfileCard, handleProfileSlash, handleProfileMessage };
