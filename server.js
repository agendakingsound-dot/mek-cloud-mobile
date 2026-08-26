import crypto from "crypto";
import express from "express";
import { createPool, databaseStatus, ensureSchema } from "./db.js";
import { PostgresAuthStore } from "./auth-store.js";
import { WhatsAppManager } from "./whatsapp.js";

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
const SESSION_ID = String(process.env.WHATSAPP_SESSION_ID || "primary");
const startedAt = new Date();
const pool = createPool();
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

function uptimeSeconds() { return Math.floor((Date.now() - startedAt.getTime()) / 1000); }
function constantTimeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "ADMIN_TOKEN_NOT_CONFIGURED", message: "Defina ADMIN_TOKEN no Secret Group/Environment da Northflank." });
  const authorization = req.get("authorization") || "";
  const expected = `Bearer ${ADMIN_TOKEN}`;
  if (!constantTimeEqual(authorization, expected)) return res.status(401).json({ error: "UNAUTHORIZED" });
  next();
}

async function bootstrapDatabaseAndWhatsApp() {
  if (!pool) { schemaReady = false; return; }
  try {
    await ensureSchema(pool);
    schemaReady = true;
    if (!whatsappReady) {
      const authStore = new PostgresAuthStore(pool, SESSION_ID);
      whatsapp = new WhatsAppManager(pool, authStore);
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
    bootstrapDatabaseAndWhatsApp().catch((error) => console.error("[BOOTSTRAP][RETRY]", error.message));
  }
}, 15000).unref();

app.get("/health", async (_req, res) => {
  const database = await databaseStatus(pool);
  res.status(database.connected ? 200 : 503).json({ service: "MEK Cloud Mobile", version: "0.2.0", engine: "ONLINE", database, schemaReady, uptimeSeconds: uptimeSeconds(), timestamp: new Date().toISOString() });
});

