"use strict";

const API_KEY_PLACEHOLDER = "<API_KEY>";
const STORAGE_KEY = "hme-api-key";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const viewTitleEl = $("viewTitle");
const responsePreviewEl = $("responsePreview");
const actualOutputEl = $("actualOutput");
const requestPreviewEl = $("requestPreview");
const curlOutputEl = $("curlOutput");
const methodBadge = $("methodBadge");
const endpointList = $("endpointList");
const tableEl = $("table");
const aliasSourceEl = $("aliasSource");
const aliasFilterInput = $("aliasFilterInput");
const aliasTabs = $("aliasTabs");
const aliasCountSub = $("aliasCountSub");
const createAliasForm = $("createAliasForm");
const sessionIndicatorEl = $("sessionIndicator");
const sessionMiniStatusEl = $("sessionMiniStatus");
const sessionMiniEl = $("sessionMini");
const sessionDotEl = $("sessionDot");
const autoRefreshMiniEl = $("autoRefreshMini");
const sessionMailEl = $("sessionMail");
const sessionRequiredEl = $("sessionRequired");
const sessionDsidEl = $("sessionDsid");
const sessionHostEl = $("sessionHost");
const sessionSavedAtEl = $("sessionSavedAt");
const sessionSyncedAtEl = $("sessionSyncedAt");
const sessionStateEl = $("sessionState");
const autoRefreshEnabledEl = $("autoRefreshEnabled");
const autoRefreshIntervalEl = $("autoRefreshInterval");
const autoRefreshStatusEl = $("autoRefreshStatus");
const icloudPortalLinkEl = $("icloudPortalLink");
const icloudRegionHintEl = $("icloudRegionHint");

const VIEW_TITLES = { aliases: "信箱清單", builder: "API Builder", session: "Session & 自動刷新" };
const ICLOUD_REGIONS = {
  international: {
    portalUrl: "https://www.icloud.com/icloudplus/",
    hint: "使用 icloud.com 服務域名。"
  },
  china: {
    portalUrl: "https://www.icloud.com.cn/icloudplus/",
    hint: "使用 icloud.com.cn 服務域名。匯入時會自動在 iCloud 域名後加上 .cn。"
  }
};

let aliasRows = [];
let lastSessionStatus = null;
let lastAliasSyncAt = null;
let lastSessionRefreshAt = null;
let lastAutoRefresh = null;
let autoRefreshCountdownTimer = null;
let currentOperation = "list";
let currentView = "aliases";

const operations = {
  status: { method: "GET", path: "/v1/session/status", body: null },
  refresh: { method: "POST", path: "/v1/session/refresh", body: null },
  list: { method: "GET", path: "/v1/aliases", body: null },
  create: { method: "POST", path: "/v1/aliases", body: { label: "GPT", note: "" } },
  disable: { method: "POST", path: "/v1/aliases/{anonymousId}/disable", body: null },
  enable: { method: "POST", path: "/v1/aliases/{anonymousId}/enable", body: null },
  delete: { method: "POST", path: "/v1/aliases/{anonymousId}/delete", body: null }
};

const META = { service: "hme-manager", version: "1", requestId: null };
const responseExamples = {
  status: { ok: true, data: { metadataDetected: true, persistedSession: true, sessionValid: true, needsReauth: false, lastRefreshAt: 1778246060, lastValidAt: 1778246060, lastSavedAt: 1778246000, expiresHint: "apple-controlled", lastError: null, metadata: { dsid: "608658063", host: "p119-maildomainws.icloud.com" }, hme: { selectedForwardTo: "user@example.com", aliasCount: 1 } }, error: null, meta: META },
  refresh: { ok: true, data: { metadataDetected: true, persistedSession: true, sessionValid: true, needsReauth: false, lastRefreshAt: 1778246060, lastValidAt: 1778246060, lastSavedAt: 1778246000, expiresHint: "apple-controlled", lastError: null, metadata: { dsid: "608658063", host: "p119-maildomainws.icloud.com" }, hme: { selectedForwardTo: "user@example.com", aliasCount: 1 } }, error: null, meta: META },
  list: { ok: true, data: [{ origin: "ON_DEMAND", anonymousId: "example123", domain: "", forwardToEmail: "user@example.com", hme: "example.alias@icloud.com", label: "GPT", note: "", createTimestamp: 1778246060430, isActive: true, recipientMailId: "" }], error: null, meta: META },
  create: { ok: true, data: { origin: "ON_DEMAND", anonymousId: "newalias123", domain: "", hme: "new.alias@icloud.com", label: "GPT", note: "", createTimestamp: 1778246060430, isActive: true, recipientMailId: "" }, error: null, meta: META },
  disable: { ok: true, data: { anonymousId: "example123", isActive: false }, error: null, meta: META },
  enable: { ok: true, data: { anonymousId: "example123", isActive: true }, error: null, meta: META },
  delete: { ok: true, data: { anonymousId: "example123", deleted: true }, error: null, meta: META }
};

