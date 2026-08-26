const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// Configuração do Transportador SMTP (Mailtrap)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io',
  port: process.env.SMTP_PORT || 2525,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Cadastro com Hash de Senha (bcrypt)
app.post('/register', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Dados incompletos.' });

  try {
    const hash = await bcrypt.hash(senha, 10);
    const userRole = role || 'usuario';
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)',
      [nome, email, hash, userRole]
    );
    res.json({ success: true, userId: result.insertId, role: userRole });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'E-mail em uso.' });
    res.status(500).json({ error: 'Erro no cadastro.' });
  }
});

// Login com Validação de Hash
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const user = rows[0];
    const match = await bcrypt.compare(senha, user.senha_hash);
    if (!match) return res.status(401).json({ error: 'Credenciais inválidas.' });

    res.json({ success: true, userId: user.id, nome: user.nome, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Erro no login.' });
  }
});

// Solicitação de Recuperação de Senha (Expira em 30 min)
app.post('/forgot-password', async (req, res) => {
  const { email, appUrl } = req.body;
  try {
    const [rows] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(404).json({ error: 'E-mail não encontrado.' });

    const userId = rows[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + 30 * 60 * 1000); // +30 minutos

    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, criado_em, expira_em, usado) VALUES (?, ?, ?, ?, 0)',
      [token, userId, agora, expiraEm]
    );

    const resetLink = `${appUrl}/reset-password.html?token=${token}`;
    
    await transporter.sendMail({
      from: '"Catálogo Tom Hanks" <no-reply@catalogo.com>',
      to: email,
      subject: 'Recuperação de Senha',
      html: `<p>Você solicitou a redefinição de senha.</p>
             <p>Clique no link abaixo para alterar (válido por 30 minutos):</p>
             <a href="${resetLink}">${resetLink}</a>`
    });

    res.json({ success: true, message: 'E-mail enviado via Mailtrap.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar recuperação.' });
  }
});

// Troca de Senha com Validação de Token
app.post('/reset-password', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha) return res.status(400).json({ error: 'Dados incompletos.' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM reset_tokens WHERE token = ? AND usado = 0',
      [token]
    );

    if (rows.length === 0) return res.status(400).json({ error: 'Token inválido ou já utilizado.' });

    const resetRecord = rows[0];
    const agora = new Date();

    if (agora > new Date(resetRecord.expira_em)) {
      return res.status(400).json({ error: 'Token expirado. Solicite um novo link.' });
    }

    const hash = await bcrypt.hash(novaSenha, 10);
    
    await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hash, resetRecord.usuario_id]);
    await pool.query('UPDATE reset_tokens SET usado = 1 WHERE id = ?', [resetRecord.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao redefinir a senha.' });
  }
});

// Consulta de Dados e Papéis do Usuário
app.get('/verify-user/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nome, email, role FROM usuarios WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar dados.' });
  }
});

app.listen(3000, () => console.log('Auth Service rodando na porta interna 3000'));