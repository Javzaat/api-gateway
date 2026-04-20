const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("redis");

const app = express();

app.use(cors());
app.use(express.json());

const JSON_SERVICE = "https://user-json-service-s9oyc.ondigitalocean.app";

const redisClient = createClient({
  url: "redis://127.0.0.1:6379"
});

redisClient.on("error", (err) => {
  console.error("Redis error:", err);
});

async function startServer() {
  await redisClient.connect();
  console.log("Connected to Redis");

  app.get("/", (req, res) => {
    res.send("API Gateway ажиллаж байна");
  });

  app.use("/api/users", async (req, res) => {
    const cacheKey = req.originalUrl;

    try {
      if (req.method === "GET") {
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
        }
      });

      if (req.method === "GET") {
        await redisClient.setEx(cacheKey, 60, JSON.stringify(response.data));
        console.log("CACHE MISS:", cacheKey);
      }

      res.json(response.data);
    } catch (error) {
      console.error(error.message);
      res.status(500).send("Gateway Error");
    }
  });

  app.use("/api/soap", async (req, res) => {
    try {
      const response = await axios({
        method: req.method,
        url: "https://user-soap-service-fcqlw.ondigitalocean.app/ws",
        data: req.body,
        headers: {
          "Content-Type": req.headers["content-type"] || "text/xml"
        }
      });

      res.send(response.data);
    } catch (error) {
      console.error("SOAP Gateway Error:", error.message);
      res.status(500).send("SOAP Gateway Error");
    }
  });

  app.listen(3000, () => {
    console.log("API Gateway running on http://localhost:3000");
  });
}

startServer();