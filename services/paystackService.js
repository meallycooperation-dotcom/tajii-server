const axios = require("axios");
require("dotenv").config();

const PAYSTACK_URL = "https://api.paystack.co";

const initializePayment = async (email, amount, reference) => {

  const response = await axios.post(
    `${PAYSTACK_URL}/transaction/initialize`,
    {
      email,
      amount,
      reference
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;
};

const verifyPayment = async (reference) => {

  const response = await axios.get(
    `${PAYSTACK_URL}/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );

  return response.data;
};

module.exports = { initializePayment, verifyPayment };