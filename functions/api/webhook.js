import { PRODUCTS, getProductDriveUrl } from "../_lib/products.js";
import { sendDeliveryEmail } from "../_lib/email.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Comparação de strings em tempo constante para mitigar ataques de temporização.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aLen = a.length;
  const bLen = b.length;
  let mismatch = aLen === bLen ? 0 : 1;
  const len = Math.max(aLen, bLen);
  for (let i = 0; i < len; i++) {
    const charA = i < aLen ? a.charCodeAt(i) : 0;
    const charB = i < bLen ? b.charCodeAt(i) : 0;
    mismatch |= charA ^ charB;
  }
  return mismatch === 0;
}

/**
 * Valida a assinatura HMAC-SHA256 enviada no cabeçalho X-Webhook-Signature.
 *
 * TODO: Formato da assinatura da PinPay:
 * A documentação da PinPay informa apenas "HMAC-SHA256 no header X-Webhook-Signature",
 * sem especificar se o valor esperado é hexadecimal puro, Base64 ou se inclui prefixos
 * ou timestamps (ex: t=...,v1=...).
 * Foi implementada a comparação contra o digest hexadecimal do corpo bruto em UTF-8.
 * Confirmar o formato exato com a PinPay caso a assinatura falhe em produção.
 */
export async function verifyPinPaySignature(secret, rawBody, signatureHeader) {
  if (!secret || !signatureHeader) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(rawBody)
    );

    const expectedHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return timingSafeEqual(expectedHex.toLowerCase(), signatureHeader.trim().toLowerCase());
  } catch (err) {
    console.error("Erro ao validar assinatura HMAC:", err);
    return false;
  }
}

/**
 * Mascara campos sensíveis para logging seguro do payload.
 */
export function sanitizePayloadForLog(data) {
  if (!data || typeof data !== "object") return data;
  const copy = Array.isArray(data) ? [...data] : { ...data };
  for (const [key, value] of Object.entries(copy)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("password") ||
      lowerKey.includes("cpf") ||
      lowerKey.includes("card")
    ) {
      copy[key] = "[REDACTED]";
    } else if (lowerKey.includes("email") && typeof value === "string") {
      const parts = value.split("@");
      copy[key] = parts.length === 2 ? `${parts[0].slice(0, 2)}***@${parts[1]}` : "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      copy[key] = sanitizePayloadForLog(value);
    }
  }
  return copy;
}

/**
 * Localiza o external_reference de forma defensiva no payload.
 */
export function extractExternalReference(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.external_reference ||
    payload.data?.external_reference ||
    payload.checkout?.external_reference ||
    payload.payment?.external_reference ||
    payload.order?.external_reference ||
    null
  );
}

/**
 * Localiza o email do cliente de forma defensiva no payload.
 */
export function extractEmail(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.customer?.email ||
    payload.data?.customer?.email ||
    payload.email ||
    payload.data?.email ||
    payload.payment?.customer?.email ||
    null
  );
}

/**
 * Verifica se o evento corresponde a pagamento aprovado.
 */
