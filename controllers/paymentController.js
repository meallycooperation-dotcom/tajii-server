const axios = require("axios");
const supabase = require("../db/supabaseClient");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;



// INIT PAYMENT
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

    const reference = "tajii_" + Date.now();

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: customer_email,
        amount: total_amount * 100,
        reference: reference,
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

    res.json({
      payment_url: response.data.data.authorization_url,
      reference
    });

  } catch (error) {

    console.error(error.response?.data || error.message);

    res.status(500).json({
      error: "Payment initialization failed"
    });

  }

};



// PAYSTACK WEBHOOK
exports.paystackWebhook = async (req, res) => {

  try {

    const event = req.body;

    if (event.event === "charge.success") {

      const data = event.data;

      const reference = data.reference;
      const metadata = data.metadata;

      const {
        customer_name,
        customer_phone,
        delivery_address,
        delivery_city,
        items,
        total_amount
      } = metadata;

      const email = data.customer.email;

      // Insert order
      const { error } = await supabase
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

      if (error) {
        console.error("Order insert error:", error);
      }

    }

    res.sendStatus(200);

  } catch (err) {

    console.error("Webhook error:", err);

    res.sendStatus(500);

  }

};