const axios = require("axios");
const crypto = require("crypto");
const supabase = require("../db/supabaseClient");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const EXPOSE_PAYMENT_ERRORS =
  process.env.EXPOSE_PAYMENT_ERRORS === "true" ||
  process.env.NODE_ENV !== "production";

if (!PAYSTACK_SECRET) {
  console.error("❌ PAYSTACK_SECRET_KEY is missing in environment variables");
}



// ===============================
// INIT PAYMENT
// ===============================
exports.initializePayment = async (req, res) => {
  try {

    const {
      user_id,
      customer_name,
      customer_email,
      customer_phone,
      delivery_address,
      delivery_city,
      total_amount,
      items,
      currency
    } = req.body;

    if (!customer_email || !total_amount || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "Missing or invalid payment fields"
      });
    }

    const amount = Number(total_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "Invalid total_amount" });
    }

    const reference = "tajii_" + Date.now();

    // INSERT TRANSACTION
    const txPayload = {
      paystack_reference: reference,
      order_reference: reference,
      amount,
      currency: currency || "KES",
      status: "pending",
      payment_method: "paystack",
      metadata: {
        customer_name,
        customer_email,
        customer_phone,
        delivery_address,
        delivery_city,
        items,
        total_amount: amount
      }
    };

    // Important: don't send explicit `null` for NOT NULL columns.
    if (user_id !== undefined && user_id !== null && user_id !== "") {
      txPayload.user_id = user_id;
    }

    let { error: txError } = await supabase
      .from("transactions")
      .insert([txPayload]);

    // If `metadata` column is `text` (not json/jsonb), retry with a JSON string.
    if (
      txError &&
      (txError.code === "42804" ||
        (typeof txError.message === "string" &&
          txError.message.toLowerCase().includes("metadata")))
    ) {
      const retryPayload = { ...txPayload, metadata: JSON.stringify(txPayload.metadata) };
      const retry = await supabase.from("transactions").insert([retryPayload]);
      txError = retry.error;
    }

    if (txError) {
      console.error("Transaction insert error:", txError);

      // Common Postgres error code for NOT NULL violations.
      if (txError.code === "23502") {
        const match = typeof txError.message === "string" ? txError.message.match(/column \"([^\"]+)\"/) : null;
        const missing_field = match ? match[1] : undefined;
        return res.status(400).json({
          message: "Missing required transaction fields",
          ...(missing_field ? { missing_field } : {}),
          ...(EXPOSE_PAYMENT_ERRORS ? { error: txError.message, details: txError.details } : {})
        });
      }

      return res.status(500).json({
        message: "Failed to create transaction",
        ...(EXPOSE_PAYMENT_ERRORS
          ? {
              error: txError.message,
              code: txError.code,
              details: txError.details,
              hint: txError.hint
            }
          : {})
      });
    }

    // INITIALIZE PAYSTACK PAYMENT
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: customer_email,
        amount: amount * 100, // Paystack expects minor units
        reference: reference,
        callback_url: "https://tajii.netlify.app/payment-success",
        metadata: {
          customer_name,
          customer_phone,
          delivery_address,
          delivery_city,
          items,
          total_amount: amount
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.data || !response.data.data) {
      return res.status(500).json({ message: "Failed to initialize payment" });
    }

    return res.json({
      authorization_url: response.data.data.authorization_url,
      reference
    });

  } catch (error) {

    console.error("Payment initialization error:", error.response?.data || error.message);

    return res.status(500).json({
      message: "Payment initialization failed"
    });

  }
};



// ===============================
// PAYSTACK WEBHOOK
// ===============================
exports.paystackWebhook = async (req, res) => {

  try {

    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      console.warn("⚠️ Invalid Paystack signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event !== "charge.success") {
      return res.sendStatus(200);
    }

    const reference = event.data.reference;

    // VERIFY PAYMENT WITH PAYSTACK
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`
        }
      }
    );

    const paymentData = verify.data.data;

    if (!paymentData || paymentData.status !== "success") {
      return res.sendStatus(200);
    }

    const metadata = paymentData.metadata || {};

    const {
      customer_name,
      customer_phone,
      delivery_address,
      delivery_city,
      items = [],
      total_amount
    } = metadata;

    const email = paymentData.customer?.email;

    // CHECK IF ORDER ALREADY EXISTS
    const { data: existingOrder } = await supabase
      .from("orders")
      .select("id")
      .eq("reference", reference)
      .maybeSingle();

    if (existingOrder) {
      return res.sendStatus(200);
    }

    // INSERT ORDER
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .insert({
        reference,
        customer_name,
        customer_email: email,
        customer_phone,
        delivery_address,
        delivery_city,
        total_amount
      })
      .select()
      .single();

    if (orderError) {
      console.error("Order insert error:", orderError);
      return res.sendStatus(500);
    }

    const orderId = orderData.id;

    // INSERT ORDER ITEMS
    if (Array.isArray(items) && items.length > 0) {

      const orderItems = items.map(item => ({
        order_id: orderId,
        product_id: item.product_id,
        product_name: item.product_name,
        price: item.price,
        quantity: item.quantity
      }));

      const { error: itemsError } = await supabase
        .from("order_items")
        .insert(orderItems);

      if (itemsError) {
        console.error("Order items insert error:", itemsError);
      }
    }

    // UPDATE TRANSACTION STATUS
    const { error: txUpdateError } = await supabase
      .from("transactions")
      .update({
        status: "success",
        payment_method: paymentData.channel,
        updated_at: new Date()
      })
      .eq("paystack_reference", reference);

    if (txUpdateError) {
      console.error("Transaction update error:", txUpdateError);
    }

    return res.sendStatus(200);

  } catch (err) {

    console.error("Webhook error:", err.response?.data || err.message);

    return res.sendStatus(500);

  }

};
