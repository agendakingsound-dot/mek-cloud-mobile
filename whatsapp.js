import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

// v0.3.2 DIAGNOSTICO: mantém o Baileys 6.7.24 e o comportamento atual.
// A única finalidade desta versão é registrar o caminho PN/LID/Signal do envio.
const logger = pino({ level: "silent" });

class SimpleCache {
  constructor() {
    this.map = new Map();
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    this.map.set(key, value);
    return true;
  }

  del(key) {
    return this.map.delete(key);
  }

  flushAll() {
    this.map.clear();
  }
}

// Mantido fora do socket para evitar loops de retry em reconexões.
const msgRetryCounterCache = new SimpleCache();

function extractStatusCode(error) {
  return (
    error?.output?.statusCode ??
    error?.data?.statusCode ??
    error?.statusCode ??
    null
  );
}

function sanitizePhone(jid) {
  if (!jid) return null;
  return String(jid).split("@")[0].split(":")[0] || null;
}

// Mascara números/LIDs para que screenshots dos logs não exponham os identificadores completos.
function maskJid(jid) {
  if (!jid) return null;

  const raw = String(jid);
  const at = raw.lastIndexOf("@");

  if (at < 0) {
    const digits = raw.replace(/\D/g, "");
    return digits ? `***${digits.slice(-4)}` : raw;
  }

  const local = raw.slice(0, at);
  const server = raw.slice(at + 1);
  const colon = local.indexOf(":");
  const user = colon >= 0 ? local.slice(0, colon) : local;
  const device = colon >= 0 ? local.slice(colon + 1) : null;
  const suffix = user.length > 4 ? user.slice(-4) : user;

  return `***${suffix}${device ? `:${device}` : ""}@${server}`;
}

function diag(event, payload = {}) {
  try {
    console.log(`[WA-DIAG][${event}] ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[WA-DIAG][${event}]`, payload);
  }
}

function summarizeKey(key = {}) {
  return {
    id: key?.id || null,
    fromMe: Boolean(key?.fromMe),
    remoteJid: maskJid(key?.remoteJid),
    remoteJidAlt: maskJid(key?.remoteJidAlt),
    participant: maskJid(key?.participant),
    participantAlt: maskJid(key?.participantAlt),
  };
}

function summarizeDevice(device = {}) {
  const user = String(device?.user || "");
  const suffix = user.length > 4 ? user.slice(-4) : user;

  return {
    user: suffix ? `***${suffix}` : null,
    device: device?.device ?? null,
  };
}

function extractMessageContent(message) {
  const content = message?.message || {};

  if (content.conversation) return { type: "TEXT", text: content.conversation };
  if (content.extendedTextMessage?.text) return { type: "TEXT", text: content.extendedTextMessage.text };
  if (content.imageMessage) return { type: "IMAGE", text: content.imageMessage.caption || null };
  if (content.videoMessage) return { type: "VIDEO", text: content.videoMessage.caption || null };
  if (content.documentMessage) return { type: "DOCUMENT", text: content.documentMessage.fileName || null };
  if (content.audioMessage) return { type: "AUDIO", text: null };
  if (content.stickerMessage) return { type: "STICKER", text: null };
  if (content.contactMessage) return { type: "CONTACT", text: content.contactMessage.displayName || null };
  if (content.locationMessage) return { type: "LOCATION", text: null };
  if (content.buttonsResponseMessage?.selectedDisplayText) return { type: "TEXT", text: content.buttonsResponseMessage.selectedDisplayText };
  if (content.listResponseMessage?.title) return { type: "TEXT", text: content.listResponseMessage.title };

  const firstType = Object.keys(content)[0] || "UNKNOWN";
  return { type: String(firstType).replace(/Message$/, "").toUpperCase(), text: null };
}

function mapDeliveryStatus(status) {
  const value = Number(status);
  if (value === 0) return "ERROR";
  if (value === 1) return "PENDING";
  if (value === 2) return "SERVER_ACK";
  if (value === 3) return "DELIVERED";
  if (value === 4) return "READ";
  if (value === 5) return "PLAYED";
  return null;
}

export class WhatsAppManager {
  constructor(pool, authStore, messageStore = null) {
    this.pool = pool;
    this.authStore = authStore;
    this.messageStore = messageStore;
    this.socket = null;
    this.generation = 0;
    this.reconnectTimer = null;
    this.status = "DISCONNECTED";
    this.phone = null;
    this.displayName = null;
    this.lastConnectedAt = null;
    this.lastDisconnectReason = null;
    this.qrDataUrl = null;
    this.qrGeneratedAt = null;

    // Cache das mensagens recém-enviadas para atender retry de descriptografia.
    this.outboundMessageCache = new Map();
    this.maxOutboundCacheItems = 500;
  }

