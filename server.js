const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("redis");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.text({ type: ["text/xml", "application/soap+xml"] }));

const JSON_SERVICE = process.env.JSON_SERVICE || "http://10.104.0.4:8080";
const SOAP_SERVICE = process.env.SOAP_SERVICE || "https://user-soap-service-fcqlw.ondigitalocean.app/ws";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const PORT = process.env.PORT || 3000;

let redisClient = null;
let redisAvailable = false;

async function setupRedis() {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || "redis://10.104.0.3:6379",
      socket: {
        reconnectStrategy: false
      }
    });

    redisClient.on("error", (err) => {
      console.log("Redis error:", err.message);
    });

    await redisClient.connect();
    redisAvailable = true;
    console.log("Connected to Redis");
  } catch (error) {
    redisAvailable = false;
    console.log("Redis unavailable. Running without cache.");
  }
}

app.get("/", (req, res) => {
  res.send("API Gateway ажиллаж байна");
});

app.use("/api/users", async (req, res) => {
  const cacheKey = req.originalUrl;

  try {
    if (req.method === "GET" && redisAvailable) {
      const cachedData = await redisClient.get(cacheKey);

      if (cachedData) {
        console.log("CACHE HIT:", cacheKey);
        return res.json(JSON.parse(cachedData));
      }
    }

    const response = await axios({
      method: req.method,
      url: JSON_SERVICE + "/users" + req.originalUrl.replace("/api/users", ""),
      data: req.body,
      headers: {
        Authorization: req.headers.authorization || "",
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    if (req.method === "GET" && redisAvailable) {
      await redisClient.setEx(cacheKey, 60, JSON.stringify(response.data));
      console.log("CACHE MISS:", cacheKey);
    }

    res.json(response.data);
  } catch (error) {
    console.error("Gateway Error:", error.message);
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }
    res.status(500).send("Gateway Error");
  }
});

app.use("/api/soap", async (req, res) => {
  try {
    const response = await axios({
      method: req.method,
      url: SOAP_SERVICE,
      data: req.body,
      headers: {
        "Content-Type": req.headers["content-type"] || "text/xml"
      },
      timeout: 10000
    });

    res.send(response.data);
  } catch (error) {
    console.error("SOAP Gateway Error:", error.message);
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }
    res.status(500).send("SOAP Gateway Error");
  }
});

async function startServer() {
  await setupRedis();

  app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
  });
}

startServer();