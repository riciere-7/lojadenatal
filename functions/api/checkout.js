import { PRODUCTS } from "../_lib/products.js";

const PINPAY_CHECKOUT_URL = "https://api.usepinpay.com/functions/v1/api-v1/checkouts";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const email = String(data.email || "").trim().toLowerCase();
  const product = PRODUCTS[data.product_id];

  if (!EMAIL_RE.test(email) || email.length > 120) {
    return json({ error: "Informe um email válido." }, 422);
  }
  if (!product) {
    return json({ error: "Produto não encontrado." }, 422);
  }

  const origin = new URL(request.url).origin;
  // Identificador do pedido na loja: volta no webhook para casar o pagamento.
  const externalReference = `NATAL-${crypto.randomUUID()}`;

  const body = {
    amount: product.amount,
    external_reference: externalReference,
    description: product.name,
    methods: ["pix"],
    customer: { email },
    success_url: `${origin}/obrigado.html?ref=${externalReference}`,
  };
  // Sem webhook_url aqui: a confirmação chega pelo webhook da conta (ver README),
  // cuja assinatura HMAC é validada com o secret whsec_ desse endpoint.

  let res;
  try {
    res = await fetch(PINPAY_CHECKOUT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.PINPAY_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return json({ error: "Não foi possível iniciar o pagamento. Tente novamente." }, 502);
  }

  if (!res.ok) {
    // Detalhes ficam só no log do servidor, nunca na resposta ao cliente.
    console.error("PinPay checkout error", res.status, await res.text());
    return json({ error: "Não foi possível iniciar o pagamento. Tente novamente." }, 502);
  }

  const checkout = await res.json();
  if (!checkout.checkout_url) {
    console.error("PinPay response without checkout_url", JSON.stringify(checkout));
    return json({ error: "Não foi possível iniciar o pagamento. Tente novamente." }, 502);
  }

  // Grava o pedido pendente em KV (binding ORDERS) para que o webhook saiba
  // exatamente o que entregar (produto e email) associado a este external_reference.
  if (env.ORDERS) {
    try {
      await env.ORDERS.put(
        `order:${externalReference}`,
        JSON.stringify({
          external_reference: externalReference,
          email,
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

  return json({ checkout_url: checkout.checkout_url });
}
