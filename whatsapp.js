import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

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

    const cached = this.outboundMessageCache.get(messageId);
    if (cached) {
      console.log(`[WHATSAPP][RETRY] Mensagem ${messageId} recuperada do cache.`);
      return cached;
    }

    if (this.messageStore) {
      try {
        const stored = await this.messageStore.getRetryContentByWhatsAppId(messageId);
        if (stored) {
          this.cacheOutboundMessage(messageId, stored);
          console.log(`[WHATSAPP][RETRY] Mensagem ${messageId} recuperada do PostgreSQL.`);
          return stored;
        }
      } catch (error) {
        console.error("[WHATSAPP][RETRY_STORE]", error.message);
      }
    }

    console.log(`[WHATSAPP][RETRY] Conteúdo não encontrado para ${messageId}.`);
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

    sock.ev.on("creds.update", async () => {
      try { await saveCreds(); }
      catch (error) { console.error("[WHATSAPP][CREDS]", error.message); }
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
        console.log("[WHATSAPP] Conectado.");
      }

      if (connection === "close") {
        this.clearQr();
        const statusCode = extractStatusCode(lastDisconnect?.error);
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.socket = null;

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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
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

    return this.getAdminStatus();
  }

  async sendText({ remoteJid, text }) {
    if (this.status !== "CONNECTED" || !this.socket) {
      const error = new Error("WhatsApp não está conectado.");
      error.code = "WHATSAPP_NOT_CONNECTED";
      throw error;
    }

    const result = await this.socket.sendMessage(remoteJid, { text });

    if (result?.key?.id && result?.message) {
      this.cacheOutboundMessage(result.key.id, result.message);
    }

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
