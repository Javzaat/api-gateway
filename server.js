const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("redis");
const multer = require("multer");
const FormData = require("form-data");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.text({ type: ["text/xml", "application/soap+xml"] }));

const JSON_SERVICE = process.env.JSON_SERVICE || "http://10.104.0.4:8080";
const SOAP_SERVICE = process.env.SOAP_SERVICE || "http://10.104.0.6:8081/ws";
const FILE_SERVICE = process.env.FILE_SERVICE || "http://10.104.0.7:8082";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

let redisClient = null;
let redisAvailable = false;

async function setupRedis() {
  try {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        reconnectStrategy: false
      }
    });

    redisClient.on("error", (err) => {
      redisAvailable = false;
      console.log("Redis error:", err.message);
    });

    redisClient.on("end", () => {
      redisAvailable = false;
      console.log("Redis connection closed");
    });

    redisClient.on("ready", () => {
      redisAvailable = true;
      console.log("Redis ready");
    });

    await redisClient.connect();
    redisAvailable = true;
    console.log("Connected to Redis");
  } catch (error) {
    redisAvailable = false;
    console.log("Redis unavailable. Running without cache.");
  }
}

async function getCachedData(cacheKey) {
  try {
    if (redisAvailable && redisClient && redisClient.isOpen) {
      const cachedData = await redisClient.get(cacheKey);

      if (cachedData) {
        console.log("CACHE HIT:", cacheKey);
        return JSON.parse(cachedData);
      }
    }
  } catch (error) {
    redisAvailable = false;
    console.log("Redis GET failed:", error.message);
  }

  return null;
}

async function setCachedData(cacheKey, data) {
  try {
    if (redisAvailable && redisClient && redisClient.isOpen) {
      await redisClient.setEx(cacheKey, 60, JSON.stringify(data));
      console.log("CACHE MISS:", cacheKey);
    }
  } catch (error) {
    redisAvailable = false;
    console.log("Redis SET failed:", error.message);
  }
}

async function invalidateUsersCache() {
  try {
    if (redisAvailable && redisClient && redisClient.isOpen) {
      await redisClient.del("/api/users");
      console.log("CACHE INVALIDATED: /api/users");
    }
  } catch (error) {
    redisAvailable = false;
    console.log("Redis DEL failed:", error.message);
  }
}

app.get("/", (req, res) => {
  res.send("API Gateway ажиллаж байна");
});

app.use("/api/users", async (req, res) => {
  const cacheKey = req.originalUrl;

  try {
    if (req.method === "GET") {
      const cachedData = await getCachedData(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
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

    if (req.method === "GET") {
      await setCachedData(cacheKey, response.data);
    }

    if (["POST", "PUT", "DELETE"].includes(req.method)) {
      await invalidateUsersCache();
    }

    res.status(response.status).json(response.data);
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

    res.status(response.status).send(response.data);
  } catch (error) {
    console.error("SOAP Gateway Error:", error.message);
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }
    res.status(500).send("SOAP Gateway Error");
  }
});

app.post("/api/files/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("File not provided");
    }

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      knownLength: req.file.size
    });

    const headers = {
      Authorization: req.headers.authorization || "",
      ...form.getHeaders()
    };

    const contentLength = await new Promise((resolve, reject) => {
      form.getLength((err, length) => {
        if (err) reject(err);
        else resolve(length);
      });
    });

    headers["Content-Length"] = contentLength;

    const response = await axios.post(
      FILE_SERVICE + "/files/upload",
      form,
      {
        headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 10000
      }
    );

    res.status(response.status).send(response.data);
  } catch (error) {
    console.error("File Gateway Error:", error.message);
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }
    res.status(500).send("File Gateway Error");
  }
});

async function startServer() {
  await setupRedis();

  app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
  });
}

startServer();