// ---------- API key ----------
function getStoredApiKey() { return localStorage.getItem(STORAGE_KEY) || ""; }
function setStoredApiKey(key) { localStorage.setItem(STORAGE_KEY, key); }
function readApiKey() { return getStoredApiKey(); }

function apiHeaders() {
  const key = readApiKey();
  if (!key) { showModal(); throw new Error("MISSING_API_KEY"); }
  return { "Content-Type": "application/json", "X-API-Key": key };
}

// ---------- status / output ----------
function setStatus(text) {
  statusEl.textContent = text;
}
function show(data, isError = false) {
  setStatus(isError ? "發生錯誤" : "完成", isError);
  showActualOutput(data);
}
function showActualOutput(data) {
  actualOutputEl.textContent = JSON.stringify(data, null, 2);
  responsePreviewEl.hidden = true;
  actualOutputEl.hidden = false;
}
function showResponseExample() {
  responsePreviewEl.hidden = false;
  actualOutputEl.hidden = true;
}

async function request(path, options = {}) {
  try {
    const response = await fetch(path, options);
    if (response.status === 401) { showModal(); return null; }
    const data = await response.json();
    if (!response.ok || data.ok === false) { show(data, true); return null; }
    show(data);
    return data;
  } catch (error) {
    show({ ok: false, error: String(error) }, true);
    return null;
  }
}

// ---------- view switching ----------
function showView(name) {
  currentView = VIEW_TITLES[name] ? name : "aliases";
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== `view-${currentView}`;
  });
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === currentView);
  });
  viewTitleEl.textContent = VIEW_TITLES[currentView];
  window.location.hash = currentView;
  if (currentView === "aliases") { renderAliases(); refreshAliasTable(); }
  if (currentView === "session") { loadStatus(); loadAutoRefresh(); }
}

// ---------- session info ----------
function formatSessionTime(value) {
  if (!value) return "未知";
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
}
function yesNo(value) { return value ? "是" : "否"; }

function inferForwardTo(status) {
  if (status && status.hme && status.hme.selectedForwardTo) return status.hme.selectedForwardTo;
  const firstAlias = aliasRows.find((alias) => alias.forwardToEmail);
  return firstAlias ? firstAlias.forwardToEmail : "未知";
}

