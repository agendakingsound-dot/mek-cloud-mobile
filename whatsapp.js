import makeWASocket, {
  Browsers,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

const logger = pino({ level: "silent" });

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

export class WhatsAppManager {
  constructor(pool, authStore) {
    this.pool = pool;
    this.authStore = authStore;
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
      auth: state,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
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
          await this.setStatus("LOGGED_OUT", { phone: null, displayName: null, lastConnectedAt: null, lastDisconnectReason: "LOGGED_OUT" });
          return;
        }

        const reason = statusCode ? `DISCONNECT_${statusCode}` : "CONNECTION_CLOSED";
        await this.setStatus("RECONNECTING", { lastDisconnectReason: reason });
        console.log("[WHATSAPP] Conexão fechada. Tentando reconectar...");
        this.scheduleReconnect(5000);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages || []) {
        if (!message?.key?.fromMe) {
          console.log("[WHATSAPP] Mensagem recebida:", message?.key?.remoteJid || "origem desconhecida");
        }
      }
    });

    return this.getAdminStatus();
  }

  async logoutAndClear() {
    this.clearReconnectTimer();
    this.clearQr();
    ++this.generation;
    const sock = this.socket;
    this.socket = null;

    if (sock) {
      try { await sock.logout(); }
      catch { try { sock.end?.(); } catch {} }
    }

    await this.authStore.clear();
    this.phone = null;
    this.displayName = null;
    this.lastConnectedAt = null;
    this.lastDisconnectReason = null;
    await this.setStatus("DISCONNECTED", { phone: null, displayName: null, lastConnectedAt: null, lastDisconnectReason: null });
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
    return { available: Boolean(this.qrDataUrl), dataUrl: this.qrDataUrl, generatedAt: this.qrGeneratedAt };
  }
}
