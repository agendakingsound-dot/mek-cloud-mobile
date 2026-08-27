import { WhatsAppManager } from "./whatsapp.js";

// MEK Cloud Mobile v0.3.5 - Single Session Lock Hotfix
// Garante que apenas um pod/processo por vez opere uma mesma sessão WhatsApp.
// O lock é mantido em uma conexão PostgreSQL dedicada usando advisory lock.
// Quando uma implantação nova sobe durante um rolling deploy, ela aguarda o
// pod antigo liberar o lock antes de abrir um novo socket Baileys.

const LOCK_NAMESPACE = "mek_whatsapp_single_session_v1";
const RETRY_DELAY_MS = 5000;
const HEARTBEAT_MS = 10000;

const managerStates = new WeakMap();
const poolStates = new WeakMap();

const originalInitialize = WhatsAppManager.prototype.initialize;
const originalConnect = WhatsAppManager.prototype.connect;
const originalGetPublicStatus = WhatsAppManager.prototype.getPublicStatus;

function getInstanceId() {
  return String(process.env.HOSTNAME || `pid-${process.pid}`);
}

function getState(manager) {
  let state = managerStates.get(manager);

  if (!state) {
    state = {
      client: null,
      clientErrorHandler: null,
      held: false,
      waiting: false,
      acquiring: null,
      retryTimer: null,
      heartbeatTimer: null,
      shuttingDown: false,
      lastDeniedLogAt: 0,
    };
    managerStates.set(manager, state);
  }

  return state;
}

function lockLabel(manager) {
  return `session=${manager?.authStore?.sessionId || "primary"} instance=${getInstanceId()}`;
}

