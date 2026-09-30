require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const conexion = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false } // Aiven requiere SSL
});

conexion.connect((error) => {
    if (error) {
        console.error("Error de conexión:", error);
    } else {
        console.log("Conectado a la base de datos en Aiven");
    }
});

// Obtener categorías
app.get("/categorias", (req, res) => {
    conexion.query("SELECT * FROM categorias", (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Registrar incidencia
app.post("/incidencias", (req, res) => {
    const { categoria_id, descripcion } = req.body;
    const sql = "INSERT INTO incidencias(categoria_id, descripcion) VALUES (?,?)";
    conexion.query(sql, [categoria_id, descripcion], (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json({ mensaje: "Incidencia registrada correctamente" });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
});
