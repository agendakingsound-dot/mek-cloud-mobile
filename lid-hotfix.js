import { USyncQuery, USyncUser } from "@whiskeysockets/baileys";
import { WhatsAppManager } from "./whatsapp.js";

// MEK Cloud Mobile v0.3.3 - LID Routing Hotfix
// Mantém o núcleo v0.3.2 intacto e intercepta apenas o envio de texto.
// Números PN (@s.whatsapp.net) são resolvidos para o LID correspondente
// antes do sendMessage, evitando criptografia Signal no identificador legado.

const LID_CACHE_TTL_MS = 30 * 60 * 1000;
const lidCacheByManager = new WeakMap();

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

function isPhoneJid(jid) {
  return String(jid || "").endsWith("@s.whatsapp.net");
}

function normalizeLidJid(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (raw.includes("@")) {
    return raw.endsWith("@lid") ? raw : null;
  }

  const user = raw.split(":")[0].replace(/\D/g, "");
  return user ? `${user}@lid` : null;
}

function getManagerCache(manager) {
  let cache = lidCacheByManager.get(manager);
  if (!cache) {
    cache = new Map();
    lidCacheByManager.set(manager, cache);
  }
  return cache;
}

async function resolveLid(manager, remoteJid) {
  if (!isPhoneJid(remoteJid)) {
    return { routedJid: remoteJid, source: "already_non_pn" };
  }

  const cache = getManagerCache(manager);
  const cached = cache.get(remoteJid);

  if (cached && cached.expiresAt > Date.now()) {
    console.log(
      `[LID-HOTFIX][CACHE_HIT] ${maskJid(remoteJid)} -> ${maskJid(cached.lidJid)}`
    );
    return { routedJid: cached.lidJid, source: "cache" };
  }

  if (cached) cache.delete(remoteJid);

  if (!manager.socket || typeof manager.socket.executeUSyncQuery !== "function") {
    const error = new Error("Socket atual não expõe executeUSyncQuery para resolução LID.");
    error.code = "LID_RESOLUTION_UNAVAILABLE";
    throw error;
  }

  const query = new USyncQuery()
    .withLIDProtocol()
    .withContext("background")
    .withUser(new USyncUser().withId(remoteJid));

  let result;
  try {
    result = await manager.socket.executeUSyncQuery(query);
  } catch (cause) {
    console.error(
      `[LID-HOTFIX][USYNC_ERROR] ${maskJid(remoteJid)}: ${cause?.message || String(cause)}`
    );
    const error = new Error("Falha ao consultar o LID do destinatário no WhatsApp.");
    error.code = "LID_RESOLUTION_FAILED";
    error.cause = cause;
    throw error;
  }

  const list = Array.isArray(result?.list) ? result.list : [];
  const item =
    list.find((entry) => entry?.id === remoteJid && entry?.lid) ||
    list.find((entry) => entry?.lid) ||
    null;

  const lidJid = normalizeLidJid(item?.lid);

  console.log(
    `[LID-HOTFIX][USYNC_RESULT] requested=${maskJid(remoteJid)} entries=${list.length} ` +
      `resolved=${maskJid(lidJid) || "NONE"}`
  );

  if (!lidJid) {
    const error = new Error("O WhatsApp não retornou um LID válido para o destinatário.");
    error.code = "LID_NOT_FOUND";
    throw error;
  }

  cache.set(remoteJid, {
    lidJid,
    expiresAt: Date.now() + LID_CACHE_TTL_MS,
  });

  return { routedJid: lidJid, source: "usync" };
}

const originalSendText = WhatsAppManager.prototype.sendText;

WhatsAppManager.prototype.sendText = async function sendTextWithLidRouting({ remoteJid, text }) {
  // Preserva exatamente o tratamento original de estado/desconexão.
  if (this.status !== "CONNECTED" || !this.socket) {
    return originalSendText.call(this, { remoteJid, text });
  }

  const requestedRemoteJid = remoteJid;
  const { routedJid, source } = await resolveLid(this, requestedRemoteJid);

  console.log(
    `[LID-HOTFIX][ROUTE] source=${source} ${maskJid(requestedRemoteJid)} -> ${maskJid(routedJid)}`
  );

  const result = await originalSendText.call(this, {
    remoteJid: routedJid,
    text,
  });

  return {
    ...result,
    requestedRemoteJid,
    routedRemoteJid: routedJid,
    lidRouting: source,
  };
};

console.log("[MEK] v0.3.3 LID Routing Hotfix carregado.");
