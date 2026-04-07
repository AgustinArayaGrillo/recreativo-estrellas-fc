const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const { pool, initDB } = require('./db');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const BASE_URL = process.env.BASE_URL || 'https://recreativo-estrellas-fc-production.up.railway.app';

function getMPClient() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return null;
  return new MercadoPagoConfig({ accessToken: token });
}

const app    = express();
const PORT   = process.env.PORT || 3001;
const SECRET = process.env.JWT_SECRET || 'refc_secret_2024';

app.use(cors());
app.use(express.json());

// ─── SERVIR FRONTEND ───
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// ─── MIDDLEWARE AUTH ───
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function soloAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}

// ═══════════════════════════════════
//  AUTH
// ═══════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });

  const { rows } = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = jwt.sign({ id: user.id, usuario: user.usuario, rol: user.rol }, SECRET, { expiresIn: '8h' });
  res.json({ token, usuario: user.usuario, rol: user.rol });
});

// ═══════════════════════════════════
//  STATS
// ═══════════════════════════════════
app.get('/api/stats', auth, async (req, res) => {
  const mes = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  const total  = parseInt((await pool.query('SELECT COUNT(*) as c FROM socios')).rows[0].c);
  const alDia  = parseInt((await pool.query("SELECT COUNT(*) as c FROM socios WHERE estado = 'al-dia'")).rows[0].c);
  const deuda  = parseInt((await pool.query("SELECT COUNT(*) as c FROM socios WHERE estado = 'deuda'")).rows[0].c);
  const recaud = parseFloat((await pool.query(
    "SELECT COALESCE(SUM(monto),0) as total FROM cuotas WHERE pagado = 1 AND mes LIKE $1",
    [`${mes}%`]
  )).rows[0].total);

  res.json({ total, alDia, deuda, recaudadoMes: recaud });
});

// ═══════════════════════════════════
//  SOCIOS
// ═══════════════════════════════════
app.get('/api/socios', auth, async (req, res) => {
  const { q, estado } = req.query;
  let sql = 'SELECT * FROM socios WHERE 1=1';
  const params = [];
  let idx = 1;

  if (q) {
    sql += ` AND (nombre || ' ' || apellido ILIKE $${idx} OR dni ILIKE $${idx + 1})`;
    params.push(`%${q}%`, `%${q}%`);
    idx += 2;
  }
  if (estado) {
    sql += ` AND estado = $${idx}`;
    params.push(estado);
    idx++;
  }

  sql += ' ORDER BY id DESC';
  const socios = (await pool.query(sql, params)).rows;

  const withCuotas = await Promise.all(socios.map(async s => ({
    ...s,
    cuotas_pagas: parseInt((await pool.query(
      'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [s.id]
    )).rows[0].c)
  })));

  res.json(withCuotas);
});

app.get('/api/socios/dni/:dni', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM socios WHERE dni = $1', [req.params.dni]);
  const socio = rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const cuotas_pagas = parseInt((await pool.query(
    'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [socio.id]
  )).rows[0].c);
  const cuotas = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 ORDER BY mes DESC', [socio.id]
  )).rows;

  res.json({ ...socio, cuotas_pagas, cuotas });
});

app.get('/api/socios/:id', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM socios WHERE id = $1', [req.params.id]);
  const socio = rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const cuotas_pagas = parseInt((await pool.query(
    'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [socio.id]
  )).rows[0].c);
  const cuotas = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 ORDER BY mes DESC', [socio.id]
  )).rows;

  res.json({ ...socio, cuotas_pagas, cuotas });
});

app.post('/api/socios', auth, soloAdmin, async (req, res) => {
  const { nombre, apellido, dni, telefono, email, direccion, fecha_nac, fecha_ingreso, categoria, estado, observaciones } = req.body;

  if (!nombre || !apellido || !dni || !telefono) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const existe = (await pool.query('SELECT id FROM socios WHERE dni = $1', [dni])).rows[0];
  if (existe) return res.status(409).json({ error: 'Ya existe un socio con ese DNI' });

  const result = await pool.query(`
    INSERT INTO socios (nombre, apellido, dni, telefono, email, direccion, fecha_nac, fecha_ingreso, categoria, estado, observaciones)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    nombre, apellido, dni, telefono,
    email || null, direccion || null, fecha_nac || null,
    fecha_ingreso || new Date().toISOString().split('T')[0],
    categoria || 'general', estado || 'al-dia', observaciones || null
  ]);

  res.status(201).json({ id: result.rows[0].id, mensaje: 'Socio registrado' });
});

app.put('/api/socios/:id', auth, soloAdmin, async (req, res) => {
  const { nombre, apellido, dni, telefono, email, direccion, fecha_nac, categoria, estado, observaciones } = req.body;

  const socio = (await pool.query('SELECT id FROM socios WHERE id = $1', [req.params.id])).rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  await pool.query(`
    UPDATE socios SET nombre=$1, apellido=$2, dni=$3, telefono=$4, email=$5,
      direccion=$6, fecha_nac=$7, categoria=$8, estado=$9, observaciones=$10
    WHERE id=$11
  `, [nombre, apellido, dni, telefono, email || null, direccion || null,
      fecha_nac || null, categoria, estado, observaciones || null, req.params.id]);

  res.json({ mensaje: 'Socio actualizado' });
});

app.delete('/api/socios/:id', auth, soloAdmin, async (req, res) => {
  const socio = (await pool.query('SELECT id FROM socios WHERE id = $1', [req.params.id])).rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  await pool.query('DELETE FROM socios WHERE id = $1', [req.params.id]);
  res.json({ mensaje: 'Socio eliminado' });
});

// ═══════════════════════════════════
//  CUOTAS
// ═══════════════════════════════════
app.post('/api/cuotas', auth, soloAdmin, async (req, res) => {
  const { socio_id, mes, monto, pagado, fecha_pago, notas } = req.body;
  if (!socio_id || !mes) return res.status(400).json({ error: 'Faltan datos' });

  const result = await pool.query(`
    INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, notas)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [socio_id, mes, monto || 0, pagado ? 1 : 0, fecha_pago || null, notas || null]);

  if (pagado) {
    await pool.query("UPDATE socios SET estado = 'al-dia' WHERE id = $1", [socio_id]);
  }

  res.status(201).json({ id: result.rows[0].id });
});