function renderSessionInfo(status = lastSessionStatus) {
  lastSessionStatus = status || lastSessionStatus || {};
  const s = lastSessionStatus;
  const metadata = s.metadata || {};
  const hme = s.hme || {};
  const hasMetadata = Boolean(s.metadataDetected || metadata.dsid);
  const hasSession = Boolean(s.persistedSession || s.sessionValid);
  const hasApiKey = Boolean(readApiKey());
  const requiredOk = hasMetadata && hasSession && hasApiKey;
  const aliasCount = aliasRows.length || hme.aliasCount || 0;
  if (sessionMailEl) {
    sessionMailEl.textContent = inferForwardTo(s);
    sessionRequiredEl.textContent = `metadata ${yesNo(hasMetadata)} / session ${yesNo(hasSession)} / API key ${yesNo(hasApiKey)}`;
    sessionDsidEl.textContent = metadata.dsid || "未知";
    sessionHostEl.textContent = metadata.host || "未知";
    sessionSavedAtEl.textContent = formatSessionTime(s.lastSavedAt || s.configUpdatedAt);
    sessionSyncedAtEl.textContent = lastAliasSyncAt ? `${formatSessionTime(lastAliasSyncAt)} / ${aliasCount} 筆` : `尚未同步 / ${aliasCount} 筆`;
  }
  let stateText;
  let stateKind;
  if (s.needsReauth) {
    stateText = `需要重新匯入 Session${s.lastError ? "：" + s.lastError : ""}`;
    stateKind = "bad";
  } else if (s.sessionValid) {
    const checkedAt = s.lastValidAt || s.lastRefreshAt || lastSessionRefreshAt;
    stateText = checkedAt ? `可用，最近刷新 ${formatSessionTime(checkedAt)}` : "可用";
    stateKind = "ok";
  } else if (requiredOk) {
    stateText = `已保存，尚未確認可用${s.lastRefreshAt ? "，最近檢查 " + formatSessionTime(s.lastRefreshAt) : ""}`;
    stateKind = "warn";
  } else {
    stateText = "可能過期或資料不足，請按刷新 Session";
    stateKind = "warn";
  }
  if (sessionStateEl) sessionStateEl.textContent = stateText;
  const sessionMiniText = `Session ${stateKind === "ok" ? "可用" : stateKind === "bad" ? "需重新匯入" : "尚未確認"}`;
  sessionMiniEl.textContent = sessionMiniText;
  sessionMiniStatusEl.setAttribute("aria-label", sessionMiniText);
  sessionMiniStatusEl.title = sessionMiniText;
  sessionDotEl.className = `dot ${stateKind}`;
  sessionIndicatorEl.className = `session-indicator ${stateKind}`;
}

