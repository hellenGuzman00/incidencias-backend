require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs"); // Importado para manejar el sistema de archivos

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURACIÓN DE ALMACENAMIENTO (MÉTODO)
// ==========================================
// Cambia a 'true' cuando configures tus claves de Cloudinary en el archivo .env
const USAR_CLOUDINARY = false; 

// 1. Asegurar que la carpeta 'uploads' exista localmente al arrancar el servidor
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Servir la carpeta de imágenes de forma estática (para acceso local)
app.use("/uploads", express.static(uploadsDir));

// 2. Configuración de Multer según la opción elegida
let upload;

if (USAR_CLOUDINARY) {
    const cloudinary = require("cloudinary").v2;
    const { CloudinaryStorage } = require("multer-storage-cloudinary");

    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });

    const cloudinaryStorage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: "incidencias",
            allowed_formats: ["jpg", "png", "jpeg"]
        }
    });

    upload = multer({ storage: cloudinaryStorage });
} else {
    // Almacenamiento local (usando la ruta absoluta asegurada)
    const localStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, uploadsDir);
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + path.extname(file.originalname));
        }
    });

    upload = multer({ storage: localStorage });
}

// ==========================================
// CONEXIÓN A LA BASE DE DATOS (AIVEN)
// ==========================================
const conexion = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
});

conexion.connect((error) => {
    if (error) {
        console.error("Error de conexión:", error);
    } else {
        console.log("Conectado a la base de datos en Aiven");
    }
});

// ==========================================
// RUTAS DE LA API
// ==========================================

// Obtener categorías
app.get("/categorias", (req, res) => {
    conexion.query("SELECT * FROM categorias", (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Obtener lista de incidencias
app.get("/incidencias", (req, res) => {
    const sql = `
        SELECT i.id, i.descripcion, i.estado, i.fecha, i.imagen, c.nombre AS categoria
        FROM incidencias i
        JOIN categorias c ON i.categoria_id = c.id
        ORDER BY i.fecha DESC
    `;
    conexion.query(sql, (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Registrar incidencia con imagen
app.post("/incidencias", upload.single("imagen"), (req, res) => {
    const { categoria_id, descripcion } = req.body;
    
    // Si usa Cloudinary guarda la URL completa (req.file.path), si no, guarda el nombre local del archivo (req.file.filename)
    let imagen = null;
    if (req.file) {
        imagen = USAR_CLOUDINARY ? req.file.path : req.file.filename;
    }

    const sql = "INSERT INTO incidencias (categoria_id, descripcion, imagen) VALUES (?, ?, ?)";

    conexion.query(sql, [categoria_id, descripcion, imagen], (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json({
            mensaje: "Incidencia registrada correctamente",
            id: resultado.insertId
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor iniciado en el puerto ${PORT}`);
});

// Obtener estadísticas agrupadas por categoría
app.get("/estadisticas/categorias", (req, res) => {
    const sql = `
        SELECT c.nombre AS categoria, COUNT(i.id) AS total
        FROM categorias c
        LEFT JOIN incidencias i ON c.id = i.categoria_id
        GROUP BY c.id, c.nombre
    `;
    conexion.query(sql, (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Obtener estadísticas agrupadas por estado (Pendiente vs Resuelto)
app.get("/estadisticas/estados", (req, res) => {
    const sql = `
        SELECT estado, COUNT(id) AS total
        FROM incidencias
        GROUP BY estado
    `;
    conexion.query(sql, (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});
// Obtener únicamente incidencias RESUELTAS
app.get("/incidencias/resueltas", (req, res) => {
    const sql = `
        SELECT i.id, i.descripcion, i.estado, i.fecha, i.imagen, c.nombre AS categoria
        FROM incidencias i
        JOIN categorias c ON i.categoria_id = c.id
        WHERE i.estado = 'Resuelto'
        ORDER BY i.fecha DESC
    `;
    conexion.query(sql, (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Cambiar estado de una incidencia (Pendiente -> Resuelto)
app.put("/incidencias/:id/estado", (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    const sql = "UPDATE incidencias SET estado = ? WHERE id = ?";
    conexion.query(sql, [estado, id], (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json({ mensaje: "Estado actualizado correctamente" });
    });
});