const axios = require("axios");
const crypto = require("crypto");
const supabase = require("../db/supabaseClient");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET) {
  console.error("❌ PAYSTACK_SECRET_KEY is missing in environment variables");
}



// ===============================
// INIT PAYMENT
// ===============================
exports.initializePayment = async (req, res) => {
  try {

    const {
      customer_name,
      customer_email,
      customer_phone,
      delivery_address,
      delivery_city,
      total_amount,
      items
    } = req.body;

    if (!customer_email || !total_amount || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "Missing or invalid payment fields"
      });
    }

    const reference = "tajii_" + Date.now();

    // INSERT TRANSACTION
    const { error: txError } = await supabase
      .from("transactions")
      .insert([
        {
          paystack_reference: reference,
          order_reference: reference,
          amount: total_amount,
          currency: "KES",
          status: "pending",
          metadata: {
            customer_email,
            items
          }
        }
      ]);

    if (txError) {
      console.error("Transaction insert error:", txError);
      return res.status(500).json({ message: "Failed to create transaction" });
    }

    // INITIALIZE PAYSTACK PAYMENT
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: customer_email,
        amount: total_amount * 100, // Paystack expects kobo
        reference: reference,
        callback_url: "https://tajii.netlify.app/payment-success",
        metadata: {
          customer_name,
          customer_phone,
          delivery_address,
          delivery_city,
          items,
          total_amount
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