// ---------- auto refresh ----------
function secondsUntilNextRefresh(config = lastAutoRefresh) {
  if (!config || !config.enabled) return null;
  const interval = Number(config.intervalSeconds || 600);
  if (config.nextRunAt) return Math.max(0, Math.ceil(Number(config.nextRunAt) - Date.now() / 1000));
  if (config.remainingSeconds !== null && config.remainingSeconds !== undefined) {
    const baseNow = Number(config.serverNow || Date.now() / 1000);
    return Math.max(0, Math.ceil(baseNow + Number(config.remainingSeconds || 0) - Date.now() / 1000));
  }
  const lastRun = Number(config.lastRunAt || config.lastSuccessAt || 0);
  return lastRun ? Math.max(0, Math.ceil(lastRun + interval - Date.now() / 1000)) : interval;
}
function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return "關閉";
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${s} 秒後`;
  if (s < 3600) return `${Math.round(s / 60)} 分後`;
  return `${Math.round(s / 3600)} 小時後`;
}
function updateAutoRefreshButton() {
  if (!lastAutoRefresh || !lastAutoRefresh.enabled) {
    setAutoRefreshMini("自動刷新 關閉", lastAutoRefresh && (lastAutoRefresh.disabledReason || lastAutoRefresh.lastError) ? "bad" : "warn");
    return;
  }
  const seconds = secondsUntilNextRefresh(lastAutoRefresh);
  setAutoRefreshMini(seconds <= 0 ? "自動刷新 執行中" : `自動刷新 ${formatCountdown(seconds)}`, seconds <= 0 ? "warn" : "ok");
  if (seconds <= 0 && !lastAutoRefresh._reloading) {
    lastAutoRefresh._reloading = true;
    window.setTimeout(async () => { await loadAutoRefresh(); if (lastAutoRefresh) lastAutoRefresh._reloading = false; }, 30000);
  }
}
function setAutoRefreshMini(text, stateKind) {
  autoRefreshMiniEl.textContent = text;
  autoRefreshMiniEl.setAttribute("aria-label", text);
  autoRefreshMiniEl.title = text;
  autoRefreshMiniEl.classList.remove("ok", "warn", "bad");
  autoRefreshMiniEl.classList.add(stateKind);
}
function startAutoRefreshCountdown() {
  if (autoRefreshCountdownTimer !== null) window.clearInterval(autoRefreshCountdownTimer);
  autoRefreshCountdownTimer = window.setInterval(updateAutoRefreshButton, 1000);
  updateAutoRefreshButton();
}
function renderAutoRefresh(config = lastAutoRefresh) {
  lastAutoRefresh = config || lastAutoRefresh || {};
  const c = lastAutoRefresh;
  if (autoRefreshEnabledEl) {
    autoRefreshEnabledEl.checked = Boolean(c.enabled);
    autoRefreshIntervalEl.value = c.intervalSeconds || 600;
    const parts = [c.enabled ? `已啟用，${formatCountdown(secondsUntilNextRefresh(c))}` : "已關閉"];
    if (c.workerRunning !== undefined) parts.push(`worker ${c.workerRunning ? "運行中" : "未運行"}`);
    if (c.lastSuccessAt) parts.push(`最近成功 ${formatSessionTime(c.lastSuccessAt)}`);
    if (c.disabledReason) parts.push(`關閉原因：${c.disabledReason}`);
    else if (c.lastError) parts.push(`錯誤：${c.lastError}`);
    autoRefreshStatusEl.textContent = parts.join(" · ");
  }
  startAutoRefreshCountdown();
}
async function loadAutoRefresh() {
  try {
    const response = await fetch("/v1/auto-refresh", { headers: apiHeaders() });
    const data = await response.json();
    if (response.ok && data.ok && data.data) renderAutoRefresh(data.data);
    return data;
  } catch (error) {
    if (autoRefreshStatusEl) autoRefreshStatusEl.textContent = `載入失敗：${String(error)}`;
    return null;
  }
}
async function saveAutoRefreshSettings() {
  const payload = { enabled: autoRefreshEnabledEl.checked, intervalSeconds: Number(autoRefreshIntervalEl.value || 600) };
  const data = await request("/v1/auto-refresh", { method: "POST", headers: apiHeaders(), body: JSON.stringify(payload) });
  if (data && data.data) { renderAutoRefresh(data.data); setStatus("自動刷新設定已保存"); }
  return data;
}
async function runAutoRefreshNow() {
  const data = await request("/v1/auto-refresh/run", { method: "POST", headers: apiHeaders(), body: "{}" });
  if (data && data.data && data.data.autoRefresh) {
    renderAutoRefresh(data.data.autoRefresh);
    if (data.data.session) { renderSessionInfo(data.data.session); }
    if (data.data.session && data.data.session.sessionValid) { await refreshAliasTable(); setStatus("手動刷新成功，清單已同步"); }
  }
  return data;
}

// ---------- API Builder ----------
function setSelectedOperation(operationName) {
  currentOperation = operations[operationName] ? operationName : "list";
  endpointList.querySelectorAll("[data-endpoint]").forEach((button) => {
    const isActive = button.dataset.endpoint === currentOperation;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  syncRequestPreview();
  showResponseExample();
}
function requestTemplate(operationName = currentOperation) {
  const operation = operations[operationName] || operations.list;
  return {
    method: operation.method,
    path: operation.path,
    headers: { "X-API-Key": readApiKey() || API_KEY_PLACEHOLDER, ...(operation.body ? { "Content-Type": "application/json" } : {}) },
    body: operation.body
  };
}
function syncRequestPreview() {
  const requestData = requestTemplate();
  methodBadge.textContent = requestData.method;
  requestPreviewEl.value = JSON.stringify(requestData, null, 2);
  responsePreviewEl.textContent = JSON.stringify(responseExamples[currentOperation] || responseExamples.list, null, 2);
  syncCurlFromRequestEditor();
}
function showCurl(method, path, body, headers = {}) {
  const key = headers["X-API-Key"] || headers["x-api-key"] || readApiKey() || API_KEY_PLACEHOLDER;
  const bodyPart = body ? ` \\\n  -H "Content-Type: application/json" \\\n  --data '${JSON.stringify(body)}'` : "";
  curlOutputEl.textContent = `curl -X ${method} "http://127.0.0.1:8000${path}" \\\n  -H "X-API-Key: ${key}"${bodyPart}`;
}
function readRequestJson(validate = false) {
  try {
    const data = JSON.parse(requestPreviewEl.value || "{}");
    if (validate && (!data.method || !data.path)) throw new Error("method and path are required");
    if (validate && String(data.path).includes("{anonymousId}")) {
      show({ ok: false, data: null, error: { code: "MISSING_ANONYMOUS_ID", message: "請先把 path 的 {anonymousId} 換成真實 anonymousId。" }, meta: META }, true);
      throw new Error("MISSING_ANONYMOUS_ID");
    }
    return data;
  } catch (error) {
    if (validate && String(error.message || error) === "MISSING_ANONYMOUS_ID") throw error;
    if (validate) {
      show({ ok: false, data: null, error: { code: "INVALID_REQUEST_JSON", message: `API Request JSON 格式錯誤：${String(error.message || error)}` }, meta: META }, true);
      throw error;
    }
    return null;
  }
}
function syncCurlFromRequestEditor() {
  const requestData = readRequestJson(false);
  if (!requestData) { curlOutputEl.textContent = "API Request JSON 格式錯誤，修正後會自動同步 curl。"; return; }
  methodBadge.textContent = requestData.method || "GET";
  showCurl(requestData.method || "GET", requestData.path || "/v1/aliases", requestData.body, requestData.headers || {});
}
async function runSelectedOperation(operationName = null) {
  if (operationName) setSelectedOperation(operationName);
  else syncCurlFromRequestEditor();
  const requestData = readRequestJson(true);
  const activeOperation = operationName || currentOperation;
  const path = String(requestData.path || "");
  if (path.includes("/delete") && !window.confirm(`確定要刪除 ${path} 指定的隱私信箱？此操作不可復原。`)) return null;
  const headers = { ...(requestData.headers || {}) };
  if (!headers["X-API-Key"] && !headers["x-api-key"]) headers["X-API-Key"] = readApiKey();
  if (requestData.body != null && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
  const data = await request(requestData.path, {
    method: requestData.method,
    headers,
    body: requestData.body != null ? JSON.stringify(requestData.body) : undefined
  });
  if (data && data.data && activeOperation === "list") { setAliasRows(data.data); }
  if (data && data.data && activeOperation === "refresh") {
    lastSessionRefreshAt = data.data.lastRefreshAt || new Date();
    renderSessionInfo(data.data);
    if (data.data.needsReauth) { setStatus("Session 需要重新匯入", true); return data; }
    if (data.data.sessionValid) { await refreshAliasTable(); setStatus("Session 已刷新，清單已同步"); }
  }
  if (data && data.data && ["create", "disable", "enable", "delete"].includes(activeOperation)) await refreshAliasTable();
  return data;
}

// ---------- aliases ----------
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function filterAliases(aliases) {
  const keyword = (aliasFilterInput.value || "").trim().toLowerCase();
  if (!keyword) return aliases;
  return aliases.filter((alias) => [alias.hme, alias.anonymousId, alias.label, alias.note, alias.forwardToEmail, alias.isActive ? "active" : "inactive"]
    .some((value) => String(value || "").toLowerCase().includes(keyword)));
}
function setAliasRows(rows) {
  aliasRows = Array.isArray(rows) ? rows : [];
  lastAliasSyncAt = new Date();
  renderAliases();
  renderSessionInfo();
}
function renderAliases() {
  aliasSourceEl.textContent = JSON.stringify(aliasRows || [], null, 2);
  if (aliasCountSub) aliasCountSub.textContent = `${aliasRows.length} 筆`;
  const filtered = filterAliases(aliasRows);
  if (!filtered.length) {
    const hint = aliasRows.length
      ? "沒有符合搜尋的信箱。"
      : '目前沒有信箱資料。請至「Session &amp; 自動刷新」匯入或刷新 Session，再按「重新整理」。';
    tableEl.innerHTML = `<div class="empty-state">${hint}</div>`;
    return;
  }
  const rows = filtered.map((alias, index) => {
    const active = alias.isActive;
    const toggleAction = active ? "disable" : "enable";
    const toggleLabel = active ? "停用" : "啟用";
    return `<tr>
      <td class="mono">${escapeHtml(alias.hme || "")}</td>
      <td>${escapeHtml(alias.label || "")}</td>
      <td>${escapeHtml(alias.note || "")}</td>
      <td class="mono">${escapeHtml(alias.forwardToEmail || "")}</td>
      <td><span class="badge ${active ? "on" : "off"}">${active ? "active" : "inactive"}</span></td>
      <td class="row-actions">
        <button type="button" data-action="toggle-alias" data-index="${index}" data-alias-action="${toggleAction}">${toggleLabel}</button>
        <button type="button" class="danger" data-action="delete-alias" data-index="${index}">刪除</button>
      </td></tr>`;
  }).join("");
  tableEl.innerHTML = `<table>
      <thead><tr><th>hme</th><th>label</th><th>note</th><th>forwardTo</th><th>status</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}