  cacheOutboundMessage(messageId, content) {
    if (!messageId || !content) return;

    this.outboundMessageCache.set(String(messageId), content);

    while (this.outboundMessageCache.size > this.maxOutboundCacheItems) {
      const oldestKey = this.outboundMessageCache.keys().next().value;
      if (!oldestKey) break;
      this.outboundMessageCache.delete(oldestKey);
    }
  }

  async getMessageForRetry(key) {
    const messageId = String(key?.id || "");
    if (!messageId) return undefined;

    diag("RETRY_REQUEST", summarizeKey(key));

    const cached = this.outboundMessageCache.get(messageId);
    if (cached) {
      diag("RETRY_CACHE_HIT", {
        id: messageId,
        messageKeys: Object.keys(cached || {}),
      });
      return cached;
    }

    if (this.messageStore) {
      try {
        const stored = await this.messageStore.getRetryContentByWhatsAppId(messageId);
        if (stored) {
          this.cacheOutboundMessage(messageId, stored);
          diag("RETRY_DB_HIT", {
            id: messageId,
            messageKeys: Object.keys(stored || {}),
          });
          return stored;
        }
      } catch (error) {
        console.error("[WHATSAPP][RETRY_STORE]", error.message);
      }
    }

    diag("RETRY_MISS", { id: messageId });
    return undefined;
  }

  async initialize() {
    const hasSession = await this.authStore.hasRegisteredCreds();
    if (hasSession) {
      console.log("[WHATSAPP] Sessão persistente encontrada. Reconectando...");
      await this.connect();
    } else {
      await this.setStatus("DISCONNECTED");
    }
  }

  async setStatus(status, extra = {}) {
    this.status = status;
    if (Object.prototype.hasOwnProperty.call(extra, "phone")) this.phone = extra.phone;
    if (Object.prototype.hasOwnProperty.call(extra, "displayName")) this.displayName = extra.displayName;
    if (Object.prototype.hasOwnProperty.call(extra, "lastConnectedAt")) this.lastConnectedAt = extra.lastConnectedAt;
    if (Object.prototype.hasOwnProperty.call(extra, "lastDisconnectReason")) this.lastDisconnectReason = extra.lastDisconnectReason;

    try {
      await this.pool.query(
        `INSERT INTO mek_whatsapp_state
          (session_id, status, phone, display_name, last_connected_at, last_disconnect_reason, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (session_id)
         DO UPDATE SET
           status = EXCLUDED.status,
           phone = COALESCE(EXCLUDED.phone, mek_whatsapp_state.phone),
           display_name = COALESCE(EXCLUDED.display_name, mek_whatsapp_state.display_name),
           last_connected_at = COALESCE(EXCLUDED.last_connected_at, mek_whatsapp_state.last_connected_at),
           last_disconnect_reason = EXCLUDED.last_disconnect_reason,
           updated_at = NOW()`,
        [this.authStore.sessionId, this.status, this.phone, this.displayName, this.lastConnectedAt, this.lastDisconnectReason]
      );
    } catch (error) {
      console.error("[WHATSAPP][STATE]", error.message);
    }
  }

