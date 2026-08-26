import {
  BufferJSON,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";

export class PostgresAuthStore {
  constructor(pool, sessionId = "primary") {
    this.pool = pool;
    this.sessionId = sessionId;
  }

  serialize(value) {
    return JSON.stringify(value, BufferJSON.replacer);
  }

  deserialize(value) {
    return JSON.parse(value, BufferJSON.reviver);
  }

  async hasRegisteredCreds() {
    const result = await this.pool.query(
      `SELECT payload
       FROM mek_whatsapp_auth_creds
       WHERE session_id = $1`,
      [this.sessionId]
    );

    if (!result.rowCount) {
      return false;
    }

    try {
      const creds = this.deserialize(result.rows[0].payload);
      return Boolean(creds?.registered);
    } catch {
      return false;
    }
  }

  async load() {
    const credsResult = await this.pool.query(
      `SELECT payload
       FROM mek_whatsapp_auth_creds
       WHERE session_id = $1`,
      [this.sessionId]
    );

    const creds = credsResult.rowCount
      ? this.deserialize(credsResult.rows[0].payload)
      : initAuthCreds();

    const keys = {
      get: async (type, ids) => {
        if (!ids?.length) {
          return {};
        }

        const result = await this.pool.query(
          `SELECT key_id, payload
           FROM mek_whatsapp_auth_keys
           WHERE session_id = $1
             AND category = $2
             AND key_id = ANY($3::text[])`,
          [this.sessionId, type, ids]
        );

        const data = {};

        for (const row of result.rows) {
          let value = this.deserialize(row.payload);

          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }

          data[row.key_id] = value;
        }

        return data;
      },

      set: async (data) => {
        const client = await this.pool.connect();

        try {
          await client.query("BEGIN");

          for (const category of Object.keys(data || {})) {
            const entries = data[category] || {};

            for (const [keyId, value] of Object.entries(entries)) {
              if (value === null || typeof value === "undefined") {
                await client.query(
                  `DELETE FROM mek_whatsapp_auth_keys
                   WHERE session_id = $1
                     AND category = $2
                     AND key_id = $3`,
                  [this.sessionId, category, keyId]
                );
              } else {
                await client.query(
                  `INSERT INTO mek_whatsapp_auth_keys
                    (session_id, category, key_id, payload, updated_at)
                   VALUES ($1, $2, $3, $4, NOW())
                   ON CONFLICT (session_id, category, key_id)
                   DO UPDATE SET
                     payload = EXCLUDED.payload,
                     updated_at = NOW()`,
                  [
                    this.sessionId,
                    category,
                    keyId,
                    this.serialize(value),
                  ]
                );
              }
            }
          }

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },

      clear: async () => {
        await this.clear();
      },
    };

    const saveCreds = async () => {
      await this.pool.query(
        `INSERT INTO mek_whatsapp_auth_creds
          (session_id, payload, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (session_id)
         DO UPDATE SET
           payload = EXCLUDED.payload,
           updated_at = NOW()`,
        [this.sessionId, this.serialize(creds)]
      );
    };

    return {
      state: {
        creds,
        keys,
      },
      saveCreds,
    };
  }

  async clear() {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `DELETE FROM mek_whatsapp_auth_keys WHERE session_id = $1`,
        [this.sessionId]
      );

      await client.query(
        `DELETE FROM mek_whatsapp_auth_creds WHERE session_id = $1`,
        [this.sessionId]
      );

      await client.query(
        `DELETE FROM mek_whatsapp_state WHERE session_id = $1`,
        [this.sessionId]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