async function refreshAliasTable() {
  try {
    const response = await fetch("/v1/aliases", { headers: apiHeaders() });
    if (response.status === 401) { showModal(); return null; }
    const data = await response.json();
    if (response.ok && data.ok !== false && data.data) setAliasRows(data.data);
    return data;
  } catch (error) {
    setStatus("清單刷新失敗", true);
    return null;
  }
}
async function runAliasAction(alias, action) {
  showActualOutput({ running: true, action, anonymousId: alias.anonymousId });
  const data = await request(`/v1/aliases/${encodeURIComponent(alias.anonymousId || "")}/${action}`, {
    method: "POST",
    headers: apiHeaders()
  });
  await refreshAliasTable();
  return data;
}
async function submitCreateAlias(event) {
  event.preventDefault();
  const label = ($("createLabel").value || "").trim();
  if (!label) { setStatus("label 為必填", true); return; }
  const note = $("createNote").value || "";
  const data = await request("/v1/aliases", { method: "POST", headers: apiHeaders(), body: JSON.stringify({ label, note }) });
  if (data && data.data) {
    $("createLabel").value = "";
    $("createNote").value = "";
    createAliasForm.hidden = true;
    setStatus(`已建立 ${data.data.hme || label}`);
    await refreshAliasTable();
  }
}

