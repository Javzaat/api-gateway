// =====================================================
// API Gateway Service
// Lab 08: API Gateway, Redis Caching & VPC Security
// -----------------------------------------------------
// Энэ service нь frontend-ээс ирж буй бүх public request-ийг
// нэг цэгээр хүлээн авч, дотоод backend service-үүд рүү proxy хийдэг.
//
// Гол үүргүүд:
// 1. /api/users/**  -> User JSON Service рүү дамжуулах
// 2. /api/soap/**   -> User SOAP Authentication Service рүү дамжуулах
// 3. /api/files/upload -> File Manager Service рүү дамжуулах
// 4. GET /api/users request-ийн response-ийг Redis cache-д хадгалах
// 5. POST/PUT/DELETE үед cache invalidation хийх
// =====================================================

// Express framework ашиглаж HTTP server үүсгэнэ.
const express = require("express");

// CORS middleware. Frontend өөр domain дээр байж болох тул cross-origin request зөвшөөрнө.
const cors = require("cors");

// Axios ашиглаж Gateway-аас дотоод service-үүд рүү HTTP request илгээнэ.
const axios = require("axios");

// Redis client. GET request-ийн response-ийг cache хийхэд ашиглана.
const { createClient } = require("redis");

// Multer нь frontend-ээс ирж буй multipart/form-data file upload request-ийг уншина.
const multer = require("multer");

// FormData нь Gateway дээр авсан файлыг File Manager Service рүү дахин multipart хэлбэрээр дамжуулахад хэрэгтэй.
const FormData = require("form-data");

const app = express();

// Frontend-ээс ирэх request-үүдийг зөвшөөрнө.
app.use(cors());

// JSON body-тэй request-ийг parse хийнэ. Жишээ нь profile create/update.
app.use(express.json());

// SOAP request нь XML/text хэлбэртэй ирдэг тул text parser ашиглаж байна.
app.use(express.text({ type: ["text/xml", "application/soap+xml"] }));

// =====================================================
// Internal Service URLs
// -----------------------------------------------------
// Эдгээр URL-ууд нь DigitalOcean VPC доторх private IP-ууд.
// Frontend эдгээр service рүү шууд хандахгүй.
// Зөвхөн API Gateway дотоод private network-ээр хандана.
// =====================================================

const JSON_SERVICE = process.env.JSON_SERVICE || "http://10.104.0.4:8080";
const SOAP_SERVICE = process.env.SOAP_SERVICE || "http://10.104.0.6:8081/ws";
const FILE_SERVICE = process.env.FILE_SERVICE || "http://10.104.0.7:8082";

// Redis нь Gateway droplet дээр localhost дээр ажиллаж байгаа.
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// Gateway-ийн public port. Caddy HTTPS reverse proxy нь 443-аас энэ 3000 port руу дамжуулна.
const PORT = process.env.PORT || 3000;

// File upload-ийг memory дээр түр хадгална.
// Дараа нь Gateway File Manager Service рүү дамжуулна.
const upload = multer({ storage: multer.memoryStorage() });

// Redis connection object.
let redisClient = null;

// Redis ажиллаж байгаа эсэхийг хадгалах flag.
// Redis унтарсан үед Gateway өөрөө унахгүй, cache-гүйгээр backend рүү шууд явна.
let redisAvailable = false;

// =====================================================
// Redis setup
// -----------------------------------------------------
// Redis-тэй холбогдох function.
// Redis unavailable болсон үед Gateway-г crash болгохгүй.
// Энэ нь stability-д чухал.
// =====================================================
async function setupRedis() {
  try {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        // Redis connection тасарсан үед автоматаар дахин дахин reconnect хийхгүй.
        // Ингэснээр client closed error давтагдахгүй.
        reconnectStrategy: false
      }
    });

    // Redis дээр error гарвал cache ашиглахгүй болгож тэмдэглэнэ.
    redisClient.on("error", (err) => {
      redisAvailable = false;
      console.log("Redis error:", err.message);
    });

    // Redis connection хаагдсан үед cache unavailable гэж тэмдэглэнэ.
    redisClient.on("end", () => {
      redisAvailable = false;
      console.log("Redis connection closed");
    });

    // Redis бэлэн болсон үед flag true болно.
    redisClient.on("ready", () => {
      redisAvailable = true;
      console.log("Redis ready");
    });

    await redisClient.connect();

    redisAvailable = true;
    console.log("Connected to Redis");
  } catch (error) {
    // Redis байхгүй байсан ч Gateway ажилласаар байна.
    // Энэ нь Redis dependency-ээс болж бүх system унахаас хамгаална.
    redisAvailable = false;
    console.log("Redis unavailable. Running without cache.");
  }
}

// =====================================================
// Cache read function
// -----------------------------------------------------
// GET request ирэхэд эхлээд Redis cache-аас хайна.
// Байвал Cache HIT гэж log гаргаад cached response буцаана.
// =====================================================
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
    // Redis унтарсан эсвэл client closed болсон үед Gateway алдаа өгөхгүй.
    redisAvailable = false;
    console.log("Redis GET failed:", error.message);
  }

  return null;
}

