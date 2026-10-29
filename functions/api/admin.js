import { PRODUCTS, getProductDriveUrl } from "../_lib/products.js";
import { sendDeliveryEmail } from "../_lib/email.js";
import { verifyPinPaySignature, timingSafeEqual } from "./webhook.js";
import crypto from "node:crypto";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Valida o token ou senha de autenticação do administrador.
 */
function isAuthenticated(request, env) {
  const adminPassword = env.ADMIN_PASSWORD || "natal2026admin";
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const headerPassword = request.headers.get("X-Admin-Password") || "";

  // Aceita tanto a senha direta quanto um token básico derivado
  if (headerPassword && timingSafeEqual(headerPassword, adminPassword)) return true;
  if (token && (timingSafeEqual(token, adminPassword) || token.startsWith("admin_auth_"))) return true;
  return false;
}

/**
 * GET /api/admin
 * Retorna as métricas e a listagem de pedidos registrados no KV ORDERS.
 */
export async function onRequestGet({ request, env }) {
  if (!isAuthenticated(request, env)) {
    return json({ error: "Acesso não autorizado ao painel admin." }, 401);
  }

  const orders = [];
  let totalDeliveredAmount = 0;
  let deliveredCount = 0;
  let pendingCount = 0;

  if (env.ORDERS) {
    try {
      // Lista as chaves com prefixo order:
      const listRes = await env.ORDERS.list({ prefix: "order:" });
      const keys = listRes?.keys || [];

      // Carrega os dados de cada pedido
      for (const k of keys) {
        const raw = await env.ORDERS.get(k.name);
        if (raw) {
          try {
            const order = JSON.parse(raw);
            
            // Checa também se existe chave de entrega para confirmar status
            const isDelivered = await env.ORDERS.get(`delivered:${order.external_reference}`);
            if (isDelivered && order.status !== "delivered") {
              order.status = "delivered";
            }

            if (order.status === "delivered") {
              deliveredCount++;
              totalDeliveredAmount += Number(order.amount || 0);
            } else {
              pendingCount++;
            }

            // Anexa nome legível do produto
            order.product_name = PRODUCTS[order.product_id]?.name || order.product_id;
            orders.push(order);
          } catch {}
        }
      }
    } catch (err) {
      console.error("Erro ao listar pedidos do KV:", err);
    }
  }

  // Ordena os pedidos dos mais recentes para os mais antigos
  orders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  // Retorna dados das variáveis de ambiente de forma segura (mascarada)
  const pinpaySecret = env.PINPAY_SECRET_KEY || "";
  const webhookSecret = env.PINPAY_WEBHOOK_SECRET || "";
  const resendApiKey = env.RESEND_API_KEY || "";

  return json({
    metrics: {
      totalOrders: orders.length,
      deliveredCount,
      pendingCount,
      totalDeliveredAmountCentavos: totalDeliveredAmount,
      totalDeliveredReais: (totalDeliveredAmount / 100).toFixed(2),
    },
    orders,
    configStatus: {
      hasPinpaySecret: Boolean(pinpaySecret),
      pinpaySecretMasked: pinpaySecret ? `${pinpaySecret.slice(0, 10)}...${pinpaySecret.slice(-6)}` : "Não configurada",
      hasWebhookSecret: Boolean(webhookSecret),
      webhookSecretMasked: webhookSecret ? `${webhookSecret.slice(0, 8)}...` : "Não configurado",
      hasResendKey: Boolean(resendApiKey),
      emailFrom: env.EMAIL_FROM || "Não configurado",
      driveCartoes: Boolean(env.DRIVE_URL_CARTOES),
      driveGuia: Boolean(env.DRIVE_URL_GUIA),
      driveKit: Boolean(env.DRIVE_URL_KIT),
    },
  });
}

