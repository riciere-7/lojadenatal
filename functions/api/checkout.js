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

  const customerObj = { email };
  if (name) customerObj.name = name;
  if (phone) customerObj.phone = phone;

  const body = {
    amount: product.amount,
    external_reference: externalReference,
    description: product.name,
    methods: ["pix"],
    customer: customerObj,
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
          name: name || undefined,
          email,
          phone: phone || undefined,
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

  let checkoutUrl = checkout.checkout_url || checkout.url;
  // A API da PinPay retorna 'https://usepinpay.com/link/<uuid>' (sem o subdomínio hub),
  // porém o domínio institucional 'usepinpay.com' exibe a página institucional de marketing.
  // A aplicação web de checkout oficial da PinPay (com QR Code Pix, formulário e PIX Copia e Cola)
  // é hospedada exclusivamente no subdomínio 'https://hub.usepinpay.com/link/<uuid>'.
  if (checkoutUrl && checkoutUrl.includes("usepinpay.com/link/") && !checkoutUrl.includes("hub.usepinpay.com")) {
    checkoutUrl = checkoutUrl
      .replace("https://usepinpay.com/link/", "https://hub.usepinpay.com/link/")
      .replace("http://usepinpay.com/link/", "https://hub.usepinpay.com/link/");
  }

  return json({ checkout_url: checkoutUrl });
}
