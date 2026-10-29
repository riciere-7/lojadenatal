import { PRODUCTS } from "../_lib/products.js";

const PINPAY_PIX_URL = "https://api.usepinpay.com/functions/v1/api-v1/pix";
const PINPAY_CHECKOUT_URL = "https://api.usepinpay.com/functions/v1/api-v1/checkouts";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Validação do algoritmo oficial de CPF brasileiro.
 */
export function isValidCPF(cpf) {
  const clean = String(cpf || "").replace(/\D/g, "");
  if (clean.length !== 11 || /^(\d)\1{10}$/.test(clean)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(clean[i], 10) * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(clean[9], 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(clean[i], 10) * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === parseInt(clean[10], 10);
}

export async function onRequestPost({ request, env }) {
  if (!env.PINPAY_SECRET_KEY) {
    console.error("PINPAY_SECRET_KEY não está configurada nas variáveis de ambiente.");
    return json({ error: "Configuração do servidor incompleta: variável PINPAY_SECRET_KEY ausente na Cloudflare Pages." }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const email = String(data.email || "").trim().toLowerCase();
  const name = String(data.name || "").trim();
  const phone = String(data.phone || "").replace(/\D/g, ""); // Apenas dígitos do WhatsApp
  const cpf = String(data.cpf || "").replace(/\D/g, ""); // Apenas dígitos do CPF
  const product = PRODUCTS[data.product_id];

  if (!name || name.length < 2) {
    return json({ error: "Por favor, informe seu nome completo." }, 422);
  }
  if (!EMAIL_RE.test(email) || email.length > 120) {
    return json({ error: "Por favor, informe um email válido." }, 422);
  }
  if (!phone || phone.length < 10) {
    return json({ error: "Por favor, informe seu WhatsApp com DDD." }, 422);
  }
  if (!cpf || !isValidCPF(cpf)) {
    return json({ error: "Por favor, informe um CPF válido para a emissão do PIX." }, 422);
  }
  if (!product) {
    return json({ error: "Produto não encontrado." }, 422);
  }

  const origin = new URL(request.url).origin;
  // Identificador do pedido na loja: volta no webhook para casar o pagamento.
  const externalReference = `NATAL-${crypto.randomUUID()}`;

  // Criação da cobrança PIX nativa direta na PinPay para entrega inline na mesma tela
  const pixBody = {
    amount: product.amount,
    description: product.name,
    external_reference: externalReference,
    customer: {
      name,
      email,
      phone,
      document: {
        number: cpf,
        type: "cpf",
      },
    },
    metadata: {
      checkout_url: origin,
      product_id: data.product_id,
      source: "loja_natal_inline",
    },
  };

  let res;
  let pixCode = null;
  let transactionId = null;
  let expiresAt = null;

  try {
    res = await fetch(PINPAY_PIX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PINPAY_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(pixBody),
    });

    if (res.ok) {
      const pixData = await res.json();
      pixCode = pixData.pix?.qr_code || pixData.qr_code || pixData.pix_code;
      transactionId = pixData.id;
      expiresAt = pixData.pix?.expires_at;
    } else {
      const errText = await res.text();
      console.warn("Falha no endpoint /pix da PinPay:", res.status, errText);
    }
  } catch (err) {
    console.error("Erro de conexão ao chamar /pix:", err);
  }

  // Fallback para /checkouts caso a geração direta do PIX não tenha retornado código
  let fallbackCheckoutUrl = null;
  if (!pixCode) {
    try {
      const chkRes = await fetch(PINPAY_CHECKOUT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PINPAY_SECRET_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          amount: product.amount,
          external_reference: externalReference,
          description: product.name,
          methods: ["pix"],
          customer: { name, email, phone },
          success_url: `${origin}/obrigado.html?ref=${externalReference}`,
        }),
      });

      if (chkRes.ok) {
        const chkData = await chkRes.json();
        let url = chkData.checkout_url || chkData.url;
        if (url && url.includes("usepinpay.com/link/") && !url.includes("hub.usepinpay.com")) {
          url = url.replace("https://usepinpay.com/link/", "https://hub.usepinpay.com/link/");
        }
        fallbackCheckoutUrl = url;
      }
    } catch (e) {
      console.error("Fallback /checkouts também falhou:", e);
    }
  }

  if (!pixCode && !fallbackCheckoutUrl) {
    return json({ error: "Não foi possível gerar a cobrança PIX no momento. Verifique seus dados e tente novamente." }, 502);
  }

  // Grava o pedido pendente em KV (binding ORDERS) para casamento no webhook e admin
  if (env.ORDERS) {
    try {
      await env.ORDERS.put(
        `order:${externalReference}`,
        JSON.stringify({
          external_reference: externalReference,
          transaction_id: transactionId,
          name,
          email,
          phone,
          cpf,
          product_id: data.product_id,
          amount: product.amount,
          status: "pending",
          created_at: new Date().toISOString(),
        })
      );
    } catch (err) {
      console.error("Erro ao gravar pedido pendente no KV ORDERS:", err);
    }
  }

  return json({
    success: true,
    inline: Boolean(pixCode),
    pix_code: pixCode,
    transaction_id: transactionId,
    external_reference: externalReference,
    amount: product.amount,
    expires_at: expiresAt,
    product_name: product.name,
    checkout_url: fallbackCheckoutUrl || undefined,
  });
}