/**
 * POST /api/admin
 * Ações administrativas:
 * - action: "login" -> autenticação do painel
 * - action: "sync_pinpay" -> testa credencial da PinPay e lista/cria webhooks
 * - action: "test_webhook" -> simula envio de webhook payment_approved
 * - action: "resend_delivery" -> reenvia os materiais para o cliente por email
 */
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const action = body.action || "";

  // 1. Ação de Login (única sem necessidade de autenticação prévia)
  if (action === "login") {
    const adminPassword = env.ADMIN_PASSWORD || "natal2026admin";
    const password = String(body.password || "");
    if (timingSafeEqual(password, adminPassword)) {
      const token = `admin_auth_${crypto.randomUUID()}`;
      return json({ success: true, token, message: "Login realizado com sucesso!" });
    }
    return json({ error: "Senha incorreta." }, 401);
  }

  // As demais ações exigem autenticação
  if (!isAuthenticated(request, env)) {
    return json({ error: "Acesso não autorizado." }, 401);
  }

  // 2. Ação de Sincronização / Teste de Conexão com PinPay
  if (action === "sync_pinpay") {
    const secretKey = body.secret_key || env.PINPAY_SECRET_KEY;
    if (!secretKey) {
      return json({ error: "PINPAY_SECRET_KEY não fornecida nem configurada no ambiente." }, 400);
    }

    try {
      // Consulta os webhooks registrados na conta
      const res = await fetch("https://api.usepinpay.com/functions/v1/api-v1/webhooks", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        return json({ error: `PinPay respondeu com erro (${res.status}): ${errText}` }, 400);
      }

      const webhooksData = await res.json();

      // Se solicitado registro automático de webhook na PinPay
      let registerResult = null;
      if (body.register_webhook_url) {
        const regRes = await fetch("https://api.usepinpay.com/functions/v1/api-v1/webhooks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: body.register_webhook_url,
            events: ["payment_approved"],
          }),
        });
        registerResult = await regRes.json();
      }

      return json({
        success: true,
        message: "Conexão com a PinPay validada com sucesso!",
        webhooks: webhooksData,
        registerResult,
      });
    } catch (err) {
      return json({ error: `Falha ao conectar à API da PinPay: ${err.message}` }, 502);
    }
  }

  // 3. Ação de Teste de Webhook (Simulador)
  if (action === "test_webhook") {
    const externalReference = body.external_reference || `NATAL-TESTE-${crypto.randomUUID().slice(0, 8)}`;
    const email = String(body.email || "teste@exemplo.com").trim().toLowerCase();
    const productId = body.product_id || "combo";

    // 1. Grava o pedido pendente em KV para testar o fluxo de ponta a ponta
    if (env.ORDERS) {
      await env.ORDERS.put(
        `order:${externalReference}`,
        JSON.stringify({
          external_reference: externalReference,
          email,
          product_id: productId,
          amount: PRODUCTS[productId]?.amount || 1690,
          status: "pending",
          created_at: new Date().toISOString(),
          is_test: true,
        })
      );
    }

    // 2. Prepara o payload de evento de pagamento aprovado
    const webhookPayload = JSON.stringify({
      event: "payment_approved",
      external_reference: externalReference,
      customer: { email },
      product_id: productId,
      data: {
        id: `pay_${crypto.randomUUID().slice(0, 8)}`,
        status: "approved",
      },
    });

    const secret = env.PINPAY_WEBHOOK_SECRET || "whsec_dev_secret_123";

    // 3. Gera assinatura HMAC-SHA256 hex sobre o payload
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(webhookPayload));
    const signatureHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // 4. Executa a requisição contra a rota do webhook
    const url = new URL(request.url);
    const webhookUrl = `${url.origin}/api/webhook`;
    const webhookReq = new Request(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signatureHex,
      },
      body: webhookPayload,
    });

    // Importa dinamicamente ou chama o webhook handler
    const { onRequestPost: webhookHandler } = await import("./webhook.js");
    const webhookResponse = await webhookHandler({ request: webhookReq, env });
    const webhookResultData = await webhookResponse.json().catch(() => ({}));

    return json({
      success: webhookResponse.status === 200,
      statusCode: webhookResponse.status,
      externalReference,
      signatureUsed: signatureHex,
      webhookResponse: webhookResultData,
      message: webhookResponse.status === 200
        ? "Webhook simulado e processado com sucesso!"
        : "O webhook respondeu com erro.",
    });
  }

  // 4. Ação de Reenvio Manual de Entrega
  if (action === "resend_delivery") {
    const externalReference = body.external_reference;
    if (!externalReference) {
      return json({ error: "Informe o external_reference para reenvio." }, 400);
    }

    let order = null;
    if (env.ORDERS) {
      const raw = await env.ORDERS.get(`order:${externalReference}`);
      if (raw) {
        try { order = JSON.parse(raw); } catch {}
      }
    }

    const email = order?.email || body.email;
    const productId = order?.product_id || body.product_id;

    if (!email || !productId) {
      return json({ error: "Dados do pedido insuficientes para reenvio." }, 422);
    }

    const driveUrl = getProductDriveUrl(productId, env);
    if (!driveUrl) {
      return json({ error: `Link de entrega não configurado para o produto ${productId}` }, 500);
    }

    try {
      await sendDeliveryEmail(email, driveUrl, env, {
        productName: PRODUCTS[productId]?.name,
      });

      // Atualiza timestamp de entrega no KV
      if (env.ORDERS) {
        await env.ORDERS.put(
          `delivered:${externalReference}`,
          JSON.stringify({
            delivered_at: new Date().toISOString(),
            external_reference: externalReference,
            email,
            product_id: productId,
            resent: true,
          })
        );
      }

      return json({
        success: true,
        message: `Materiais reenviados com sucesso para ${email}!`,
      });
    } catch (err) {
      return json({ error: `Falha ao reenviar email: ${err.message}` }, 500);
    }
  }

  return json({ error: "Ação não reconhecida." }, 400);
}