app.get("/api/status", async (_req, res) => {
  const database = await databaseStatus(pool);
  res.json({
    name: "MEK Cloud Mobile",
    version: "0.2.0",
    engine: { status: "ONLINE", uptimeSeconds: uptimeSeconds() },
    database,
    whatsapp: whatsapp ? whatsapp.getPublicStatus() : { status: "INITIALIZING", connected: false, qrAvailable: false, reconnecting: false, lastConnectedAt: null },
    adminConfigured: Boolean(ADMIN_TOKEN),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/admin/verify", requireAdmin, (_req, res) => res.json({ ok: true }));
app.get("/api/whatsapp/admin-status", requireAdmin, (_req, res) => {
  if (!whatsapp) return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  res.json(whatsapp.getAdminStatus());
});
app.get("/api/whatsapp/qr", requireAdmin, (_req, res) => {
  if (!whatsapp) return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  res.json(whatsapp.getQr());
});
app.post("/api/whatsapp/connect", requireAdmin, async (_req, res) => {
  if (!whatsapp) return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  try { res.json(await whatsapp.connect()); }
  catch (error) {
    console.error("[WHATSAPP][CONNECT]", error.message);
    res.status(500).json({ error: "WHATSAPP_CONNECT_FAILED", message: "Não foi possível iniciar a conexão com o WhatsApp." });
  }
});
app.post("/api/whatsapp/logout", requireAdmin, async (_req, res) => {
  if (!whatsapp) return res.status(503).json({ error: "WHATSAPP_NOT_READY" });
  try { res.json(await whatsapp.logoutAndClear()); }
  catch (error) {
    console.error("[WHATSAPP][LOGOUT]", error.message);
    res.status(500).json({ error: "WHATSAPP_LOGOUT_FAILED" });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>MEK Cloud Mobile</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b1020;color:#eef2ff;font-family:Arial,Helvetica,sans-serif;padding:24px}.wrap{width:min(760px,100%);margin:0 auto}.card{background:#121a2f;border:1px solid #283554;border-radius:18px;padding:26px;box-shadow:0 18px 60px rgba(0,0,0,.35);margin-bottom:18px}h1{margin:0 0 6px;font-size:28px}h2{margin:0 0 18px;font-size:19px}.subtitle{margin:0;color:#9eabc7}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid #25304a}.row:first-of-type{border-top:0}.label{font-weight:700}.status{font-weight:800;letter-spacing:.3px;padding:7px 10px;border-radius:999px;font-size:12px;text-align:center}.ok{background:#123b2b;color:#7df1b1}.warn{background:#4b3512;color:#ffd782}.off{background:#3b2430;color:#ff9ab8}.neutral{background:#25304a;color:#bdc8de}.controls{display:grid;gap:10px;margin-top:16px}input{width:100%;border:1px solid #354566;border-radius:11px;padding:13px;font-size:16px;background:#0d1427;color:#fff;outline:none}button{border:0;border-radius:11px;padding:13px 16px;font-size:15px;font-weight:800;cursor:pointer}.primary{background:#e8ecff;color:#111827}.danger{background:#4b1f2b;color:#ffb2c7}button:disabled{opacity:.45;cursor:not-allowed}.qr{width:min(360px,100%);margin:18px auto 0;display:none;border-radius:14px;background:#fff;padding:10px}.message{margin-top:14px;min-height:22px;color:#aab6ce;line-height:1.5;font-size:14px}.small{color:#7f8da9;font-size:12px;line-height:1.55;margin-top:18px}code{color:#c2ceff}
</style></head><body><main class="wrap">
<section class="card"><h1>MEK CLOUD MOBILE</h1><p class="subtitle">WhatsApp Engine · v0.2.0</p>
<div class="row"><span class="label">Engine</span><span id="engineStatus" class="status neutral">CARREGANDO</span></div>
<div class="row"><span class="label">Database</span><span id="databaseStatus" class="status neutral">CARREGANDO</span></div>
<div class="row"><span class="label">WhatsApp</span><span id="whatsappStatus" class="status neutral">CARREGANDO</span></div></section>
<section class="card"><h2>Controle administrativo</h2><div class="controls">
<input id="adminToken" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">
<button id="saveToken" class="primary">USAR TOKEN NESTA SESSÃO</button>
<button id="connectButton" class="primary" disabled>CONECTAR WHATSAPP</button>
<button id="logoutButton" class="danger" disabled>DESCONECTAR E APAGAR SESSÃO</button>
</div><img id="qrImage" class="qr" alt="QR Code WhatsApp"><div id="message" class="message"></div>
<div class="small">O token fica somente nesta aba do navegador via <code>sessionStorage</code>.<br>Para conectar: WhatsApp → Aparelhos conectados → Conectar um aparelho.</div></section>
</main><script>
const tokenInput=document.getElementById("adminToken"),saveTokenButton=document.getElementById("saveToken"),connectButton=document.getElementById("connectButton"),logoutButton=document.getElementById("logoutButton"),qrImage=document.getElementById("qrImage"),messageBox=document.getElementById("message"),engineStatus=document.getElementById("engineStatus"),databaseStatus=document.getElementById("databaseStatus"),whatsappStatus=document.getElementById("whatsappStatus");
function setBadge(e,t,k){e.textContent=t;e.className="status "+k}function setMessage(t){messageBox.textContent=t||""}function getToken(){return sessionStorage.getItem("mekAdminToken")||""}function authHeaders(){const t=getToken();return t?{Authorization:"Bearer "+t}:{}}
async function api(url,options={}){const response=await fetch(url,{...options,headers:{...(options.headers||{}),...authHeaders()},cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.message||data.error||"Falha na requisição.");error.status=response.status;throw error}return data}
async function refreshPublicStatus(){try{const d=await api("/api/status");setBadge(engineStatus,"ONLINE","ok");d.database?.connected?setBadge(databaseStatus,"CONNECTED","ok"):setBadge(databaseStatus,d.database?.status||"ERROR","warn");const w=d.whatsapp||{},s=w.status||"UNKNOWN";w.connected?setBadge(whatsappStatus,"CONNECTED","ok"):["CONNECTING","QR","RECONNECTING"].includes(s)?setBadge(whatsappStatus,s,"warn"):setBadge(whatsappStatus,s,"off");if(!d.adminConfigured){connectButton.disabled=true;logoutButton.disabled=true;setMessage("ADMIN_TOKEN ainda não foi configurado na Northflank.")}}catch{setBadge(engineStatus,"ERROR","off")}}
async function verifyAdmin(){const t=getToken();if(!t){connectButton.disabled=true;logoutButton.disabled=true;return false}try{await api("/api/admin/verify");connectButton.disabled=false;logoutButton.disabled=false;setMessage("Acesso administrativo autorizado.");return true}catch(e){connectButton.disabled=true;logoutButton.disabled=true;setMessage(e.status===503?"ADMIN_TOKEN ainda não foi configurado na Northflank.":"Token administrativo inválido.");return false}}
async function refreshAdminStatus(){if(!getToken()){qrImage.style.display="none";return}try{const s=await api("/api/whatsapp/admin-status");if(s.connected){qrImage.style.display="none";setMessage("WhatsApp conectado"+(s.phone?" · "+s.phone:"")+". Sessão persistida no PostgreSQL.");return}if(s.qrAvailable){const q=await api("/api/whatsapp/qr");if(q.available&&q.dataUrl){qrImage.src=q.dataUrl;qrImage.style.display="block";setMessage("Escaneie o QR Code no WhatsApp → Aparelhos conectados.")}}else{qrImage.style.display="none";if(s.status==="RECONNECTING")setMessage("Reconectando automaticamente ao WhatsApp...")}}catch(e){if(e.status===401)qrImage.style.display="none"}}
saveTokenButton.addEventListener("click",async()=>{const t=tokenInput.value.trim();if(!t){setMessage("Digite o ADMIN_TOKEN.");return}sessionStorage.setItem("mekAdminToken",t);tokenInput.value="";await verifyAdmin();await refreshAdminStatus()});
connectButton.addEventListener("click",async()=>{connectButton.disabled=true;setMessage("Iniciando conexão com o WhatsApp...");try{await api("/api/whatsapp/connect",{method:"POST"});await refreshPublicStatus();await refreshAdminStatus()}catch(e){setMessage(e.message)}finally{connectButton.disabled=false}});
logoutButton.addEventListener("click",async()=>{if(!window.confirm("Isso desconectará o WhatsApp e apagará a sessão persistida. Continuar?"))return;logoutButton.disabled=true;try{await api("/api/whatsapp/logout",{method:"POST"});qrImage.style.display="none";setMessage("Sessão do WhatsApp removida.");await refreshPublicStatus()}catch(e){setMessage(e.message)}finally{logoutButton.disabled=false}});
async function tick(){await refreshPublicStatus();await refreshAdminStatus()}verifyAdmin();tick();setInterval(tick,2500);
</script></body></html>`);
});

app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MEK] Cloud Mobile v0.2.0 online na porta ${PORT}`);
  console.log(`[MEK] DATABASE_URL: ${pool ? "configurada" : "não configurada"}`);
  console.log(`[MEK] ADMIN_TOKEN: ${ADMIN_TOKEN ? "configurado" : "não configurado"}`);
});

async function gracefulShutdown(signal) {
  console.log(`[MEK] Encerrando por ${signal}...`);
  try { await pool?.end(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
