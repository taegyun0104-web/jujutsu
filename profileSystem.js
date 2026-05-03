const handleProfile = require("./profileSystem");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const fs = require("fs");

const DATA_FILE = "./users.json";

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "{}");
}

function getData() {
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const characters = {
  gojo: {
    name: "고죠 사토루",
    desc: "현대 최강의 주술사",
    quote: "내가 최강이다",
    color: "#7c3aed",
    image: "https://i.imgur.com/7yUvePI.png",
    skills: [
      { name: "무하한", desc: "모든 공격 무효화" },
      { name: "창", desc: "인력 공격" },
      { name: "혁", desc: "반발력 폭발" },
      { name: "무량공처", desc: "영역전개" }
    ]
  },

  sukuna: {
    name: "료멘 스쿠나",
    desc: "저주의 왕",
    quote: "약자는 죽어라",
    color: "#dc2626",
    image: "https://i.imgur.com/YQ9Z1Zm.png",
    skills: [
      { name: "해", desc: "공간 참격" },
      { name: "팔", desc: "분해 공격" },
      { name: "화염", desc: "저주 화염" },
      { name: "복마어주자", desc: "영역 학살" }
    ]
  }
};

async function drawProfile(character) {
  const canvas = createCanvas(1000, 550);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 1000, 550);
  bg.addColorStop(0, "#020617");
  bg.addColorStop(1, "#0f172a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1000, 550);

  ctx.shadowColor = character.color;
  ctx.shadowBlur = 40;
  ctx.fillStyle = character.color;
  ctx.fillRect(0, 0, 10, 550);
  ctx.shadowBlur = 0;

  const img = await loadImage(character.image);

  ctx.save();
  ctx.beginPath();
  ctx.arc(180, 275, 130, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, 50, 145, 260, 260);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(180, 275, 135, 0, Math.PI * 2);
  ctx.strokeStyle = character.color;
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText(character.name, 350, 90);

  ctx.fillStyle = "#aaa";
  ctx.font = "20px sans-serif";
  ctx.fillText(character.desc, 350, 130);

  let y = 190;
  character.skills.forEach((s) => {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(350, y - 25, 580, 65);

    ctx.strokeStyle = character.color;
    ctx.strokeRect(350, y - 25, 580, 65);

    ctx.fillStyle = character.color;
    ctx.font = "bold 22px sans-serif";
    ctx.fillText(`◆ ${s.name}`, 370, y);

    ctx.fillStyle = "#ddd";
    ctx.font = "18px sans-serif";
    ctx.fillText(s.desc, 370, y + 25);

    y += 85;
  });

  ctx.shadowColor = character.color;
  ctx.shadowBlur = 20;
  ctx.fillStyle = "#fff";
  ctx.font = "italic 20px sans-serif";
  ctx.fillText(`"${character.quote}"`, 350, 500);
  ctx.shadowBlur = 0;

  return canvas.toBuffer("image/png");
}

// 🔥 이 함수만 밖에서 호출됨
module.exports = async function handleProfile(message) {
  const data = getData();
  const userId = message.author.id;

  if (!data[userId]) {
    data[userId] = { equipped: "gojo" };
    saveData(data);
  }

  if (message.content === "!프로필") {
    const charKey = data[userId].equipped;
    const buffer = await drawProfile(characters[charKey]);

    return message.reply({
      files: [{ attachment: buffer, name: "profile.png" }]
    });
  }

  if (message.content.startsWith("!장착 ")) {
    const char = message.content.split(" ")[1];

    if (!characters[char]) {
      return message.reply("없는 캐릭터임");
    }

    data[userId].equipped = char;
    saveData(data);

    return message.reply(`${characters[char].name} 장착 완료`);
  }
};
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  handleProfile(message);
});
