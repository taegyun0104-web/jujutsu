# ⚡ 주술회전 RPG 디스코드 봇

## 📋 기능
- `!도움` — 전체 명령어 목록
- `!프로필` — 내 캐릭터/레벨/크리스탈 확인
- `!도감` — 전체 캐릭터 목록 (획득/미획득)
- `!캐릭터` — 보유 캐릭터 목록 & 드롭다운으로 파티 변경
- `!가챠` — 1회 소환 (150 💎)
- `!가챠10` — 10회 소환 (1350 💎)
- `!전투` — 저주령과 전투 시작 (버튼으로 적 선택)
- `!공격` / `!술식` / `!회복` — 전투 중 행동

---

## 🛠️ 설치 방법

### 1단계 — Node.js 설치
https://nodejs.org 에서 LTS 버전 다운로드 후 설치

### 2단계 — 디스코드 봇 토큰 발급
1. https://discord.com/developers/applications 접속
2. **New Application** → 이름 입력 → Create
3. 왼쪽 메뉴 **Bot** 클릭
4. **Reset Token** → 토큰 복사
5. **MESSAGE CONTENT INTENT** 활성화 (필수!)
6. 왼쪽 **OAuth2 → URL Generator** → `bot` 체크 → 권한: `Send Messages`, `Read Message History`, `Use Slash Commands` → 생성된 URL로 봇을 서버에 초대

### 3단계 — 봇 실행

```bash
# 이 폴더로 이동
cd jjk-bot

# 패키지 설치
npm install

# 토큰 설정 후 실행 (방법 A: 환경변수)
DISCORD_TOKEN=여기에토큰붙여넣기 npm start

# 방법 B: index.js 맨 아래 줄 직접 수정
# const TOKEN = 'YOUR_TOKEN_HERE';  ← 여기에 토큰 입력
```

---

## 💾 데이터 영속성 (선택)

현재는 봇 재시작 시 데이터가 초기화됩니다.
영구 저장을 원하면 `better-sqlite3` 또는 `lowdb` 추가를 권장합니다.

```bash
npm install better-sqlite3
```

---

## 🚀 Railway로 24시간 운영

1. https://railway.app 가입
2. **New Project → Deploy from GitHub** (이 폴더를 GitHub에 올린 뒤)
3. 환경변수 `DISCORD_TOKEN` 설정
4. 자동 배포!

---

## 🎮 캐릭터 등급
| 등급 | 소환 확률 | 캐릭터 |
|------|---------|--------|
| S ⭐⭐⭐ | 6% | 고조, 이타도리, 스쿠나, 게토 |
| A ⭐⭐ | 34% | 메구미, 노바라, 나나미, 마키 |
| B ⭐ | 60% | 판다, 이누마키 |