app.put('/api/cuotas/:id/pagar', auth, soloAdmin, async (req, res) => {
  const { monto, fecha_pago, comprobante } = req.body;
  const cuota = (await pool.query('SELECT * FROM cuotas WHERE id = $1', [req.params.id])).rows[0];
  if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

  await pool.query(
    'UPDATE cuotas SET pagado=1, monto=$1, fecha_pago=$2, comprobante=$3 WHERE id=$4',
    [monto || cuota.monto, fecha_pago || new Date().toISOString().split('T')[0], comprobante || null, req.params.id]
  );

  await pool.query("UPDATE socios SET estado='al-dia' WHERE id=$1", [cuota.socio_id]);
  res.json({ mensaje: 'Cuota registrada como pagada' });
});

// ═══════════════════════════════════
//  HACERSE SOCIO — MERCADO PAGO
// ═══════════════════════════════════
app.post('/api/solicitudes', async (req, res) => {
  const { nombre, apellido, dni, telefono } = req.body;
  if (!nombre || !apellido || !dni || !telefono) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const existeSocio = (await pool.query('SELECT id FROM socios WHERE dni = $1', [dni])).rows[0];
  if (existeSocio) return res.status(409).json({ error: 'Ya existe un socio registrado con ese DNI' });

  const existeSolicitud = (await pool.query(
    "SELECT id FROM solicitudes WHERE dni = $1 AND estado = 'pendiente'", [dni]
  )).rows[0];
  if (existeSolicitud) return res.status(409).json({ error: 'Ya existe una solicitud pendiente con ese DNI' });

  const result = await pool.query(
    'INSERT INTO solicitudes (nombre, apellido, dni, telefono) VALUES ($1, $2, $3, $4) RETURNING id',
    [nombre, apellido, dni, telefono]
  );
  const solicitudId = result.rows[0].id;

  const mpClient = getMPClient();
  if (!mpClient) {
    return res.json({ init_point: `${BASE_URL}/pago-pendiente.html`, mp_configurado: false });
  }

  try {
    const preference = new Preference(mpClient);
    const pref = await preference.create({
      body: {
        items: [{
          title: 'Cuota de ingreso - Recreativo Estrellas F.C.',
          quantity: 1,
          unit_price: 10000,
          currency_id: 'ARS'
        }],
        payer: { name: nombre, surname: apellido },
        external_reference: String(solicitudId),
        back_urls: {
          success: `${BASE_URL}/pago-exitoso.html`,
          failure: `${BASE_URL}/pago-fallido.html`,
          pending: `${BASE_URL}/pago-pendiente.html`
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/mp-webhook`
      }
    });

    await pool.query('UPDATE solicitudes SET mp_preference_id = $1 WHERE id = $2', [pref.id, solicitudId]);
    res.json({ init_point: pref.init_point });
  } catch (err) {
    console.error('Error MP:', err);
    res.status(500).json({ error: 'Error al crear preferencia de pago. Intentá de nuevo.' });
  }
});

app.post('/api/mp-webhook', async (req, res) => {
  res.sendStatus(200);

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  const mpClient = getMPClient();
  if (!mpClient) return;

  try {
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: data.id });

    if (payment.status !== 'approved') return;

    const solicitudId = payment.external_reference;
    const solicitud = (await pool.query('SELECT * FROM solicitudes WHERE id = $1', [solicitudId])).rows[0];
    if (!solicitud || solicitud.estado === 'aprobado') return;

    const socioResult = await pool.query(`
      INSERT INTO socios (nombre, apellido, dni, telefono, categoria, estado)
      VALUES ($1, $2, $3, $4, 'general', 'al-dia')
      RETURNING id
    `, [solicitud.nombre, solicitud.apellido, solicitud.dni, solicitud.telefono]);

    const now = new Date();
    const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await pool.query(`
      INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, comprobante, notas)
      VALUES ($1, $2, 10000, 1, $3, $4, 'Pago via Mercado Pago — cuota de ingreso')
    `, [socioResult.rows[0].id, mes, now.toISOString().split('T')[0], String(payment.id)]);

    await pool.query(
      "UPDATE solicitudes SET estado = 'aprobado', mp_payment_id = $1 WHERE id = $2",
      [String(payment.id), solicitudId]
    );

    console.log(`✅ Nuevo socio registrado: ${solicitud.nombre} ${solicitud.apellido} (DNI ${solicitud.dni})`);
  } catch (err) {
    console.error('Error procesando webhook MP:', err);
  }
});

// ─── CATCH-ALL → login ───
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ─── START ───
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 REFC Backend corriendo en http://localhost:${PORT}`);
      console.log(`   Usuarios disponibles:`);
      console.log(`   • admin  / refc2024   (administrador)`);
      console.log(`   • puerta / puerta123  (consulta en puerta)\n`);
    });
  })
  .catch(err => {
    console.error('Error inicializando DB:', err);
    process.exit(1);
  });
