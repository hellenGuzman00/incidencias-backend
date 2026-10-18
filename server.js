require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// SEGURIDAD: secreto del JWT (viene del .env / variables de Render)
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error("FALTA la variable de entorno JWT_SECRET: el login no va a funcionar.");
}

// ==========================================
// CONFIGURACIÓN DE ALMACENAMIENTO (MÉTODO)
// ==========================================
// Cambia a 'true' cuando configures tus claves de Cloudinary en el archivo .env
const USAR_CLOUDINARY = false;

// Asegurar que la carpeta 'uploads' exista al arrancar el servidor
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

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
// MIDDLEWARES DE AUTENTICACIÓN Y ROLES
// ==========================================

// Verifica que la petición traiga un JWT válido en "Authorization: Bearer <token>"
const verificarToken = (req, res, next) => {
    const header = req.headers["authorization"];
    if (!header) {
        return res.status(403).json({ mensaje: "Token requerido" });
    }

    try {
        const token = header.startsWith("Bearer ") ? header.slice(7) : header;
        req.usuario = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ mensaje: "Token inválido o expirado" });
    }
};

// Solo deja pasar a usuarios con rol Admin (se usa después de verificarToken)
const soloAdmin = (req, res, next) => {
    if (req.usuario.rol !== "Admin") {
        return res.status(403).json({
            mensaje: "Acceso denegado. Se requieren permisos de Administrador."
        });
    }
    next();
};

// ==========================================
// AUTENTICACIÓN
// ==========================================

// Registro público: SIEMPRE crea usuarios con rol "Usuario".
// Para crear un Admin se cambia el rol directamente en la base de datos (MySQL Workbench).
app.post("/registro", async (req, res) => {
    const nombre = String(req.body.nombre || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!nombre || !email || !password) {
        return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
    }
    if (!email.includes("@")) {
        return res.status(400).json({ mensaje: "Ingrese un correo válido" });
    }
    if (password.length < 6) {
        return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, 'Usuario')";
        conexion.query(sql, [nombre, email, hashedPassword], (error) => {
            if (error) {
                if (error.code === "ER_DUP_ENTRY") {
                    return res.status(409).json({ mensaje: "El correo ya está registrado" });
                }
                console.error(error);
                return res.status(500).json({ mensaje: "Error al registrar el usuario" });
            }
            res.json({ mensaje: "Usuario registrado correctamente" });
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ mensaje: "Error al procesar el registro" });
    }
});

// Inicio de sesión
app.post("/login", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
        return res.status(400).json({ mensaje: "Ingrese correo y contraseña" });
    }

    const sql = "SELECT * FROM usuarios WHERE email = ?";
    conexion.query(sql, [email], async (error, resultado) => {
        if (error) {
            console.error(error);
            return res.status(500).json({ mensaje: "Error del servidor" });
        }

        try {
            // Mismo mensaje para "no existe" y "clave incorrecta": no revela qué correos están registrados
            if (resultado.length === 0) {
                return res.status(401).json({ mensaje: "Correo o contraseña incorrectos" });
            }

            const usuario = resultado[0];
            const passwordValida = await bcrypt.compare(password, usuario.password);
            if (!passwordValida) {
                return res.status(401).json({ mensaje: "Correo o contraseña incorrectos" });
            }

            const token = jwt.sign(
                { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
                JWT_SECRET,
                { expiresIn: "8h" }
            );

            res.json({
                mensaje: "Inicio de sesión exitoso",
                token,
                usuario: {
                    id: usuario.id,
                    nombre: usuario.nombre,
                    email: usuario.email,
                    rol: usuario.rol
                }
            });
        } catch (e) {
            console.error(e);
            res.status(500).json({ mensaje: "Error al iniciar sesión" });
        }
    });
});