function clearRetryTimer(state) {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function clearHeartbeat(state) {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function stopSocketForHandoff(manager, reason = "SESSION_HANDOFF") {
  try { manager.clearReconnectTimer?.(); } catch {}
  try { manager.clearQr?.(); } catch {}

  // Invalida listeners do socket atual antes de fechá-lo. Assim, um evento
  // connection.close tardio não agenda nova reconexão durante o handoff.
  manager.generation = Number(manager.generation || 0) + 1;

  const sock = manager.socket;
  manager.socket = null;
  manager.status = "WAITING_LOCK";

  if (sock) {
    try {
      sock.end?.(new Error(reason));
    } catch {
      try { sock.ws?.close?.(); } catch {}
    }
  }
}

async function releaseLock(manager, { forShutdown = false } = {}) {
  const state = getState(manager);
  clearRetryTimer(state);
  clearHeartbeat(state);

  if (forShutdown) {
    state.shuttingDown = true;
  }

  const client = state.client;
  const handler = state.clientErrorHandler;
  state.client = null;
  state.clientErrorHandler = null;
  state.held = false;
  state.waiting = false;

  if (!client) return;

  if (handler) {
    try { client.removeListener("error", handler); } catch {}
  }

  try {
    const result = await client.query(
      `SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released`,
      [LOCK_NAMESPACE, manager.authStore.sessionId]
    );
    console.log(
      `[SESSION-LOCK][RELEASED] ${lockLabel(manager)} released=${Boolean(result.rows?.[0]?.released)}`
    );
    client.release();
  } catch (error) {
    console.error(`[SESSION-LOCK][RELEASE_ERROR] ${lockLabel(manager)} ${error?.message || error}`);
    try { client.release(true); } catch {}
  }
}

async function handleLockLoss(manager, client, error) {
  const state = getState(manager);
  if (state.client !== client || state.shuttingDown) return;

  console.error(`[SESSION-LOCK][LOST] ${lockLabel(manager)} ${error?.message || error}`);

  clearHeartbeat(state);
  state.client = null;
  state.clientErrorHandler = null;
  state.held = false;
  state.waiting = true;

  stopSocketForHandoff(manager, "SESSION_LOCK_LOST");
  try { client.release(true); } catch {}

  scheduleLockRetry(manager);
}

function startHeartbeat(manager, client) {
  const state = getState(manager);
  clearHeartbeat(state);

  state.heartbeatTimer = setInterval(() => {
    if (!state.held || state.client !== client || state.shuttingDown) return;

    client.query("SELECT 1")
      .catch((error) => handleLockLoss(manager, client, error));
  }, HEARTBEAT_MS);

  state.heartbeatTimer.unref?.();
}

async function tryAcquireLock(manager) {
  const state = getState(manager);

  if (state.shuttingDown) return false;
  if (state.held && state.client) return true;
  if (state.acquiring) return state.acquiring;

  state.acquiring = (async () => {
    let client = null;

    try {
      client = await manager.pool.connect();
      const result = await client.query(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired`,
        [LOCK_NAMESPACE, manager.authStore.sessionId]
      );

      const acquired = Boolean(result.rows?.[0]?.acquired);

      if (!acquired) {
        client.release();
        state.waiting = true;
        manager.status = "WAITING_LOCK";

        const now = Date.now();
        if (now - state.lastDeniedLogAt >= 15000) {
          state.lastDeniedLogAt = now;
          console.log(`[SESSION-LOCK][DENIED] ${lockLabel(manager)} aguardando o pod ativo liberar a sessão.`);
        }
        return false;
      }

      const onClientError = (error) => {
        handleLockLoss(manager, client, error).catch((innerError) => {
          console.error(`[SESSION-LOCK][LOSS_HANDLER] ${innerError?.message || innerError}`);
        });
      };

      client.on("error", onClientError);
      state.client = client;
      state.clientErrorHandler = onClientError;
      state.held = true;
      state.waiting = false;
      state.lastDeniedLogAt = 0;

      startHeartbeat(manager, client);
      console.log(`[SESSION-LOCK][ACQUIRED] ${lockLabel(manager)}`);
      return true;
    } catch (error) {
      if (client) {
        try { client.release(true); } catch {}
      }
      state.waiting = true;
      manager.status = "WAITING_LOCK";
      console.error(`[SESSION-LOCK][ACQUIRE_ERROR] ${lockLabel(manager)} ${error?.message || error}`);
      return false;
    } finally {
      state.acquiring = null;
    }
  })();

  return state.acquiring;
}

function scheduleLockRetry(manager) {
  const state = getState(manager);
  if (state.shuttingDown || state.held || state.retryTimer) return;

  state.waiting = true;
  manager.status = "WAITING_LOCK";

  state.retryTimer = setTimeout(async () => {
    state.retryTimer = null;
    if (state.shuttingDown || state.held) return;

    const acquired = await tryAcquireLock(manager);

    if (!acquired) {
      scheduleLockRetry(manager);
      return;
    }

    try {
      console.log(`[SESSION-LOCK][HANDOFF] ${lockLabel(manager)} sessão liberada; iniciando WhatsApp.`);
      await originalInitialize.call(manager);
    } catch (error) {
      console.error(`[SESSION-LOCK][INIT_ERROR] ${lockLabel(manager)} ${error?.message || error}`);
      stopSocketForHandoff(manager, "SESSION_INIT_ERROR");
      await releaseLock(manager);
      scheduleLockRetry(manager);
    }
  }, RETRY_DELAY_MS);

  state.retryTimer.unref?.();
}

function registerPoolShutdown(manager) {
  const pool = manager.pool;
  if (!pool) return;

  let poolState = poolStates.get(pool);

  if (!poolState) {
    const originalEnd = pool.end.bind(pool);
    poolState = {
      managers: new Set(),
      ending: null,
      originalEnd,
    };
    poolStates.set(pool, poolState);

    pool.end = async (...args) => {
      if (poolState.ending) return poolState.ending;

      poolState.ending = (async () => {
        for (const item of poolState.managers) {
          const state = getState(item);
          state.shuttingDown = true;
          clearRetryTimer(state);
          stopSocketForHandoff(item, "PROCESS_SHUTDOWN");
          await releaseLock(item, { forShutdown: true });
        }

        return poolState.originalEnd(...args);
      })();

      return poolState.ending;
    };
  }

  poolState.managers.add(manager);
}

WhatsAppManager.prototype.initialize = async function initializeWithSingleSessionLock() {
  registerPoolShutdown(this);

  const acquired = await tryAcquireLock(this);

  if (!acquired) {
    scheduleLockRetry(this);
    return this.getAdminStatus();
  }

  try {
    return await originalInitialize.call(this);
  } catch (error) {
    console.error(`[SESSION-LOCK][INIT_ERROR] ${lockLabel(this)} ${error?.message || error}`);
    stopSocketForHandoff(this, "SESSION_INIT_ERROR");
    await releaseLock(this);
    scheduleLockRetry(this);
    return this.getAdminStatus();
  }
};

WhatsAppManager.prototype.connect = async function connectWithSingleSessionLock() {
  registerPoolShutdown(this);

  const acquired = await tryAcquireLock(this);

  if (!acquired) {
    scheduleLockRetry(this);
    const error = new Error("A sessão WhatsApp está sendo operada por outra instância.");
    error.code = "WHATSAPP_SESSION_LOCKED";
    throw error;
  }

  return originalConnect.call(this);
};

WhatsAppManager.prototype.getPublicStatus = function getPublicStatusWithSessionLock() {
  const base = originalGetPublicStatus.call(this);
  const state = getState(this);

  return {
    ...base,
    sessionLock: state.held ? "ACQUIRED" : state.waiting ? "WAITING" : "IDLE",
  };
};

console.log("[MEK] v0.3.5 Single Session Lock Hotfix carregado.");