  clearQr() {
    this.qrDataUrl = null;
    this.qrGeneratedAt = null;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect(delayMs = 5000) {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        console.error("[WHATSAPP][RECONNECT]", error.message);
        this.scheduleReconnect(10000);
      });
    }, delayMs);
  }

  async connect() {
    if (["CONNECTING", "QR", "CONNECTED"].includes(this.status) && this.socket) {
      return this.getAdminStatus();
    }

    this.clearReconnectTimer();
    this.clearQr();
    const currentGeneration = ++this.generation;

    await this.setStatus("CONNECTING", { lastDisconnectReason: null });
    const { state, saveCreds } = await this.authStore.load();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache,
      getMessage: async (key) => this.getMessageForRetry(key),
    });

    this.socket = sock;

    diag("SOCKET_CREATED", {
      sessionId: this.authStore.sessionId,
      configuredMeId: maskJid(state?.creds?.me?.id),
      configuredMeLid: maskJid(state?.creds?.me?.lid),
    });

    sock.ev.on("creds.update", async () => {
      try { await saveCreds(); }
      catch (error) { console.error("[WHATSAPP][CREDS]", error.message); }
    });

    // Baileys 6.7.24 expõe especificamente este evento para mapear LID <-> número.
    sock.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
      diag("PN_LID_MAPPING", {
        lid: maskJid(lid),
        jid: maskJid(jid),
      });
    });

    sock.ev.on("connection.update", async (update) => {
      if (currentGeneration !== this.generation) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 360, errorCorrectionLevel: "M" });
          this.qrGeneratedAt = new Date().toISOString();
          await this.setStatus("QR");
          console.log("[WHATSAPP] QR Code disponível no painel.");
        } catch (error) {
          console.error("[WHATSAPP][QR]", error.message);
          await this.setStatus("ERROR", { lastDisconnectReason: "QR_GENERATION_ERROR" });
        }
      }

      if (connection === "connecting") await this.setStatus(qr ? "QR" : "CONNECTING");

      if (connection === "open") {
        this.clearQr();
        const now = new Date();
        const phone = sanitizePhone(sock.user?.id);
        const displayName = sock.user?.name || null;
        await this.setStatus("CONNECTED", { phone, displayName, lastConnectedAt: now, lastDisconnectReason: null });

        diag("CONNECTION_OPEN", {
          socketUserId: maskJid(sock.user?.id),
          socketUserLid: maskJid(sock.user?.lid),
          displayName: displayName || null,
        });
        console.log("[WHATSAPP] Conectado.");
      }

      if (connection === "close") {
        this.clearQr();
        const statusCode = extractStatusCode(lastDisconnect?.error);
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.socket = null;

        diag("CONNECTION_CLOSE", {
          statusCode,
          loggedOut,
          error: lastDisconnect?.error?.message || null,
        });

        if (loggedOut) {
          console.log("[WHATSAPP] Sessão desconectada pelo WhatsApp.");
          ++this.generation;
          try { await this.authStore.clear(); }
          catch (error) { console.error("[WHATSAPP][CLEAR]", error.message); }
          this.phone = null;
          this.displayName = null;
          this.lastConnectedAt = null;
          await this.setStatus("LOGGED_OUT", {
            phone: null,
            displayName: null,
            lastConnectedAt: null,
            lastDisconnectReason: "LOGGED_OUT",
          });
          return;
        }

        const reason = statusCode ? `DISCONNECT_${statusCode}` : "CONNECTION_CLOSED";
        await this.setStatus("RECONNECTING", { lastDisconnectReason: reason });
        console.log("[WHATSAPP] Conexão fechada. Tentando reconectar...");
        this.scheduleReconnect(5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type, requestId }) => {
      // Diagnóstico ocorre ANTES dos filtros atuais; não altera a persistência.
      for (const message of messages || []) {
        diag("MESSAGE_UPSERT", {
          type,
          requestId: requestId || null,
          key: summarizeKey(message?.key),
          messageKeys: Object.keys(message?.message || {}),
          status: message?.status ?? null,
        });
      }

      if (type !== "notify") return;

      for (const message of messages || []) {
        if (message?.key?.fromMe) continue;

        const remoteJid = message?.key?.remoteJid || "";
        const phone = sanitizePhone(remoteJid);
        const extracted = extractMessageContent(message);

        console.log("[WHATSAPP] Mensagem recebida:", remoteJid || "origem desconhecida");

        if (this.messageStore && remoteJid) {
          try {
            await this.messageStore.recordInbound({
              remoteJid,
              phone,
              whatsappMessageId: message?.key?.id || null,
              messageType: extracted.type,
              content: extracted.text,
              rawPayload: {
                key: {
                  id: message?.key?.id || null,
                  remoteJid,
                  participant: message?.key?.participant || null,
                },
                pushName: message?.pushName || null,
                messageTimestamp: message?.messageTimestamp || null,
              },
            });
          } catch (error) {
            console.error("[WHATSAPP][INBOUND_STORE]", error.message);
          }
        }
      }
    });

    sock.ev.on("messages.update", async (updates) => {
      for (const item of updates || []) {
        diag("MESSAGE_UPDATE", {
          key: summarizeKey(item?.key),
          statusRaw: item?.update?.status ?? null,
          statusMapped: mapDeliveryStatus(item?.update?.status),
          updateKeys: Object.keys(item?.update || {}),
        });
      }

      if (!this.messageStore) return;

      for (const item of updates || []) {
        const whatsappMessageId = item?.key?.id || null;
        const status = mapDeliveryStatus(item?.update?.status);
        if (!whatsappMessageId || !status) continue;

        try {
          await this.messageStore.updateDeliveryByWhatsAppId(whatsappMessageId, status);
        } catch (error) {
          console.error("[WHATSAPP][DELIVERY_STORE]", error.message);
        }
      }
    });

    sock.ev.on("message-receipt.update", (updates) => {
      for (const item of updates || []) {
        diag("MESSAGE_RECEIPT", {
          key: summarizeKey(item?.key),
          receiptCount: Array.isArray(item?.receipt) ? item.receipt.length : null,
          receipts: Array.isArray(item?.receipt)
            ? item.receipt.slice(0, 10).map((receipt) => ({
                userJid: maskJid(receipt?.userJid),
                receiptTimestamp: receipt?.receiptTimestamp ?? null,
                readTimestamp: receipt?.readTimestamp ?? null,
                playedTimestamp: receipt?.playedTimestamp ?? null,
              }))
            : null,
        });
      }
    });

    return this.getAdminStatus();
  }

  async collectPostSendDiagnostics(remoteJid, messageId) {
    if (!this.socket) return;

    try {
      if (typeof this.socket.onWhatsApp === "function") {
        const result = await this.socket.onWhatsApp(remoteJid);
        diag("ON_WHATSAPP_AFTER_SEND", {
          messageId,
          requestedRemoteJid: maskJid(remoteJid),
          results: Array.isArray(result)
            ? result.map((item) => ({
                exists: Boolean(item?.exists),
                jid: maskJid(item?.jid),
              }))
            : result,
        });
      }
    } catch (error) {
      diag("ON_WHATSAPP_ERROR", {
        messageId,
        error: error?.message || String(error),
      });
    }

    try {
      if (typeof this.socket.getUSyncDevices === "function") {
        // Executado SOMENTE depois do sendMessage, para não interferir no envio testado.
        const devices = await this.socket.getUSyncDevices([remoteJid], false, false);
        diag("USYNC_DEVICES_AFTER_SEND", {
          messageId,
          requestedRemoteJid: maskJid(remoteJid),
          count: Array.isArray(devices) ? devices.length : null,
          devices: Array.isArray(devices) ? devices.map(summarizeDevice) : null,
        });
      } else {
        diag("USYNC_UNAVAILABLE", { messageId });
      }
    } catch (error) {
      diag("USYNC_ERROR", {
        messageId,
        error: error?.message || String(error),
      });
    }
  }

  async sendText({ remoteJid, text }) {
    if (this.status !== "CONNECTED" || !this.socket) {
      const error = new Error("WhatsApp não está conectado.");
      error.code = "WHATSAPP_NOT_CONNECTED";
      throw error;
    }

    diag("SEND_BEGIN", {
      requestedRemoteJid: maskJid(remoteJid),
      socketUserId: maskJid(this.socket.user?.id),
      socketUserLid: maskJid(this.socket.user?.lid),
      textLength: String(text || "").length,
    });

    const result = await this.socket.sendMessage(remoteJid, { text });

    if (result?.key?.id && result?.message) {
      this.cacheOutboundMessage(result.key.id, result.message);
    }

    diag("SEND_RESULT", {
      key: summarizeKey(result?.key),
      messageKeys: Object.keys(result?.message || {}),
      messageTimestamp: result?.messageTimestamp ?? null,
      status: result?.status ?? null,
    });

    // Importante: diagnóstico de resolução PN/LID/dispositivos é feito APÓS o envio.
    // Assim o teste mede o mesmo sendMessage que já estávamos usando.
    await this.collectPostSendDiagnostics(remoteJid, result?.key?.id || null);

    return {
      id: result?.key?.id || null,
      remoteJid: result?.key?.remoteJid || remoteJid,
      fromMe: Boolean(result?.key?.fromMe),
      timestamp: new Date().toISOString(),
    };
  }

  async logoutAndClear() {
    this.clearReconnectTimer();
    this.clearQr();
    ++this.generation;
    const sock = this.socket;
    this.socket = null;
    this.outboundMessageCache.clear();
    msgRetryCounterCache.flushAll();

    if (sock) {
      try { await sock.logout(); }
      catch { try { sock.end?.(); } catch {} }
    }

    await this.authStore.clear();
    this.phone = null;
    this.displayName = null;
    this.lastConnectedAt = null;
    this.lastDisconnectReason = null;
    await this.setStatus("DISCONNECTED", {
      phone: null,
      displayName: null,
      lastConnectedAt: null,
      lastDisconnectReason: null,
    });
    return this.getAdminStatus();
  }

  getPublicStatus() {
    return {
      status: this.status,
      connected: this.status === "CONNECTED",
      qrAvailable: Boolean(this.qrDataUrl),
      reconnecting: this.status === "RECONNECTING",
      lastConnectedAt: this.lastConnectedAt,
    };
  }

  getAdminStatus() {
    return {
      ...this.getPublicStatus(),
      phone: this.phone,
      displayName: this.displayName,
      qrGeneratedAt: this.qrGeneratedAt,
      lastDisconnectReason: this.lastDisconnectReason,
    };
  }

  getQr() {
    return {
      available: Boolean(this.qrDataUrl),
      dataUrl: this.qrDataUrl,
      generatedAt: this.qrGeneratedAt,
    };
  }
}
