import { USyncQuery, USyncUser } from "@whiskeysockets/baileys";
import { WhatsAppManager } from "./whatsapp.js";

// MEK Cloud Mobile v0.3.4 - PN Passthrough Diagnostic Hotfix
// Mantém o núcleo v0.3.2 intacto e intercepta apenas o envio de texto.
// O LID continua sendo consultado para diagnóstico, mas NÃO substitui o PN
// (@s.whatsapp.net) no sendMessage. Assim, o Baileys recebe o JID original
// e fica responsável por resolver dispositivos/sessões Signal internamente.

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

async function resolveLidForDiagnostic(manager, remoteJid) {
  if (!isPhoneJid(remoteJid)) {
    return { lidJid: null, source: "not_pn" };
  }

  const cache = getManagerCache(manager);
  const cached = cache.get(remoteJid);

  if (cached && cached.expiresAt > Date.now()) {
    console.log(
      `[LID-HOTFIX][CACHE_HIT] ${maskJid(remoteJid)} -> ${maskJid(cached.lidJid)}`
    );
    return { lidJid: cached.lidJid, source: "cache" };
  }

  if (cached) cache.delete(remoteJid);

  if (!manager.socket || typeof manager.socket.executeUSyncQuery !== "function") {
    return { lidJid: null, source: "usync_unavailable" };
  }

  const query = new USyncQuery()
    .withLIDProtocol()
    .withContext("background")
    .withUser(new USyncUser().withId(remoteJid));

  try {
    const result = await manager.socket.executeUSyncQuery(query);
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

    if (lidJid) {
      cache.set(remoteJid, {
        lidJid,
        expiresAt: Date.now() + LID_CACHE_TTL_MS,
      });
    }

    return {
      lidJid,
      source: lidJid ? "usync" : "not_found",
    };
  } catch (error) {
    console.error(
      `[LID-HOTFIX][USYNC_DIAG_ERROR] ${maskJid(remoteJid)}: ${error?.message || String(error)}`
    );

    // v0.3.4: USync é apenas diagnóstico. Uma falha aqui NÃO bloqueia o envio.
    return { lidJid: null, source: "usync_error" };
  }
}

const originalSendText = WhatsAppManager.prototype.sendText;

WhatsAppManager.prototype.sendText = async function sendTextWithPnPassthrough({ remoteJid, text }) {
  // Preserva exatamente o tratamento original de estado/desconexão.
  if (this.status !== "CONNECTED" || !this.socket) {
    return originalSendText.call(this, { remoteJid, text });
  }

  const requestedRemoteJid = remoteJid;
  const diagnostic = await resolveLidForDiagnostic(this, requestedRemoteJid);

  console.log(
    `[LID-HOTFIX][PN_PASSTHROUGH] requested=${maskJid(requestedRemoteJid)} ` +
      `discoveredLid=${maskJid(diagnostic.lidJid) || "NONE"} source=${diagnostic.source} ` +
      `sendTo=${maskJid(requestedRemoteJid)}`
  );

  // PONTO CENTRAL DA v0.3.4:
  // enviamos para o PN original, não para o LID descoberto por USync.
  const result = await originalSendText.call(this, {
    remoteJid: requestedRemoteJid,
    text,
  });

  return {
    ...result,
    requestedRemoteJid,
    routedRemoteJid: requestedRemoteJid,
    discoveredLidJid: diagnostic.lidJid,
    lidRouting: "pn_passthrough",
    lidDiagnosticSource: diagnostic.source,
  };
};

console.log("[MEK] v0.3.4 PN Passthrough Diagnostic Hotfix carregado.");
