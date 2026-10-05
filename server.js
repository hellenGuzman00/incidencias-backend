require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json());

// Servir la carpeta de imágenes
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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

// Configuración de Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

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
    const imagen = req.file ? req.file.filename : null;
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