// =====================================================
// Cache write function
// -----------------------------------------------------
// Backend service-ээс response авсны дараа Redis-д хадгална.
// 60 секунд TTL ашигласан.
// =====================================================
async function setCachedData(cacheKey, data) {
  try {
    if (redisAvailable && redisClient && redisClient.isOpen) {
      await redisClient.setEx(cacheKey, 60, JSON.stringify(data));

      // Энэ log нь cache miss болсон request backend рүү очоод
      // дараа нь Redis-д хадгалагдсаныг харуулна.
      console.log("CACHE MISS:", cacheKey);
    }
  } catch (error) {
    redisAvailable = false;
    console.log("Redis SET failed:", error.message);
  }
}

// =====================================================
// Cache invalidation
// -----------------------------------------------------
// Profile data өөрчлөгдөх үед хуучин cache буруу болох боломжтой.
// Тиймээс POST, PUT, DELETE request-ийн дараа /api/users cache-ийг устгана.
// =====================================================
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

// =====================================================
// Health check endpoint
// -----------------------------------------------------
// Gateway ажиллаж байгаа эсэхийг шалгах энгийн endpoint.
// =====================================================
app.get("/", (req, res) => {
  res.send("API Gateway ажиллаж байна");
});

// =====================================================
// User JSON Service proxy
// -----------------------------------------------------
// Frontend-ийн /api/users request-үүд энд ирнэ.
// Gateway нь энэ request-ийг User JSON Service-ийн /users endpoint рүү дамжуулна.
//
// Жишээ:
// Frontend -> GET /api/users
// Gateway  -> GET http://10.104.0.4:8080/users
//
// Frontend -> PUT /api/users/1
// Gateway  -> PUT http://10.104.0.4:8080/users/1
// =====================================================
app.use("/api/users", async (req, res) => {
  const cacheKey = req.originalUrl;

  try {
    // Зөвхөн GET request дээр cache ашиглана.
    // Учир нь GET нь data унших operation, side effect байхгүй.
    if (req.method === "GET") {
      const cachedData = await getCachedData(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }
    }

    // Cache байхгүй үед буюу non-GET request үед JSON service рүү request дамжуулна.
    const response = await axios({
      method: req.method,
      url: JSON_SERVICE + "/users" + req.originalUrl.replace("/api/users", ""),
      data: req.body,
      headers: {
        // Frontend-ээс ирсэн token-ийг JSON service рүү дамжуулна.
        // JSON service энэ token-ийг SOAP service-ээр validate хийдэг.
        Authorization: req.headers.authorization || "",
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    // GET response-ийг Redis cache-д хадгална.
    if (req.method === "GET") {
      await setCachedData(cacheKey, response.data);
    }

    // Data өөрчлөгдсөн үед cache устгана.
    if (["POST", "PUT", "DELETE"].includes(req.method)) {
      await invalidateUsersCache();
    }

    // Backend service-ээс ирсэн status болон data-г frontend рүү буцаана.
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("Gateway Error:", error.message);

    // Backend service 401, 404, 500 гэх мэт status буцаасан бол тэр status-ыг frontend рүү дамжуулна.
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }

    // Network timeout, service unavailable гэх мэт үед Gateway Error буцаана.
    res.status(500).send("Gateway Error");
  }
});

// =====================================================
// SOAP Authentication Service proxy
// -----------------------------------------------------
// Register, Login, ValidateToken зэрэг SOAP XML request-үүдийг
// SOAP service рүү дамжуулна.
// =====================================================
app.use("/api/soap", async (req, res) => {
  try {
    const response = await axios({
      method: req.method,
      url: SOAP_SERVICE,
      data: req.body,
      headers: {
        // SOAP request XML байдаг тул content-type-ийг хадгалж дамжуулна.
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

// =====================================================
// File Manager Service proxy
// -----------------------------------------------------
// Frontend-ээс ирсэн image upload request-ийг Gateway хүлээн авч,
// File Manager Service рүү multipart/form-data хэлбэрээр дамжуулна.
//
// File Manager Service нь зураг DigitalOcean Spaces рүү upload хийгээд
// public image URL буцаадаг.
// =====================================================
app.post("/api/files/upload", upload.single("file"), async (req, res) => {
  try {
    // file field байхгүй бол 400 Bad Request буцаана.
    if (!req.file) {
      return res.status(400).send("File not provided");
    }

    // File Manager Service рүү илгээх multipart form үүсгэнэ.
    const form = new FormData();

    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      knownLength: req.file.size
    });

    // Authorization token-ийг File Manager Service рүү дамжуулна.
    // Ингэснээр File Manager request мөн auth хамгаалалттай байна.
    const headers = {
      Authorization: req.headers.authorization || "",
      ...form.getHeaders()
    };

    // Content-Length-ийг тооцож header дээр тавина.
    const contentLength = await new Promise((resolve, reject) => {
      form.getLength((err, length) => {
        if (err) reject(err);
        else resolve(length);
      });
    });

    headers["Content-Length"] = contentLength;

    // File Manager Service-ийн upload endpoint рүү request дамжуулна.
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

    // File Manager-аас ирсэн image URL эсвэл response-ийг frontend рүү буцаана.
    res.status(response.status).send(response.data);
  } catch (error) {
    console.error("File Gateway Error:", error.message);

    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }

    res.status(500).send("File Gateway Error");
  }
});

// =====================================================
// Server start
// -----------------------------------------------------
// Эхлээд Redis setup хийнэ.
// Redis ажиллахгүй байсан ч Gateway server асна.
// =====================================================
async function startServer() {
  await setupRedis();

  app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
  });
}

startServer();