// Perfil del usuario autenticado (Guía 8).
// Valida el token (verificarToken) y devuelve los datos ACTUALES desde la base de datos.
// Nunca se devuelve la contraseña: se listan las columnas una por una.
app.get("/perfil", verificarToken, (req, res) => {
    const sql =
        "SELECT id, nombre, email, rol, fecha_registro FROM usuarios WHERE id = ?";

    conexion.query(sql, [req.usuario.id], (error, resultado) => {
        if (error) {
            console.error(error);
            return res.status(500).json({ mensaje: "Error al obtener el perfil" });
        }
        if (resultado.length === 0) {
            return res.status(404).json({ mensaje: "Usuario no encontrado" });
        }
        res.json(resultado[0]);
    });
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

// Obtener incidencias con búsqueda y filtros opcionales (Guía 7):
//   GET /incidencias?buscar=texto&categoria_id=2&estado=Pendiente
// Todos los parámetros son opcionales y se pueden combinar.
app.get("/incidencias", (req, res) => {
    // String(...) evita que un parámetro repetido (?buscar=a&buscar=b) llegue como arreglo
    const buscar = String(req.query.buscar || "").trim();
    const categoria_id = String(req.query.categoria_id || "").trim();
    const estado = String(req.query.estado || "").trim();

    let sql = `
        SELECT i.id, i.descripcion, i.estado, i.fecha, i.imagen,
               c.nombre AS categoria, u.nombre AS usuario
        FROM incidencias i
        JOIN categorias c ON i.categoria_id = c.id
        LEFT JOIN usuarios u ON i.usuario_id = u.id
        WHERE 1=1
    `;
    // Los valores nunca se concatenan al SQL: van como parámetros (?) para evitar inyección SQL
    const parametros = [];

    if (buscar) {
        sql += " AND i.descripcion LIKE ?";
        parametros.push(`%${buscar}%`);
    }
    if (categoria_id) {
        sql += " AND i.categoria_id = ?";
        parametros.push(categoria_id);
    }
    if (estado) {
        sql += " AND i.estado = ?";
        parametros.push(estado);
    }

    sql += " ORDER BY i.fecha DESC, i.id DESC";

    conexion.query(sql, parametros, (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Incidencias para exportar a PDF por rango de fechas (Guía 9). Requiere sesión iniciada.
//   GET /incidencias/exportar?fecha_inicio=2026-10-01&fecha_fin=2026-10-31&tz=-06:00
// - fecha_inicio y fecha_fin son opcionales: se puede mandar una sola o ninguna (todo el historial).
// - tz es la zona horaria del usuario. La base de datos guarda la hora en UTC, así que sin esto
//   un reporte hecho a las 8 pm en El Salvador cae "al día siguiente" y no saldría en el reporte de hoy.
app.get("/incidencias/exportar", verificarToken, (req, res) => {
    const fecha_inicio = String(req.query.fecha_inicio || "").trim();
    const fecha_fin = String(req.query.fecha_fin || "").trim();
    const tz = String(req.query.tz || "+00:00").trim();

    const formatoFecha = /^\d{4}-\d{2}-\d{2}$/;
    if ((fecha_inicio && !formatoFecha.test(fecha_inicio)) ||
        (fecha_fin && !formatoFecha.test(fecha_fin))) {
        return res.status(400).json({ mensaje: "Formato de fecha inválido (use AAAA-MM-DD)" });
    }
    if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(tz)) {
        return res.status(400).json({ mensaje: "Zona horaria inválida (use el formato -06:00)" });
    }
    if (fecha_inicio && fecha_fin && fecha_inicio > fecha_fin) {
        return res.status(400).json({
            mensaje: "La fecha de inicio no puede ser posterior a la fecha de fin"
        });
    }

    // Fecha del reporte según la zona horaria del usuario
    const fechaLocal = "DATE(CONVERT_TZ(i.fecha, '+00:00', ?))";

    let sql = `
        SELECT i.id, i.descripcion, i.estado, i.fecha, c.nombre AS categoria
        FROM incidencias i
        JOIN categorias c ON i.categoria_id = c.id
        WHERE 1=1
    `;
    // Los valores van como parámetros (?): nunca se concatenan al SQL
    const parametros = [];

    if (fecha_inicio) {
        sql += ` AND ${fechaLocal} >= ?`;
        parametros.push(tz, fecha_inicio);
    }
    if (fecha_fin) {
        sql += ` AND ${fechaLocal} <= ?`;
        parametros.push(tz, fecha_fin);
    }

    sql += " ORDER BY i.fecha DESC, i.id DESC";

    conexion.query(sql, parametros, (error, resultado) => {
        if (error) {
            console.error(error);
            return res.status(500).json({ mensaje: "Error al consultar las incidencias" });
        }
        res.json(resultado);
    });
});

// Obtener únicamente incidencias RESUELTAS
app.get("/incidencias/resueltas", (req, res) => {
    const sql = `
        SELECT i.id, i.descripcion, i.estado, i.fecha, i.imagen,
               c.nombre AS categoria, u.nombre AS usuario
        FROM incidencias i
        JOIN categorias c ON i.categoria_id = c.id
        LEFT JOIN usuarios u ON i.usuario_id = u.id
        WHERE i.estado = 'Resuelto'
        ORDER BY i.fecha DESC
    `;
    conexion.query(sql, (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json(resultado);
    });
});

// Registrar incidencia con imagen (requiere sesión iniciada)
app.post("/incidencias", verificarToken, upload.single("imagen"), (req, res) => {
    const { categoria_id, descripcion } = req.body;
    const usuario_id = req.usuario.id;

    let imagen = null;
    if (req.file) {
        imagen = USAR_CLOUDINARY ? req.file.path : req.file.filename;
    }

    const sql =
        "INSERT INTO incidencias (usuario_id, categoria_id, descripcion, imagen) VALUES (?, ?, ?, ?)";

    conexion.query(sql, [usuario_id, categoria_id, descripcion, imagen], (error, resultado) => {
        if (error) return res.status(500).json(error);
        res.json({
            mensaje: "Incidencia registrada correctamente",
            id: resultado.insertId
        });
    });
});

// Cambiar estado de una incidencia (solo Admin)
app.put("/incidencias/:id/estado", verificarToken, soloAdmin, (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    const sql = "UPDATE incidencias SET estado = ? WHERE id = ?";
    conexion.query(sql, [estado, id], (error) => {
        if (error) return res.status(500).json(error);
        res.json({ mensaje: "Estado actualizado correctamente" });
    });
});

// Eliminar una incidencia (solo Admin)
app.delete("/incidencias/:id", verificarToken, soloAdmin, (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM incidencias WHERE id = ?";
    conexion.query(sql, [id], (error) => {
        if (error) return res.status(500).json(error);
        res.json({ mensaje: "Incidencia eliminada correctamente" });
    });
});

// Estadísticas agrupadas por categoría
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

// Estadísticas agrupadas por estado (Pendiente vs Resuelto)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor iniciado en el puerto ${PORT} con autenticación JWT`);
});