// ---------- session actions ----------
async function loadStatus() {
  try {
    const response = await fetch("/v1/session/status", { headers: apiHeaders() });
    if (response.status === 401) { showModal(); return; }
    const data = await response.json();
    if (data && data.data) renderSessionInfo(data.data);
  } catch (error) { /* keep prior status */ }
}

function selectedICloudRegion() {
  const selected = document.querySelector('input[name="icloudRegion"]:checked');
  return selected && ICLOUD_REGIONS[selected.value] ? selected.value : "international";
}

function updateICloudRegionUi() {
  const region = ICLOUD_REGIONS[selectedICloudRegion()];
  icloudPortalLinkEl.href = region.portalUrl;
  icloudRegionHintEl.textContent = region.hint;
}

async function submitImportSession() {
  const curlText = ($("importCurl").value || "").trim();
  const icloudRegion = selectedICloudRegion();
  const resultEl = $("importResult");
  resultEl.hidden = false;
  if (!curlText) { resultEl.textContent = "請先貼上 list?clientBuildNumber 請求的 Copy as cURL (bash) 或 HAR JSON。"; return; }
  resultEl.textContent = "匯入中…";
  const data = await request("/v1/session/import", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ curl_text: curlText, icloud_region: icloudRegion })
  });
  if (!data) { resultEl.textContent = "匯入失敗，請確認貼上的內容包含 cookie。"; return; }
  resultEl.textContent = JSON.stringify(data.data, null, 2);
  $("importCurl").value = "";
  setStatus("Session 已匯入，正在刷新與同步…");
  await runSelectedOperation("refresh");
  await loadStatus();
  await refreshAliasTable();
}

