const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const AUTH_PATH = path.resolve(__dirname, "..", ".wwebjs_auth");
const CLIENT_ID = "dating-agent";

let shuttingDown = false;

function projectChromePath() {
  if (process.env.CHROME_EXECUTABLE_PATH && fs.existsSync(process.env.CHROME_EXECUTABLE_PATH)) {
    return process.env.CHROME_EXECUTABLE_PATH;
  }
  const chromeRoot = path.join(__dirname, "..", ".cache", "puppeteer", "chrome");
  if (!fs.existsSync(chromeRoot)) {
    return undefined;
  }
  for (const version of fs.readdirSync(chromeRoot)) {
    const candidate = path.join(
      chromeRoot,
      version,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function chromeExecutablePath() {
  const fromProject = projectChromePath();
  if (fromProject) {
    return fromProject;
  }
  try {
    return require("puppeteer").executablePath();
  } catch {
    return undefined;
  }
}

function classifyIncoming(message, readyAtMs = 0, now = Date.now()) {
  if (!message || message.fromMe || message.id?.fromMe) {
    return null;
  }
  const stamp = Number(message.timestamp);
  if (Number.isFinite(stamp) && stamp * 1000 < readyAtMs) {
    return null;
  }
  if (Number.isFinite(stamp) && stamp * 1000 > now + 300000) {
    return null;
  }
  const from = typeof message.from === "string" ? message.from : "";
  if (from.endsWith("@g.us")) {
    return "group";
  }
  return "private";
}

function createWhatsAppClient() {
  const executablePath = chromeExecutablePath();
  const puppeteer = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };
  if (executablePath) {
    puppeteer.executablePath = executablePath;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: AUTH_PATH }),
    puppeteer,
  });

  let readyAt = 0;

  client.on("qr", (qr) => {
    console.log("");
    console.log("Open WhatsApp → Linked Devices → Link a Device → Scan QR");
    console.log("");
    try {
      qrcode.generate(qr, { small: true });
    } catch (error) {
      console.error("[WhatsApp] Could not render QR in the terminal. Waiting for the next QR.");
    }
  });

  client.on("authenticated", () => {
    console.log("[WhatsApp] Authenticated. Waiting until the client is ready…");
  });

  client.on("ready", () => {
    readyAt = Date.now();
    console.log("[WhatsApp] Connected");
    console.log("WhatsApp connected successfully");
    console.log("[WhatsApp] Status: connected. Session is stored locally with LocalAuth.");
  });

  client.on("auth_failure", (message) => {
    const detail = String(message || "").slice(0, 100);
    console.error("[WhatsApp] Authentication failed.");
    if (detail) {
      console.error(`[WhatsApp] ${detail}`);
    }
    console.error(
      "Recovery: open WhatsApp → Linked Devices, unlink this Mac if it is listed, delete the local .wwebjs_auth folder if needed, then restart and scan a new QR."
    );
  });

  client.on("disconnected", (reason) => {
    readyAt = 0;
    console.log(`[WhatsApp] Disconnected: ${String(reason || "unknown reason").slice(0, 80)}`);
    console.log("[WhatsApp] Restart the application to resume. The client will not retry in a loop.");
  });

  client.on("message", (message) => {
    const kind = classifyIncoming(message, readyAt);
    if (!kind) {
      return;
    }
    console.log(`[WhatsApp] Incoming ${kind} message received`);
  });

  return client;
}

async function startWhatsApp() {
  const client = createWhatsAppClient();

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[WhatsApp] ${signal} received. Shutting down…`);
    try {
      await Promise.race([
        client.destroy(),
        new Promise((resolve) => setTimeout(resolve, 7000)),
      ]);
    } catch (error) {
      console.error("[WhatsApp] Error during shutdown.");
    }
    process.exit(0);
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  console.log("[WhatsApp] Starting client (headless Chromium)…");
  await client.initialize();
  return client;
}

module.exports = {
  createWhatsAppClient,
  startWhatsApp,
  classifyIncoming,
};
