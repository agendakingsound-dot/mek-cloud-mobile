import { WhatsAppManager } from "./whatsapp.js";

// ============================================================
// MEK Cloud Mobile v0.4.0
// CONTROLLED DRY RUN
//
// MEK_DRY_RUN=1:
// - servidor inicia
// - PostgreSQL pode ser testado
// - schema pode ser testado
// - API pode ser testada
// - Baileys pode ser carregado
// - NENHUM socket do WhatsApp será aberto
// ============================================================

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(
    String(value || "").trim()
  );
}

const DRY_RUN = isEnabled(process.env.MEK_DRY_RUN);

if (DRY_RUN) {

  const originalGetPublicStatus =
    WhatsAppManager.prototype.getPublicStatus;

  const originalGetAdminStatus =
    WhatsAppManager.prototype.getAdminStatus;


  WhatsAppManager.prototype.initialize =
    async function initializeDryRun() {

      this.socket = null;
      this.status = "DRY_RUN";

      this.qrDataUrl = null;
      this.qrGeneratedAt = null;

      this.lastDisconnectReason =
        "MEK_DRY_RUN";

      console.log(
        `[MEK][DRY-RUN] WhatsApp bloqueado para session=${
          this?.authStore?.sessionId || "primary"
        }.`
      );

      if (typeof this.getAdminStatus === "function") {
        return this.getAdminStatus();
      }

      return this.getPublicStatus();
    };


  WhatsAppManager.prototype.connect =
    async function connectDryRun() {

      this.socket = null;
      this.status = "DRY_RUN";

      const error = new Error(
        "Conexao com WhatsApp bloqueada porque MEK_DRY_RUN esta habilitado."
      );

      error.code = "MEK_DRY_RUN_BLOCKED";

      throw error;
    };


  WhatsAppManager.prototype.getPublicStatus =
    function getPublicStatusDryRun() {

      const base =
        originalGetPublicStatus.call(this);

      return {
        ...base,

        status: "DRY_RUN",

        connected: false,

        qrAvailable: false,

        reconnecting: false,

        dryRun: true,

        socketBlocked: true
      };
    };


  if (
    typeof originalGetAdminStatus === "function"
  ) {

    WhatsAppManager.prototype.getAdminStatus =
      function getAdminStatusDryRun() {

        const base =
          originalGetAdminStatus.call(this);

        return {
          ...base,

          status: "DRY_RUN",

          connected: false,

          qrAvailable: false,

          reconnecting: false,

          dryRun: true,

          socketBlocked: true
        };
      };
  }


  console.log(
    "[MEK] v0.4.0 Controlled Dry Run carregado (WhatsApp DESABILITADO)."
  );

} else {

  console.log(
    "[MEK] v0.4.0 Controlled Dry Run desativado."
  );
}