export function isPaymentApproved(payload) {
  if (!payload || typeof payload !== "object") return false;
  const evt =
    payload.event ||
    payload.type ||
    payload.event_type ||
    payload.action ||
    payload.data?.status ||
    payload.status;
  return evt === "payment_approved";
}

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();

  // 1. Parse do corpo JSON
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Corpo da requisição não é um JSON válido." }, 400);
  }

  // 2. Trata eventos de teste disparados pelo botão de teste no painel da PinPay (aviãozinho)
  if (
    payload.test === true ||
    payload.event === "test" ||
    payload.event === "ping" ||
    payload.event_type === "test" ||
    payload.event_type === "ping"
  ) {
    console.log("PinPay webhook de teste recebido:", JSON.stringify(sanitizePayloadForLog(payload)));
    return json({
      success: true,
      message: "Webhook de teste recebido com sucesso pela Loja de Natal!",
      test: true,
    }, 200);
  }

  // 3. Validação de assinatura HMAC-SHA256 (quando PINPAY_WEBHOOK_SECRET estiver configurado)
  const secret = env.PINPAY_WEBHOOK_SECRET;
  const signatureHeader =
    request.headers.get("x-webhook-signature") ||
    request.headers.get("X-Webhook-Signature");

  if (secret) {
    if (!signatureHeader) {
      console.warn("Webhook rejeitado: cabeçalho X-Webhook-Signature ausente.");
      return json({ error: "Assinatura ausente." }, 401);
    }
    const isValid = await verifyPinPaySignature(secret, rawBody, signatureHeader);
    if (!isValid) {
      console.warn("Assinatura do webhook inválida. Header recebido:", signatureHeader);
      return json({ error: "Assinatura inválida." }, 401);
    }
  } else {
    console.warn("AVISO: PINPAY_WEBHOOK_SECRET não configurada na Cloudflare. Validação de assinatura ignorada para não bloquear entregas reais.");
  }

  // Registro do payload sanitizado para auditoria e depuração
  console.log("PinPay webhook recebido:", JSON.stringify(sanitizePayloadForLog(payload)));

  // 3. Verifica se é evento de pagamento aprovado
  if (!isPaymentApproved(payload)) {
    console.log("Evento ignorado (não aprovado):", payload.event || payload.type || "sem evento explícito");
    return json({ status: "ignored", message: "Evento ignorado." }, 200);
  }

  // 4. Localiza o identificador do pedido
  const externalReference = extractExternalReference(payload);
  if (!externalReference) {
    console.error("Payload payment_approved sem external_reference identificável:", sanitizePayloadForLog(payload));
    return json({ error: "external_reference não encontrado no payload." }, 422);
  }

  // 5. Idempotência: Se já entregue, encerra com 200 sem reenviar
  const deliveredKey = `delivered:${externalReference}`;
  if (env.ORDERS) {
    const alreadyDelivered = await env.ORDERS.get(deliveredKey);
    if (alreadyDelivered) {
      console.log(`Pedido ${externalReference} já entregue anteriormente. Reenvio ignorado.`);
      return json({ status: "already_processed", message: "Pedido já entregue." }, 200);
    }
  }

  // 6. Consulta dos dados do pedido
  // Prioriza o registro guardado no KV no momento do checkout, pois a PinPay pode não enviar
  // o product_id de volta no webhook. Se a PinPay enviar, também aproveita.
  let orderData = null;
  if (env.ORDERS) {
    const rawOrder = await env.ORDERS.get(`order:${externalReference}`);
    if (rawOrder) {
      try {
        orderData = JSON.parse(rawOrder);
      } catch (err) {
        console.error("Falha ao analisar JSON do pedido em KV:", err);
      }
    }
  }

  const customerEmail = (extractEmail(payload) || orderData?.email || "").trim().toLowerCase();
  const productId = payload.product_id || payload.data?.product_id || orderData?.product_id;

  if (!customerEmail || !productId) {
    console.error("Dados incompletos para entrega:", { externalReference, customerEmail, productId });
    return json({ error: "Não foi possível identificar o email ou produto para entrega." }, 422);
  }

  const driveUrl = getProductDriveUrl(productId, env);
  if (!driveUrl) {
    console.error(`Link de entrega não configurado para o produto ${productId}`);
    return json({ error: "Link de entrega não configurado no servidor." }, 500);
  }

  // 7. Idempotência: Grava como entregue ANTES de enviar para evitar duplicidade em requisições paralelas
  if (env.ORDERS) {
    await env.ORDERS.put(
      deliveredKey,
      JSON.stringify({
        delivered_at: new Date().toISOString(),
        external_reference: externalReference,
        email: customerEmail,
        product_id: productId,
      })
    );
  }

  // 8. Envio de email de entrega via Resend
  try {
    await sendDeliveryEmail(customerEmail, driveUrl, env, {
      productName: PRODUCTS[productId]?.name,
    });
  } catch (err) {
    console.error("Erro ao enviar email de entrega:", err);
    // Remove a chave de entrega para permitir que uma nova tentativa do webhook reenvie
    if (env.ORDERS) {
      try {
        await env.ORDERS.delete(deliveredKey);
      } catch {}
    }
    return json({ error: "Falha ao enviar email de entrega." }, 500);
  }

  // 9. Atualiza o status do pedido para delivered no KV se o registro original existir
  if (env.ORDERS && orderData) {
    try {
      await env.ORDERS.put(
        `order:${externalReference}`,
        JSON.stringify({
          ...orderData,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        })
      );
    } catch {}
  }

  return json({ success: true, message: "Pagamento aprovado e entrega realizada com sucesso." }, 200);
}