// ---------- API Key modal ----------
const apiKeyModal = $("apiKeyModal");
const modalApiKeyInput = $("modalApiKeyInput");
const modalError = $("modalError");
function showModal() {
  apiKeyModal.classList.remove("hidden");
  modalError.style.display = "none";
  modalApiKeyInput.value = "";
  modalApiKeyInput.focus();
}
function hideModal() { apiKeyModal.classList.add("hidden"); }
async function verifyApiKey(key) {
  try {
    const res = await fetch("/v1/session/status", { headers: { "X-API-Key": key } });
    return res.status !== 401;
  } catch { return false; }
}
async function handleModalSubmit() {
  const key = modalApiKeyInput.value.trim();
  if (!key) { modalError.style.display = "block"; modalError.textContent = "請輸入 API Key"; return; }
  if (await verifyApiKey(key)) { setStoredApiKey(key); hideModal(); init(); }
  else { modalError.style.display = "block"; modalError.textContent = "API Key 無效"; }
}

// ---------- wiring ----------
document.querySelectorAll("[data-view]").forEach((el) => el.addEventListener("click", () => showView(el.dataset.view)));
$("logoutBtn").addEventListener("click", () => { localStorage.removeItem(STORAGE_KEY); showModal(); });

aliasFilterInput.addEventListener("input", renderAliases);
$("refreshListBtn").addEventListener("click", refreshAliasTable);
$("createAliasBtn").addEventListener("click", () => {
  createAliasForm.hidden = !createAliasForm.hidden;
  if (!createAliasForm.hidden) $("createLabel").focus();
});
$("createCancelBtn").addEventListener("click", () => { createAliasForm.hidden = true; });
createAliasForm.addEventListener("submit", submitCreateAlias);
aliasTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-alias-tab]");
  if (!button) return;
  const source = button.dataset.aliasTab === "source";
  aliasTabs.querySelectorAll("[data-alias-tab]").forEach((b) => {
    const on = b === button;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  tableEl.hidden = source;
  aliasSourceEl.hidden = !source;
});
tableEl.addEventListener("click", async (event) => {
  const toggleButton = event.target.closest('[data-action="toggle-alias"]');
  const deleteButton = event.target.closest('[data-action="delete-alias"]');
  const button = toggleButton || deleteButton;
  if (!button) return;
  const alias = filterAliases(aliasRows)[Number(button.dataset.index)];
  if (!alias || !alias.anonymousId) return;
  if (toggleButton) { await runAliasAction(alias, toggleButton.dataset.aliasAction || "disable"); return; }
  if (!window.confirm(`確定要停用並刪除 ${alias.hme || alias.anonymousId}？此操作不可復原。`)) return;
  if (alias.isActive) await runAliasAction(alias, "disable");
  await runAliasAction(alias, "delete");
});

endpointList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-endpoint]");
  if (button) setSelectedOperation(button.dataset.endpoint);
});
requestPreviewEl.addEventListener("input", syncCurlFromRequestEditor);
$("sendBtn").addEventListener("click", () => runSelectedOperation());

$("refreshSessionBtn").addEventListener("click", () => runSelectedOperation("refresh"));
$("saveAutoRefreshBtn").addEventListener("click", saveAutoRefreshSettings);
$("runAutoRefreshBtn").addEventListener("click", runAutoRefreshNow);
$("importSubmitBtn").addEventListener("click", submitImportSession);
document.querySelectorAll('input[name="icloudRegion"]').forEach((input) => {
  input.addEventListener("change", updateICloudRegionUi);
});
updateICloudRegionUi();

// ---------- theme toggle ----------
const THEME_KEY = "hme-theme";
const themeToggle = $("themeToggle");
function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function updateThemeIcon() {
  const dark = effectiveTheme() === "dark";
  themeToggle.querySelector(".ico-sun").hidden = !dark;
  themeToggle.querySelector(".ico-moon").hidden = dark;
}
function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  updateThemeIcon();
}
themeToggle.addEventListener("click", toggleTheme);
updateThemeIcon();
modalApiKeyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") handleModalSubmit(); });
$("modalSubmitBtn").addEventListener("click", handleModalSubmit);

// ---------- init ----------
function init() {
  setSelectedOperation("list");
  const initialView = (window.location.hash || "").replace("#", "");
  showView(VIEW_TITLES[initialView] ? initialView : "aliases");
  loadAutoRefresh();
  loadStatus();
}

(async () => {
  const stored = getStoredApiKey();
  if (stored && (await verifyApiKey(stored))) { hideModal(); init(); }
  else showModal();
})();
