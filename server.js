import express from "express";
import pg from "pg";

const { Pool } = pg;
const app = express();

const PORT = Number(process.env.PORT || 8080);
const startedAt = new Date();
const databaseUrl = process.env.DATABASE_URL || "";

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    })
  : null;

async function getDatabaseStatus() {
  if (!pool) {
    return {
      connected: false,
      status: "NOT_CONFIGURED",
      message: "DATABASE_URL não foi encontrada no ambiente.",
    };
  }

  try {
    const result = await pool.query("SELECT NOW() AS now");
    return {
      connected: true,
      status: "CONNECTED",
      serverTime: result.rows[0].now,
    };
  } catch (error) {
    console.error("[DATABASE]", error.message);
    return {
      connected: false,
      status: "ERROR",
      message: "Falha ao conectar ao PostgreSQL.",
    };
  }
}

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt.getTime()) / 1000);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  const database = await getDatabaseStatus();
  res.status(database.connected ? 200 : 503).json({
    service: "MEK Cloud Mobile",
    engine: "ONLINE",
    database,
    uptimeSeconds: uptimeSeconds(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/status", async (_req, res) => {
  const database = await getDatabaseStatus();
  res.json({
    name: "MEK Cloud Mobile",
    version: "0.1.0",
    engine: {
      status: "ONLINE",
      uptimeSeconds: uptimeSeconds(),
    },
    database,
    whatsapp: {
      status: "NOT_CONNECTED",
      mode: "pending",
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/", async (_req, res) => {
  const database = await getDatabaseStatus();
  const dbClass = database.connected ? "ok" : "warn";
  const dbText = database.connected ? "CONNECTED" : database.status;

  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>MEK Cloud Mobile</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0b1020;
      color: #eef2ff;
      font-family: Arial, Helvetica, sans-serif;
      padding: 24px;
    }
    .card {
      width: min(620px, 100%);
      background: #121a2f;
      border: 1px solid #283554;
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 18px 60px rgba(0,0,0,.35);
    }
    h1 { margin: 0 0 6px; font-size: 28px; }
    .subtitle { margin: 0 0 26px; color: #9eabc7; }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 15px 0;
      border-top: 1px solid #25304a;
    }
    .label { font-weight: 700; }
    .status {
      font-weight: 800;
      letter-spacing: .4px;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 13px;
    }
    .ok { background: #123b2b; color: #7df1b1; }
    .warn { background: #4b3512; color: #ffd782; }
    .off { background: #3b2430; color: #ff9ab8; }
    .footer {
      color: #7f8da9;
      font-size: 12px;
      margin-top: 22px;
      line-height: 1.5;
    }
    code { color: #b8c7ff; }
  </style>
</head>
<body>
  <main class="card">
    <h1>MEK CLOUD MOBILE</h1>
    <p class="subtitle">Engine inicial online 24/7</p>

    <div class="row">
      <span class="label">Engine</span>
      <span class="status ok">ONLINE</span>
    </div>

    <div class="row">
      <span class="label">Database</span>
      <span class="status ${dbClass}">${dbText}</span>
    </div>

    <div class="row">
      <span class="label">WhatsApp</span>
      <span class="status off">NOT CONNECTED</span>
    </div>

    <div class="footer">
      Versão 0.1.0 · atualização automática a cada 15 segundos<br>
      API de status: <code>/api/status</code> · Health check: <code>/health</code>
    </div>
  </main>
</body>
</html>`);
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MEK] Cloud Mobile online na porta ${PORT}`);
  console.log(`[MEK] DATABASE_URL: ${databaseUrl ? "configurada" : "não configurada"}`);
});

process.on("SIGTERM", async () => {
  console.log("[MEK] Encerrando...");
  if (pool) await pool.end();
  process.exit(0);
});
