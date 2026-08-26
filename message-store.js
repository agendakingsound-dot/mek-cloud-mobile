import crypto from "crypto";

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizePhone(value) {
  let digits = cleanDigits(value);

  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) {
    digits = `55${digits}`;
  }

  if (digits.length < 10 || digits.length > 15) {
    throw new Error("INVALID_PHONE_NUMBER");
  }

  return digits;
}

export function phoneToJid(phone) {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

export function generateRequestId() {
  return `mek-${crypto.randomUUID()}`;
}

export class MessageStore {
  constructor(pool) {
    this.pool = pool;
  }

  async reserveOutbound({ requestId, phone, remoteJid, content }) {
    const id = requestId || generateRequestId();

    const inserted = await this.pool.query(
      `INSERT INTO mek_whatsapp_messages
        (request_id, direction, remote_jid, phone, message_type, content, status, created_at, updated_at)
       VALUES ($1, 'OUTBOUND', $2, $3, 'TEXT', $4, 'PENDING', NOW(), NOW())
       ON CONFLICT (request_id) DO NOTHING
       RETURNING *`,
      [id, remoteJid, phone, content]
    );

    if (inserted.rows[0]) {
      return { message: inserted.rows[0], duplicate: false };
    }

    const existing = await this.getByRequestId(id);
    return { message: existing, duplicate: true };
  }

  async markSent(requestId, whatsappMessageId, rawPayload = null) {
    const result = await this.pool.query(
      `UPDATE mek_whatsapp_messages
       SET status = 'SENT',
           whatsapp_message_id = COALESCE($2, whatsapp_message_id),
           raw_payload = COALESCE($3::jsonb, raw_payload),
           sent_at = COALESCE(sent_at, NOW()),
           updated_at = NOW(),
           error_code = NULL,
           error_message = NULL
       WHERE request_id = $1
       RETURNING *`,
      [requestId, whatsappMessageId || null, rawPayload ? JSON.stringify(rawPayload) : null]
    );
    return result.rows[0] || null;
  }

  async markError(requestId, error) {
    const errorCode = String(error?.code || error?.name || "SEND_ERROR").slice(0, 100);
    const errorMessage = String(error?.message || "Falha ao enviar mensagem.").slice(0, 1000);

    const result = await this.pool.query(
      `UPDATE mek_whatsapp_messages
       SET status = 'ERROR',
           error_code = $2,
           error_message = $3,
           updated_at = NOW()
       WHERE request_id = $1
       RETURNING *`,
      [requestId, errorCode, errorMessage]
    );
    return result.rows[0] || null;
  }

  async recordInbound({ remoteJid, phone, whatsappMessageId, messageType, content, rawPayload }) {
    const result = await this.pool.query(
      `INSERT INTO mek_whatsapp_messages
        (direction, remote_jid, phone, whatsapp_message_id, message_type, content, status, raw_payload, received_at, created_at, updated_at)
       VALUES ('INBOUND', $1, $2, $3, $4, $5, 'RECEIVED', $6::jsonb, NOW(), NOW(), NOW())
       ON CONFLICT (whatsapp_message_id) DO NOTHING
       RETURNING *`,
      [
        remoteJid,
        phone || null,
        whatsappMessageId || null,
        messageType || "UNKNOWN",
        content || null,
        JSON.stringify(rawPayload || {}),
      ]
    );
    return result.rows[0] || null;
  }

  async updateDeliveryByWhatsAppId(whatsappMessageId, status) {
    if (!whatsappMessageId || !status) return null;

    const result = await this.pool.query(
      `UPDATE mek_whatsapp_messages
       SET status = $2,
           delivered_at = CASE WHEN $2 IN ('DELIVERED','READ','PLAYED') THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
           read_at = CASE WHEN $2 IN ('READ','PLAYED') THEN COALESCE(read_at, NOW()) ELSE read_at END,
           updated_at = NOW()
       WHERE whatsapp_message_id = $1
       RETURNING *`,
      [whatsappMessageId, status]
    );
    return result.rows[0] || null;
  }

  async getByRequestId(requestId) {
    const result = await this.pool.query(
      `SELECT * FROM mek_whatsapp_messages WHERE request_id = $1 LIMIT 1`,
      [requestId]
    );
    return result.rows[0] || null;
  }

  async list({ phone = null, direction = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const values = [];
    const clauses = [];

    if (phone) {
      values.push(normalizePhone(phone));
      clauses.push(`phone = $${values.length}`);
    }

    if (direction) {
      const normalizedDirection = String(direction).toUpperCase();
      if (["INBOUND", "OUTBOUND"].includes(normalizedDirection)) {
        values.push(normalizedDirection);
        clauses.push(`direction = $${values.length}`);
      }
    }

    values.push(safeLimit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const result = await this.pool.query(
      `SELECT id, request_id, direction, phone, remote_jid, whatsapp_message_id,
              message_type, content, status, error_code, error_message,
              created_at, sent_at, received_at, delivered_at, read_at, updated_at
       FROM mek_whatsapp_messages
       ${where}
       ORDER BY id DESC
       LIMIT $${values.length}`,
      values
    );

    return result.rows;
  }
}
