function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * GET /api/check-payment?ref=NATAL-...&id=tx_...
 * Verifica em tempo real o status de pagamento de um pedido.
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref");
  const transactionId = url.searchParams.get("id");

  if (!ref && !transactionId) {
    return json({ error: "Parâmetro ref ou id é obrigatório." }, 400);
  }

  // 1. Checa se o webhook já registrou como entregue no KV
  if (env.ORDERS && ref) {
    try {
      const deliveredRaw = await env.ORDERS.get(`delivered:${ref}`);
      if (deliveredRaw) {
        return json({
          status: "delivered",
          paid: true,
          redirect_url: `/obrigado.html?ref=${encodeURIComponent(ref)}`,
        });
      }

      const orderRaw = await env.ORDERS.get(`order:${ref}`);
      if (orderRaw) {
        const order = JSON.parse(orderRaw);
        if (order.status === "delivered" || order.status === "paid") {
          return json({
            status: "delivered",
            paid: true,
            redirect_url: `/obrigado.html?ref=${encodeURIComponent(ref)}`,
          });
        }
      }
    } catch (e) {
      console.error("Erro ao consultar KV no check-payment:", e);
    }
  }

  // 2. Consulta diretamente a transação na PinPay se tiver transactionId e PINPAY_SECRET_KEY
  if (env.PINPAY_SECRET_KEY && transactionId) {
    try {
      const res = await fetch(`https://api.usepinpay.com/functions/v1/api-v1/transactions/${transactionId}`, {
        headers: { Authorization: `Bearer ${env.PINPAY_SECRET_KEY}` },
      });

      if (res.ok) {
        const tx = await res.json();
        const isPaid = ["paid", "approved", "completed"].includes(String(tx.status || "").toLowerCase());

        if (isPaid) {
          // Atualiza status no KV se disponível
          if (env.ORDERS && ref) {
            try {
              await env.ORDERS.put(
                `delivered:${ref}`,
                JSON.stringify({
                  delivered_at: new Date().toISOString(),
                  external_reference: ref,
                  transaction_id: transactionId,
                  email: tx.customer?.email,
                })
              );
            } catch {}
          }

          return json({
            status: "delivered",
            paid: true,
            redirect_url: `/obrigado.html?ref=${encodeURIComponent(ref || transactionId)}`,
          });
        }
      }
    } catch (err) {
      console.error("Erro ao verificar status na PinPay:", err);
    }
  }

  return json({ status: "pending", paid: false });
}

