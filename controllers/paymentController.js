const axios = require("axios");
const crypto = require("crypto");
const supabase = require("../db/supabaseClient");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;



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

    if (!customer_email || !total_amount || !items) {
      return res.status(400).json({
        message: "Missing required payment fields"
      });
    }

    const reference = "tajii_" + Date.now();

    // Insert pending transaction
    const { error: txError } = await supabase
      .from("transactions")
      .insert({
        paystack_reference: reference,
        amount: total_amount,
        status: "pending",
        metadata: {
          customer_name,
          customer_email,
          items
        }
      });

    if (txError) {
      console.error("Transaction insert error:", txError);
    }

    // Initialize Paystack payment
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: customer_email,
        amount: total_amount * 100,
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

    return res.json({
      authorization_url: response.data.data.authorization_url,
      reference
    });

  } catch (error) {

    console.error(error.response?.data || error.message);

    res.status(500).json({
      message: "Payment initialization failed"
    });

  }
};



// ===============================
// PAYSTACK WEBHOOK
// ===============================
exports.paystackWebhook = async (req, res) => {

  try {

    // Verify Paystack signature
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event === "charge.success") {

      const data = event.data;
      const reference = data.reference;

      // Verify payment with Paystack
      const verify = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET}`
          }
        }
      );

      const paymentData = verify.data.data;

      if (paymentData.status !== "success") {
        return res.sendStatus(200);
      }

      const metadata = paymentData.metadata;

      const {
        customer_name,
        customer_phone,
        delivery_address,
        delivery_city,
        items,
        total_amount
      } = metadata;

      const email = paymentData.customer.email;

      // Prevent duplicate orders
      const { data: existingOrder } = await supabase
        .from("orders")
        .select("id")
        .eq("reference", reference)
        .single();

      if (existingOrder) {
        return res.sendStatus(200);
      }

      // Insert order
      const { error: orderError } = await supabase
        .from("orders")
        .insert({
          reference: reference,
          customer_name: customer_name,
          customer_email: email,
          customer_phone: customer_phone,
          delivery_address: delivery_address,
          delivery_city: delivery_city,
          total_amount: total_amount,
          items: items
        });

      if (orderError) {
        console.error("Order insert error:", orderError);
      }

      // Update transaction status
      await supabase
        .from("transactions")
        .update({
          status: "success",
          payment_method: paymentData.channel
        })
        .eq("paystack_reference", reference);

    }

    return res.sendStatus(200);

  } catch (err) {

    console.error("Webhook error:", err);

    return res.sendStatus(500);

  }

};