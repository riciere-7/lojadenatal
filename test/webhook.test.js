import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { onRequestPost as webhookHandler } from "../functions/api/webhook.js";
import { onRequestPost as checkoutHandler } from "../functions/api/checkout.js";
import { onRequestGet as adminGetHandler, onRequestPost as adminPostHandler } from "../functions/api/admin.js";

// Implementação simples de simulação de KV da Cloudflare
class MockKV {
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

  async list({ prefix = "" } = {}) {
    const keys = [];
    for (const k of this.store.keys()) {
      if (!prefix || k.startsWith(prefix)) {
        keys.push({ name: k });
      }
    }
    return { keys };
  }
}

// Utilitário para gerar assinatura HMAC-SHA256 hex para os testes
function generateSignature(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("Webhook e Checkout da Loja de Natal", () => {
  let originalFetch;
  let resendCalls;
  let pinpayCalls;
  let mockKV;
  let env;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resendCalls = [];
    pinpayCalls = [];
    mockKV = new MockKV();

    env = {
      PINPAY_SECRET_KEY: "sk_test_123",
      PINPAY_WEBHOOK_SECRET: "whsec_natal_secret_999",
      RESEND_API_KEY: "re_test_key_abc",
      EMAIL_FROM: "contato@lojanatal.com",
      DRIVE_URL_CARTOES: "https://drive.google.com/drive/folders/cartoes_test",
      DRIVE_URL_GUIA: "https://drive.google.com/drive/folders/guia_test",
      DRIVE_URL_KIT: "https://drive.google.com/drive/folders/kit_completo_test",
      ORDERS: mockKV,
    };

    // Mock global de fetch para simular Resend e PinPay sem rede real
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url);

      if (urlStr.includes("resend.com/emails")) {
        const body = options.body ? JSON.parse(options.body) : {};
        resendCalls.push({ url: urlStr, options, body });
        return new Response(JSON.stringify({ id: `msg_${resendCalls.length}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("api.usepinpay.com")) {
        const body = options.body ? JSON.parse(options.body) : {};
        pinpayCalls.push({ url: urlStr, options, body });
        return new Response(
          JSON.stringify({
            checkout_url: "https://pay.usepinpay.com/chk_simulado_123",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      throw new Error(`Chamada inesperada de fetch para: ${urlStr}`);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("1. Assinatura inválida é rejeitada com status 401", async () => {
    const rawBody = JSON.stringify({
      event: "payment_approved",
      external_reference: "NATAL-abc-1",
    });

    const request = new Request("https://site.pages.dev/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "assinatura_completamente_errada",
      },
      body: rawBody,
    });

    const res = await webhookHandler({ request, env });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "Assinatura inválida.");
    assert.equal(resendCalls.length, 0, "Nenhum email deve ser enviado para assinatura inválida.");
  });

  test("1b. Assinatura ausente é rejeitada com status 401", async () => {
    const rawBody = JSON.stringify({
      event: "payment_approved",
      external_reference: "NATAL-abc-2",
    });

    const request = new Request("https://site.pages.dev/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: rawBody,
    });

    const res = await webhookHandler({ request, env });
    assert.equal(res.status, 401);
    assert.equal(resendCalls.length, 0);
  });

  test("2. Evento não aprovado (ex: payment_pending) é ignorado e retorna 200 sem enviar email", async () => {
    const rawBody = JSON.stringify({
      event: "payment_pending",
      external_reference: "NATAL-pendente-1",
      customer: { email: "cliente@teste.com" },
    });

    const signature = generateSignature(env.PINPAY_WEBHOOK_SECRET, rawBody);

    const request = new Request("https://site.pages.dev/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: rawBody,
    });

    const res = await webhookHandler({ request, env });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "ignored");
    assert.equal(resendCalls.length, 0, "Não deve enviar email para evento pending.");
    const delivered = await mockKV.get("delivered:NATAL-pendente-1");
    assert.equal(delivered, null, "Não deve marcar como entregue.");
  });

  test("3. Evento payment_approved gera um único email e grava no KV", async () => {
    const ref = "NATAL-aprovado-1";
    // Simula pedido gravado no KV previamente pelo checkout
    await mockKV.put(
      `order:${ref}`,
      JSON.stringify({
        external_reference: ref,
        email: "comprador@natal.com",
        product_id: "combo",
        amount: 1690,
      })
    );

    const rawBody = JSON.stringify({
      event: "payment_approved",
      external_reference: ref,
    });

    const signature = generateSignature(env.PINPAY_WEBHOOK_SECRET, rawBody);

    const request = new Request("https://site.pages.dev/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: rawBody,
    });

    const res = await webhookHandler({ request, env });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Verifica que o email foi disparado exatamente 1 vez
    assert.equal(resendCalls.length, 1);
    assert.deepEqual(resendCalls[0].body.to, ["comprador@natal.com"]);
    // Regra: combo deve receber a pasta do kit completo
    assert.match(resendCalls[0].body.html, /kit_completo_test/);
    assert.match(resendCalls[0].body.text, /kit_completo_test/);

    // Verifica que o pedido foi registrado como entregue em KV
    const deliveredRaw = await mockKV.get(`delivered:${ref}`);
    assert.ok(deliveredRaw, "A chave delivered deve estar gravada no KV.");
    const deliveredData = JSON.parse(deliveredRaw);
    assert.equal(deliveredData.external_reference, ref);
    assert.equal(deliveredData.product_id, "combo");
  });

  test("4. Reenvio do mesmo evento payment_approved não gera segundo email (Idempotência)", async () => {
    const ref = "NATAL-aprovado-2";
    await mockKV.put(
      `order:${ref}`,
      JSON.stringify({
        external_reference: ref,
        email: "cliente2@natal.com",
        product_id: "cartoes",
        amount: 990,
      })
    );

    const rawBody = JSON.stringify({
      event: "payment_approved",
      external_reference: ref,
    });

    const signature = generateSignature(env.PINPAY_WEBHOOK_SECRET, rawBody);

    const createRequest = () =>
      new Request("https://site.pages.dev/api/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
        },
        body: rawBody,
      });

    // Primeiro envio
    const res1 = await webhookHandler({ request: createRequest(), env });
    assert.equal(res1.status, 200);
    assert.equal(resendCalls.length, 1, "Primeiro envio dispara 1 email.");
    assert.match(resendCalls[0].body.html, /cartoes_test/);

    // Reenvio imediato do mesmo evento pela PinPay
    const res2 = await webhookHandler({ request: createRequest(), env });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.status, "already_processed");
    assert.equal(resendCalls.length, 1, "Contador de emails permanece em 1 (sem duplicação).");
  });

  test("5. Checkout grava pedido pendente em KV ORDERS com WhatsApp e Nome", async () => {
    const reqBody = {
      name: "Maria Teste",
      email: "teste_checkout@exemplo.com",
      phone: "(11) 98888-7777",
      product_id: "guia",
    };

    const request = new Request("https://site.pages.dev/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    const res = await checkoutHandler({ request, env });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.checkout_url, "https://pay.usepinpay.com/chk_simulado_123");

    assert.equal(pinpayCalls.length, 1);
    const extRef = pinpayCalls[0].body.external_reference;
    assert.match(extRef, /^NATAL-[0-9a-f-]+$/i);
    assert.equal(pinpayCalls[0].body.customer.phone, "11988887777");
    assert.equal(pinpayCalls[0].body.customer.name, "Maria Teste");

    // Confere se o pedido pendente foi registrado no KV ORDERS
    const storedOrderRaw = await mockKV.get(`order:${extRef}`);
    assert.ok(storedOrderRaw, "Pedido deve existir no KV ORDERS.");
    const storedOrder = JSON.parse(storedOrderRaw);
    assert.equal(storedOrder.email, "teste_checkout@exemplo.com");
    assert.equal(storedOrder.name, "Maria Teste");
    assert.equal(storedOrder.phone, "11988887777");
    assert.equal(storedOrder.product_id, "guia");
    assert.equal(storedOrder.status, "pending");
  });

  test("6. Dados do pedido vindos no payload da PinPay funcionam caso KV esteja vazio", async () => {
    const ref = "NATAL-direto-1";
    // Sem gravar em mockKV previamente

    const rawBody = JSON.stringify({
      event: "payment_approved",
      external_reference: ref,
      customer: { email: "cliente_direto@natal.com" },
      product_id: "guia",
    });

    const signature = generateSignature(env.PINPAY_WEBHOOK_SECRET, rawBody);

    const request = new Request("https://site.pages.dev/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: rawBody,
    });

    const res = await webhookHandler({ request, env });
    assert.equal(res.status, 200);
    assert.equal(resendCalls.length, 1);
    assert.deepEqual(resendCalls[0].body.to, ["cliente_direto@natal.com"]);
    assert.match(resendCalls[0].body.html, /guia_test/);
  });

  test("7. Rollback de idempotência quando o envio de email pelo Resend falha", async () => {
    const ref = "NATAL-falha-email";
    await mockKV.put(
      `order:${ref}`,
      JSON.stringify({
        external_reference: ref,
        email: "falha@natal.com",
        product_id: "cartoes",
      })
    );

    // Força erro no fetch para simular queda da API de email
    const originalFetchInTest = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("resend.com/emails")) {
        return new Response(JSON.stringify({ message: "Resend down" }), {
          status: 500,
        });
      }
      return originalFetchInTest(url, options);
    };

    const rawBody = JSON.stringify({
      event: "payment_approved",
      external_reference: ref,
    });

    const signature = generateSignature(env.PINPAY_WEBHOOK_SECRET, rawBody);
    const request = new Request("https://site.pages.dev/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: rawBody,
    });

    const res = await webhookHandler({ request, env });
    assert.equal(res.status, 500);

    // Chave de entrega NÃO deve permanecer gravada, permitindo que a PinPay reenvie o webhook
    const delivered = await mockKV.get(`delivered:${ref}`);
    assert.equal(delivered, null, "A chave delivered deve ter sido removida para permitir retry.");
  });

  test("8. Painel Admin: autenticação com senha válida e rejeição com senha incorreta", async () => {
    env.ADMIN_PASSWORD = "segredonatalino";

    // Teste com senha errada
    const reqFail = new Request("https://site.pages.dev/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", password: "senha_errada" }),
    });
    const resFail = await adminPostHandler({ request: reqFail, env });
    assert.equal(resFail.status, 401);

    // Teste com senha correta
    const reqOk = new Request("https://site.pages.dev/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", password: "segredonatalino" }),
    });
    const resOk = await adminPostHandler({ request: reqOk, env });
    assert.equal(resOk.status, 200);
    const dataOk = await resOk.json();
    assert.equal(dataOk.success, true);
    assert.ok(dataOk.token);
  });

  test("9. Painel Admin: listagem de pedidos e cálculo de métricas", async () => {
    env.ADMIN_PASSWORD = "adminpass123";

    // Cria um pedido entregue e um pendente
    await mockKV.put(
      "order:NATAL-1",
      JSON.stringify({
        external_reference: "NATAL-1",
        email: "pago@natal.com",
        product_id: "combo",
        amount: 1690,
        status: "delivered",
        created_at: new Date().toISOString(),
      })
    );
    await mockKV.put("delivered:NATAL-1", JSON.stringify({ delivered_at: new Date().toISOString() }));

    await mockKV.put(
      "order:NATAL-2",
      JSON.stringify({
        external_reference: "NATAL-2",
        email: "pendente@natal.com",
        product_id: "cartoes",
        amount: 990,
        status: "pending",
        created_at: new Date().toISOString(),
      })
    );

    const req = new Request("https://site.pages.dev/api/admin", {
      method: "GET",
      headers: { Authorization: "Bearer adminpass123" },
    });

    const res = await adminGetHandler({ request: req, env });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.metrics.totalOrders, 2);
    assert.equal(data.metrics.deliveredCount, 1);
    assert.equal(data.metrics.pendingCount, 1);
    assert.equal(data.metrics.totalDeliveredAmountCentavos, 1690);
    assert.equal(data.metrics.totalDeliveredReais, "16.90");
    assert.equal(data.orders.length, 2);
  });

  test("10. Painel Admin: simulador de webhook dispara payment_approved e entrega email", async () => {
    env.ADMIN_PASSWORD = "testpassword";

    const req = new Request("https://site.pages.dev/api/admin", {
      method: "POST",
      headers: {
        Authorization: "Bearer testpassword",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "test_webhook",
        email: "simuladoteste@natal.com",
        product_id: "guia",
      }),
    });

    const res = await adminPostHandler({ request: req, env });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(resendCalls.length, 1);
    assert.deepEqual(resendCalls[0].body.to, ["simuladoteste@natal.com"]);
  });
});
