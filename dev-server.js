import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onRequestPost as checkoutHandler } from "./functions/api/checkout.js";
import { onRequestPost as webhookHandler } from "./functions/api/webhook.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8788;

// Simulação de KV Namespace em memória
class DevKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
  async delete(key) {
    this.store.delete(key);
  }
}

// Carrega .dev.vars
async function loadDevVars() {
  const env = { ORDERS: new DevKV() };
  try {
    const raw = await fs.readFile(path.join(__dirname, ".dev.vars"), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        env[k] = v;
      }
    }
  } catch {
    console.warn("Arquivo .dev.vars não encontrado. Usando variáveis padrão.");
  }
  return env;
}

const env = await loadDevVars();

// Intercepta chamadas de fetch simuladas caso as chaves sejam simuladas
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const urlStr = String(url);

  // Simulação amigável da PinPay quando a chave for simulada
  if (urlStr.includes("api.usepinpay.com") && env.PINPAY_SECRET_KEY?.includes("simulado")) {
    const body = options.body ? JSON.parse(options.body) : {};
    console.log("\n[DEV MOCK PinPay] Checkout criado para:", body.customer?.email, "- Valor:", body.amount, "centavos");
    console.log("[DEV MOCK PinPay] external_reference:", body.external_reference);
    return new Response(
      JSON.stringify({
        checkout_url: body.success_url || `/obrigado.html?ref=${body.external_reference}`,
        id: "chk_mock_123",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Simulação amigável do Resend quando a chave for simulada
  if (urlStr.includes("resend.com/emails") && env.RESEND_API_KEY?.includes("simulado")) {
    const body = options.body ? JSON.parse(options.body) : {};
    console.log("\n================ [EMAIL ENVIADO VIA RESEND (SIMULADO)] ================");
    console.log("Para:", body.to);
    console.log("Remetente:", body.from);
    console.log("Assunto:", body.subject);
    console.log("Texto do email:\n" + body.text);
    console.log("=======================================================================\n");
    return new Response(JSON.stringify({ id: "msg_mock_resend_999" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return originalFetch(url, options);
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = parsedUrl.pathname;

  console.log(`${req.method} ${pathname}`);

  // Trata rotas de API do Cloudflare Functions
  if (pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);
    const bodyText = bodyBuffer.toString("utf-8");

    const webHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        for (const val of v) webHeaders.append(k, val);
      } else if (v) {
        webHeaders.set(k, v);
      }
    }

    const webRequest = new Request(parsedUrl.toString(), {
      method: req.method,
      headers: webHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyText,
    });

    let webResponse;
    if (pathname === "/api/checkout" && req.method === "POST") {
      webResponse = await checkoutHandler({ request: webRequest, env });
    } else if (pathname === "/api/webhook" && req.method === "POST") {
      webResponse = await webhookHandler({ request: webRequest, env });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint não encontrado" }));
      return;
    }

    res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
    const responseText = await webResponse.text();
    res.end(responseText);
    return;
  }

  // Roteamento de arquivos estáticos
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(__dirname, pathname);

  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Página não encontrada");
  }
});

server.listen(PORT, () => {
  console.log(`\n🎄 Servidor de desenvolvimento rodando em: http://localhost:${PORT}`);
  console.log(`Landing page:  http://localhost:${PORT}/`);
  console.log(`Obrigado:      http://localhost:${PORT}/obrigado.html`);
  console.log(`API Checkout:  http://localhost:${PORT}/api/checkout`);
  console.log(`API Webhook:   http://localhost:${PORT}/api/webhook\n`);
});

