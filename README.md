<p align="center">
  <img src="static/logo.svg" width="96" alt="HME Manager logo">
</p>

<h1 align="center">HME Manager</h1>

<p align="center">零相依、自架的 iCloud「隱藏我的電子郵件」管理後台與 HTTP API。</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue.svg" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/deploy-Docker-2496ED.svg" alt="Docker">
</p>

## 功能

- 管理「隱藏我的電子郵件」信箱：建立、列出、停用、啟用、刪除與 CSV 匯出。
- 固定格式的 HTTP API；所有 `/v1/*` 皆以 `X-API-Key` 驗證。
- Session 只透過 iCloud 網頁請求的 **Copy as cURL (bash)** 或 HAR 匯入，不接收 Apple ID、密碼或 2FA。
- **自動刷新**預設啟用，每 10 分鐘使用現有 Session 保活；失效時自動停用。
- 響應式工作台：**信箱清單**、**API Builder**、**Session & 自動刷新**，支援亮／暗主題與手機版。
- 純 Python 標準庫、**零第三方相依**；支援本機、Docker 與 Render。

## 快速開始

### 1. 取得專案

```bash
git clone https://github.com/banana2556/hme-manager.git
cd hme-manager
```

### 2. 環境變數

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `HME_API_KEY` | ✅ | API 與後台共用的金鑰；未設定時拒絕所有請求 |
| `ICLOUD_HME_CONFIG` | | 匯入後的 Session 設定路徑；預設 `hme-config.json`，Docker 為 `/data/hme-config.json` |
| `HME_STATE_DIR` | | Session 檢查與自動刷新狀態目錄；預設 `state`，Docker 為 `/data/state` |

macOS / Linux：

```bash
export HME_API_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

Windows PowerShell：

```powershell
$env:HME_API_KEY = (python -c "import secrets; print(secrets.token_urlsafe(32))")
```

### 3. 啟動服務

#### 本地（Python 3.10+）

```bash
python web_app.py
```

開啟 <http://127.0.0.1:8000>，輸入剛才的 `HME_API_KEY`。

#### Docker

```bash
cp .env.example .env         # 將 HME_API_KEY 改成隨機金鑰
docker compose up -d --build
```

#### Render（一鍵）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/banana2556/hme-manager)

### 4. 匯入 Session

1. 前往 [iCloud+](https://www.icloud.com/icloudplus/)，開啟 **Hide My Email（隱藏我的電子郵件）**。
2. 按 **F12** 開啟 DevTools → Network，找到包含 `list?clientBuildNumber` 的請求。
3. 對該請求選擇 **Copy as cURL (bash)**；也可匯出包含 request cookies 的 HAR。
4. 到後台的 **Session & 自動刷新** → **手動匯入 Session** 貼上並送出。

## API

所有 `/v1/*` 需帶 `X-API-Key: <你的金鑰>`；`/health` 免驗證。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/health` | 健康檢查 |
| GET | `/v1/session/status` | 目前 Session 狀態 |
| POST | `/v1/session/refresh` | 用現有 Session 做一次低風險檢查 |
| POST | `/v1/session/import` | 匯入 Session（body：`{"curl_text": "..."}`） |
| GET | `/v1/aliases` | 列出信箱 |
| POST | `/v1/aliases` | 建立信箱（body：`{"label": "...", "note": "..."}`） |
| POST | `/v1/aliases/{id}/disable` · `/enable` · `/delete` | 停用 / 啟用 / 刪除 |
| GET | `/v1/aliases/export.csv` | 匯出 CSV |
| GET · POST | `/v1/auto-refresh` | 讀取或更新自動刷新設定 |
| POST | `/v1/auto-refresh/run` | 立即執行一次刷新 |

回應一律是固定信封：

```json
{ "ok": true, "data": {}, "error": null, "meta": { "service": "hme-manager", "version": "1", "requestId": null } }
```

範例：

```bash
curl -X POST "http://127.0.0.1:8000/v1/aliases" \
  -H "X-API-Key: $HME_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"label":"GPT","note":"memo"}'
```

## 測試

```bash
python -m unittest discover -s tests -v
```

## 授權

[MIT](LICENSE) © [banana2556](https://github.com/banana2556) · [專案首頁](https://github.com/banana2556/hme-manager)
