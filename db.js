import pg from "pg";

const { Pool } = pg;

export function createPool() {
  const databaseUrl = process.env.DATABASE_URL || "";

  if (!databaseUrl) {
    return null;
  }

  return new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
}

export async function ensureSchema(pool) {
  if (!pool) {
    throw new Error("DATABASE_URL não configurada.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mek_whatsapp_auth_creds (
      session_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mek_whatsapp_auth_keys (
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      key_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, category, key_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mek_whatsapp_state (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'DISCONNECTED',
      phone TEXT,
      display_name TEXT,
      last_connected_at TIMESTAMPTZ,
      last_disconnect_reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_mek_whatsapp_auth_keys_session_category
    ON mek_whatsapp_auth_keys (session_id, category)
  `);
}

export async function databaseStatus(pool) {
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
