import crypto from "crypto";
import express from "express";
import { createPool, databaseStatus, ensureSchema } from "./db.js";
import { PostgresAuthStore } from "./auth-store.js";
import { WhatsAppManager } from "./whatsapp.js";
import { MessageStore, generateRequestId, normalizePhone, phoneToJid } from "./message-store.js";

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
const API_TOKEN = String(process.env.API_TOKEN || "");
const SESSION_ID = String(process.env.WHATSAPP_SESSION_ID || "primary");
const startedAt = new Date();
const pool = createPool();
const messageStore = pool ? new MessageStore(pool) : null;
let schemaReady = false;
let whatsappReady = false;
let whatsapp = null;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt.getTime()) / 1000);
}

function constantTimeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: "ADMIN_TOKEN_NOT_CONFIGURED",
      message: "Defina ADMIN_TOKEN no Secret Group/Environment da Northflank.",
    });
  }

  const authorization = req.get("authorization") || "";
  const expected = `Bearer ${ADMIN_TOKEN}`;

  if (!constantTimeEqual(authorization, expected)) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  next();
}

function requireApi(req, res, next) {
  if (!API_TOKEN) {
    return res.status(503).json({
      error: "API_TOKEN_NOT_CONFIGURED",
      message: "Defina API_TOKEN no Secret Group/Environment da Northflank.",
    });
  }

  const authorization = req.get("authorization") || "";
  const expected = `Bearer ${API_TOKEN}`;

  if (!constantTimeEqual(authorization, expected)) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  next();
}

function validateRequestId(value) {
  const requestId = String(value || "").trim();
  if (!requestId) return generateRequestId();
  if (requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    throw new Error("INVALID_REQUEST_ID");
  }
  return requestId;
}

function sanitizePairingPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function waitForPairingReady(timeoutMs = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (
      whatsapp?.socket &&
      (whatsapp?.qrDataUrl || whatsapp?.status === "QR" || whatsapp?.status === "CONNECTED")
    ) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

async function bootstrapDatabaseAndWhatsApp() {
  if (!pool) {
    schemaReady = false;
    return;
  }

  try {
    await ensureSchema(pool);
    schemaReady = true;

    if (!whatsappReady) {
      const authStore = new PostgresAuthStore(pool, SESSION_ID);
      whatsapp = new WhatsAppManager(pool, authStore, messageStore);
      whatsappReady = true;
      await whatsapp.initialize();
    }
  } catch (error) {
    schemaReady = false;
    console.error("[BOOTSTRAP]", error.message);
  }
}

await bootstrapDatabaseAndWhatsApp();

setInterval(() => {
  if (!schemaReady || !whatsappReady) {
    bootstrapDatabaseAndWhatsApp().catch((error) => {
      console.error("[BOOTSTRAP][RETRY]", error.message);
    });
  }
}, 15000).unref();

app.get("/health", async (_req, res) => {
  const database = await databaseStatus(pool);

  res.status(database.connected ? 200 : 503).json({
    service: "MEK Cloud Mobile",
    version: "0.3.0",
    engine: "ONLINE",
    database,
    schemaReady,
    uptimeSeconds: uptimeSeconds(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/status", async (_req, res) => {
  const database = await databaseStatus(pool);

  res.json({
    name: "MEK Cloud Mobile",
    version: "0.3.0",
    engine: {
      status: "ONLINE",
      uptimeSeconds: uptimeSeconds(),
    },
    database,
    whatsapp: whatsapp
      ? whatsapp.getPublicStatus()
      : {
          status: "INITIALIZING",
          connected: false,
          qrAvailable: false,
          reconnecting: false,
          lastConnectedAt: null,
        },
    adminConfigured: Boolean(ADMIN_TOKEN),
    apiConfigured: Boolean(API_TOKEN),
    messagingApi: true,
    pairingCodeSupported: true,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/status", requireApi, (_req, res) => {
  res.json({
    ok: true,
    version: "0.3.0",
    whatsapp: whatsapp ? whatsapp.getPublicStatus() : { status: "INITIALIZING", connected: false },
    databaseReady: schemaReady,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/v1/messages/text", requireApi, async (req, res) => {
  if (!messageStore || !whatsapp) {
    return res.status(503).json({ error: "MESSAGING_NOT_READY" });
  }

  const text = String(req.body?.message || req.body?.text || "").trim();

  if (!text || text.length > 4000) {
    return res.status(400).json({
      error: "INVALID_MESSAGE",
      message: "A mensagem deve conter entre 1 e 4000 caracteres.",
    });
  }

  let phone;
  let requestId;

  try {
    phone = normalizePhone(req.body?.phone);
    requestId = validateRequestId(req.body?.requestId);
  } catch (error) {
    if (error.message === "INVALID_PHONE_NUMBER") {
      return res.status(400).json({ error: "INVALID_PHONE_NUMBER" });
    }
    return res.status(400).json({ error: "INVALID_REQUEST_ID" });
  }

  const remoteJid = phoneToJid(phone);

  try {
    const reservation = await messageStore.reserveOutbound({
      requestId,
      phone,
      remoteJid,
      content: text,
    });

    if (reservation.duplicate) {
      return res.status(200).json({
        ok: reservation.message?.status !== "ERROR",
        duplicate: true,
        requestId,
        message: reservation.message,
      });
    }

    const sendResult = await whatsapp.sendText({ remoteJid, text });
    const stored = await messageStore.markSent(requestId, sendResult.id, sendResult);

    return res.status(201).json({
      ok: true,
      duplicate: false,
      requestId,
      whatsappMessageId: sendResult.id,
      phone,
      status: stored?.status || "SENT",
      timestamp: sendResult.timestamp,
    });
  } catch (error) {
    console.error("[MESSAGING][SEND]", error.message);
    try { await messageStore.markError(requestId, error); } catch {}

    const statusCode = error.code === "WHATSAPP_NOT_CONNECTED" ? 503 : 500;
    return res.status(statusCode).json({
      ok: false,
      requestId,
      error: error.code || "SEND_FAILED",
      message: error.message,
    });
  }
});

app.get("/api/v1/messages/:requestId", requireApi, async (req, res) => {
  if (!messageStore) return res.status(503).json({ error: "MESSAGING_NOT_READY" });
  const item = await messageStore.getByRequestId(String(req.params.requestId || ""));
  if (!item) return res.status(404).json({ error: "MESSAGE_NOT_FOUND" });
  res.json({ ok: true, message: item });
});

app.get("/api/v1/messages", requireApi, async (req, res) => {
  if (!messageStore) return res.status(503).json({ error: "MESSAGING_NOT_READY" });

  try {
    const items = await messageStore.list({
      phone: req.query.phone || null,
      direction: req.query.direction || null,
      limit: req.query.limit || 50,
    });
    res.json({ ok: true, count: items.length, messages: items });
  } catch (error) {
    res.status(400).json({ error: error.message || "INVALID_QUERY" });
  }
});

app.get("/api/admin/verify", requireAdmin, (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/whatsapp/admin-status", requireAdmin, (_req, res) => {
  if (!whatsapp) {
    return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  }

  res.json(whatsapp.getAdminStatus());
});

app.get("/api/whatsapp/qr", requireAdmin, (_req, res) => {
  if (!whatsapp) {
    return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  }

  res.json(whatsapp.getQr());
});

app.post("/api/whatsapp/connect", requireAdmin, async (_req, res) => {
  if (!whatsapp) {
    return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  }

  try {
    res.json(await whatsapp.connect());
  } catch (error) {
    console.error("[WHATSAPP][CONNECT]", error.message);
    res.status(500).json({
      error: "WHATSAPP_CONNECT_FAILED",
      message: "Não foi possível iniciar a conexão com o WhatsApp.",
    });
  }
});

app.post("/api/whatsapp/pairing-code", requireAdmin, async (req, res) => {
  if (!whatsapp) {
    return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  }

  const phoneNumber = sanitizePairingPhone(req.body?.phoneNumber);

  if (phoneNumber.length < 10 || phoneNumber.length > 15) {
    return res.status(400).json({
      error: "INVALID_PHONE_NUMBER",
      message: "Informe o número completo com DDI, apenas números. Ex.: 5521999999999.",
    });
  }

  if (whatsapp.getPublicStatus().connected) {
    return res.status(409).json({
      error: "WHATSAPP_ALREADY_CONNECTED",
      message: "O WhatsApp já está conectado.",
    });
  }

  try {
    await whatsapp.connect();

    const ready = await waitForPairingReady();

    if (!ready || !whatsapp.socket?.requestPairingCode) {
      return res.status(503).json({
        error: "PAIRING_NOT_READY",
        message: "O WhatsApp ainda não ficou pronto para gerar o código. Tente novamente em alguns segundos.",
      });
    }

    const code = await whatsapp.socket.requestPairingCode(phoneNumber);

    console.log(`[WHATSAPP] Código de pareamento solicitado para ${phoneNumber.slice(0, 4)}******`);

    res.json({
      ok: true,
      code,
      phoneNumber,
      expiresSoon: true,
    });
  } catch (error) {
    console.error("[WHATSAPP][PAIRING_CODE]", error.message);
    res.status(500).json({
      error: "PAIRING_CODE_FAILED",
      message: "Não foi possível gerar o código de pareamento. Tente novamente.",
    });
  }
});

app.post("/api/whatsapp/logout", requireAdmin, async (_req, res) => {
  if (!whatsapp) {
    return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  }

  try {
    res.json(await whatsapp.logoutAndClear());
  } catch (error) {
    console.error("[WHATSAPP][LOGOUT]", error.message);
    res.status(500).json({ error: "WHATSAPP_LOGOUT_FAILED" });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>MEK Cloud Mobile</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0b1020; color: #eef2ff; font-family: Arial, Helvetica, sans-serif; padding: 24px; }
    .wrap { width: min(760px, 100%); margin: 0 auto; }
    .card { background: #121a2f; border: 1px solid #283554; border-radius: 18px; padding: 26px; box-shadow: 0 18px 60px rgba(0,0,0,.35); margin-bottom: 18px; }
    h1 { margin: 0 0 6px; font-size: 28px; }
    h2 { margin: 0 0 18px; font-size: 19px; }
    h3 { margin: 18px 0 10px; font-size: 15px; color: #c8d2ea; }
    .subtitle { margin: 0; color: #9eabc7; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid #25304a; }
    .row:first-of-type { border-top: 0; }
    .label { font-weight: 700; }
    .status { font-weight: 800; letter-spacing: .3px; padding: 7px 10px; border-radius: 999px; font-size: 12px; text-align: center; }
    .ok { background: #123b2b; color: #7df1b1; }
    .warn { background: #4b3512; color: #ffd782; }
    .off { background: #3b2430; color: #ff9ab8; }
    .neutral { background: #25304a; color: #bdc8de; }
    .controls { display: grid; gap: 10px; margin-top: 16px; }
    input { width: 100%; border: 1px solid #354566; border-radius: 11px; padding: 13px; font-size: 16px; background: #0d1427; color: #fff; outline: none; }
    button { border: 0; border-radius: 11px; padding: 13px 16px; font-size: 15px; font-weight: 800; cursor: pointer; }
    .primary { background: #e8ecff; color: #111827; }
    .secondary { background: #263554; color: #e8ecff; }
    .danger { background: #4b1f2b; color: #ffb2c7; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .qr { width: min(360px, 100%); margin: 18px auto 0; display: none; border-radius: 14px; background: #fff; padding: 10px; }
    .pairing { display: none; margin-top: 16px; padding: 18px; border: 1px solid #415379; background: #0d1427; border-radius: 14px; text-align: center; }
    .pairing-code { font-size: clamp(28px, 7vw, 42px); letter-spacing: 6px; font-weight: 900; color: #ffffff; margin: 10px 0 14px; word-break: break-all; }
    .divider { display: flex; align-items: center; gap: 10px; color: #71809e; margin: 16px 0; font-size: 12px; font-weight: 800; }
    .divider::before, .divider::after { content: ""; height: 1px; background: #2b3855; flex: 1; }
    .message { margin-top: 14px; min-height: 22px; color: #aab6ce; line-height: 1.5; font-size: 14px; }
    .small { color: #7f8da9; font-size: 12px; line-height: 1.55; margin-top: 18px; }
    code { color: #c2ceff; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>MEK CLOUD MOBILE</h1>
      <p class="subtitle">WhatsApp Engine · v0.3.0 · Messaging API</p>
      <div class="row"><span class="label">Engine</span><span id="engineStatus" class="status neutral">CARREGANDO</span></div>
      <div class="row"><span class="label">Database</span><span id="databaseStatus" class="status neutral">CARREGANDO</span></div>
      <div class="row"><span class="label">WhatsApp</span><span id="whatsappStatus" class="status neutral">CARREGANDO</span></div>
    </section>

    <section class="card">
      <h2>Controle administrativo</h2>

      <div class="controls">
        <input id="adminToken" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">
        <button id="saveToken" class="primary">USAR TOKEN NESTA SESSÃO</button>
      </div>

      <h3>Opção recomendada: parear neste mesmo celular</h3>
      <div class="controls">
        <input id="phoneNumber" inputmode="numeric" autocomplete="tel" placeholder="Número com DDI, ex.: 5521999999999">
        <button id="pairingButton" class="primary" disabled>GERAR CÓDIGO DE PAREAMENTO</button>
      </div>

      <div id="pairingBox" class="pairing">
        <div>Seu código de pareamento:</div>
        <div id="pairingCode" class="pairing-code"></div>
        <button id="copyPairingCode" class="secondary">COPIAR CÓDIGO</button>
        <div class="small">No mesmo celular: abra o WhatsApp → Aparelhos conectados → Conectar um aparelho → Vincular com número de telefone e informe este código.</div>
      </div>

      <div class="divider">OU USE QR CODE</div>

      <div class="controls">
        <button id="connectButton" class="secondary" disabled>GERAR QR CODE</button>
        <button id="logoutButton" class="danger" disabled>DESCONECTAR E APAGAR SESSÃO</button>
      </div>

      <img id="qrImage" class="qr" alt="QR Code WhatsApp">
      <div id="message" class="message"></div>
      <div class="small">O ADMIN_TOKEN fica somente nesta aba do navegador via <code>sessionStorage</code>. O código de pareamento é temporário e deve ser usado logo após a geração.</div>
    </section>
  </main>

  <script>
    const tokenInput = document.getElementById("adminToken");
    const saveTokenButton = document.getElementById("saveToken");
    const phoneNumberInput = document.getElementById("phoneNumber");
    const pairingButton = document.getElementById("pairingButton");
    const pairingBox = document.getElementById("pairingBox");
    const pairingCodeElement = document.getElementById("pairingCode");
    const copyPairingCodeButton = document.getElementById("copyPairingCode");
    const connectButton = document.getElementById("connectButton");
    const logoutButton = document.getElementById("logoutButton");
    const qrImage = document.getElementById("qrImage");
    const messageBox = document.getElementById("message");
    const engineStatus = document.getElementById("engineStatus");
    const databaseStatus = document.getElementById("databaseStatus");
    const whatsappStatus = document.getElementById("whatsappStatus");

    function setBadge(element, text, kind) {
      element.textContent = text;
      element.className = "status " + kind;
    }

    function setMessage(text) {
      messageBox.textContent = text || "";
    }

    function getToken() {
      return sessionStorage.getItem("mekAdminToken") || "";
    }

    function authHeaders() {
      const token = getToken();
      return token ? { Authorization: "Bearer " + token } : {};
    }

    function hidePairingCode() {
      pairingBox.style.display = "none";
      pairingCodeElement.textContent = "";
      sessionStorage.removeItem("mekPairingCode");
    }

    function showPairingCode(code) {
      pairingCodeElement.textContent = String(code || "").toUpperCase();
      pairingBox.style.display = "block";
      qrImage.style.display = "none";
      sessionStorage.setItem("mekPairingCode", String(code || ""));
    }

    async function api(url, options = {}) {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          ...authHeaders(),
        },
        cache: "no-store",
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(data.message || data.error || "Falha na requisição.");
        error.status = response.status;
        throw error;
      }

      return data;
    }

    async function refreshPublicStatus() {
      try {
        const data = await api("/api/status");
        setBadge(engineStatus, "ONLINE", "ok");

        if (data.database?.connected) {
          setBadge(databaseStatus, "CONNECTED", "ok");
        } else {
          setBadge(databaseStatus, data.database?.status || "ERROR", "warn");
        }

        const wa = data.whatsapp || {};
        const waStatus = wa.status || "UNKNOWN";

        if (wa.connected) {
          setBadge(whatsappStatus, "CONNECTED", "ok");
          hidePairingCode();
          qrImage.style.display = "none";
        } else if (["CONNECTING", "QR", "RECONNECTING"].includes(waStatus)) {
          setBadge(whatsappStatus, waStatus, "warn");
        } else {
          setBadge(whatsappStatus, waStatus, "off");
        }

        if (!data.adminConfigured) {
          connectButton.disabled = true;
          pairingButton.disabled = true;
          logoutButton.disabled = true;
          setMessage("ADMIN_TOKEN ainda não foi configurado na Northflank.");
        }
      } catch {
        setBadge(engineStatus, "ERROR", "off");
      }
    }

    async function verifyAdmin() {
      const token = getToken();

      if (!token) {
        connectButton.disabled = true;
        pairingButton.disabled = true;
        logoutButton.disabled = true;
        return false;
      }

      try {
        await api("/api/admin/verify");
        connectButton.disabled = false;
        pairingButton.disabled = false;
        logoutButton.disabled = false;
        setMessage("Acesso administrativo autorizado.");
        return true;
      } catch (error) {
        connectButton.disabled = true;
        pairingButton.disabled = true;
        logoutButton.disabled = true;
        setMessage(
          error.status === 503
            ? "ADMIN_TOKEN ainda não foi configurado na Northflank."
            : "Token administrativo inválido."
        );
        return false;
      }
    }

    async function refreshAdminStatus() {
      if (!getToken()) {
        qrImage.style.display = "none";
        return;
      }

      try {
        const status = await api("/api/whatsapp/admin-status");

        if (status.connected) {
          qrImage.style.display = "none";
          hidePairingCode();
          setMessage(
            "WhatsApp conectado" +
            (status.phone ? " · " + status.phone : "") +
            ". Sessão persistida no PostgreSQL."
          );
          return;
        }

        if (pairingBox.style.display === "block") {
          qrImage.style.display = "none";
          return;
        }

        if (status.qrAvailable) {
          const qr = await api("/api/whatsapp/qr");

          if (qr.available && qr.dataUrl) {
            qrImage.src = qr.dataUrl;
            qrImage.style.display = "block";
          }
        } else {
          qrImage.style.display = "none";

          if (status.status === "RECONNECTING") {
            setMessage("Reconectando automaticamente ao WhatsApp...");
          }
        }
      } catch (error) {
        if (error.status === 401) {
          qrImage.style.display = "none";
        }
      }
    }

    saveTokenButton.addEventListener("click", async () => {
      const token = tokenInput.value.trim();

      if (!token) {
        setMessage("Digite o ADMIN_TOKEN.");
        return;
      }

      sessionStorage.setItem("mekAdminToken", token);
      tokenInput.value = "";
      await verifyAdmin();
      await refreshAdminStatus();
    });

    pairingButton.addEventListener("click", async () => {
      const phoneNumber = phoneNumberInput.value.replace(/\D/g, "");

      if (phoneNumber.length < 10 || phoneNumber.length > 15) {
        setMessage("Digite o número completo com DDI, apenas números. Ex.: 5521999999999.");
        return;
      }

      pairingButton.disabled = true;
      hidePairingCode();
      qrImage.style.display = "none";
      setMessage("Gerando código de pareamento...");

      try {
        const data = await api("/api/whatsapp/pairing-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneNumber }),
        });

        showPairingCode(data.code);
        setMessage("Código gerado. Agora alterne para o WhatsApp neste mesmo celular e informe o código em Aparelhos conectados.");
      } catch (error) {
        setMessage(error.message);
      } finally {
        pairingButton.disabled = false;
      }
    });

    copyPairingCodeButton.addEventListener("click", async () => {
      const code = pairingCodeElement.textContent.trim();
      if (!code) return;

      try {
        await navigator.clipboard.writeText(code);
        setMessage("Código copiado. Abra o WhatsApp e conclua o pareamento.");
      } catch {
        setMessage("Não foi possível copiar automaticamente. Anote o código exibido.");
      }
    });

    connectButton.addEventListener("click", async () => {
      connectButton.disabled = true;
      hidePairingCode();
      setMessage("Gerando QR Code...");

      try {
        await api("/api/whatsapp/connect", { method: "POST" });
        await refreshPublicStatus();
        await refreshAdminStatus();
        setMessage("QR Code gerado como alternativa ao pareamento por código.");
      } catch (error) {
        setMessage(error.message);
      } finally {
        connectButton.disabled = false;
      }
    });

    logoutButton.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Isso desconectará o WhatsApp e apagará a sessão persistida. Continuar?"
      );

      if (!confirmed) return;

      logoutButton.disabled = true;

      try {
        await api("/api/whatsapp/logout", { method: "POST" });
        qrImage.style.display = "none";
        hidePairingCode();
        setMessage("Sessão do WhatsApp removida.");
        await refreshPublicStatus();
      } catch (error) {
        setMessage(error.message);
      } finally {
        logoutButton.disabled = false;
      }
    });

    const savedPairingCode = sessionStorage.getItem("mekPairingCode");
    if (savedPairingCode) showPairingCode(savedPairingCode);

    async function tick() {
      await refreshPublicStatus();
      await refreshAdminStatus();
    }

    verifyAdmin();
    tick();
    setInterval(tick, 2500);
  </script>
</body>
</html>`);
});

app.use((_req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MEK] Cloud Mobile v0.3.0 online na porta ${PORT}`);
  console.log(`[MEK] DATABASE_URL: ${pool ? "configurada" : "não configurada"}`);
  console.log(`[MEK] ADMIN_TOKEN: ${ADMIN_TOKEN ? "configurado" : "não configurado"}`);
  console.log(`[MEK] API_TOKEN: ${API_TOKEN ? "configurado" : "não configurado"}`);
  console.log("[MEK] Pairing Code: habilitado");
  console.log("[MEK] Messaging API v1: habilitada");
});

async function gracefulShutdown(signal) {
  console.log(`[MEK] Encerrando por ${signal}...`);

  try {
    await pool?.end();
  } catch {}

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
