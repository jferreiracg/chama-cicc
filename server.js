/**
 * Central de Chamados — servidor web
 * Node.js + Express + SQLite (node:sqlite, sem dependências nativas)
 *
 * Rodar:  npm start   (ou: node server.js)
 * URL:    http://localhost:3000
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const mailer = require('./mailer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------- Segurança / config ------------------------- */
// DEMO=true  -> mostra as contas de demonstração na tela de login (uso local)
// (na produção, rode SEM essa variável para ocultar as credenciais)
const DEMO = process.env.DEMO === 'true';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; //7 dias

// Recuperação de senha por e-mail: validade do link enviado
const RESET_TTL_MIN = Math.max(5, Number(process.env.RESET_TTL_MIN) || 30);

// Encerramento automático: um chamado "resolvido" vira "fechado" depois de
// N minutos (AUTO_CLOSE_MIN=0 desliga a rotina). Padrão: 1 minuto.
const AUTO_CLOSE_MIN = (() => {
  const bruto = Number(process.env.AUTO_CLOSE_MIN);
  return Number.isFinite(bruto) && bruto >= 0 ? bruto : 1;
})();

// Limite de tentativas de login
// Cookie com bandeira Secure (exigir HTTPS) — ligue em produção atrás de TLS
const SECURE_COOKIE = process.env.SECURE_COOKIE === 'true';
const LOGIN_WINDOW_MS = 15 * 60 * 1000; //15 minutos
const LOGIN_MAX_POR_CONTA = 5;           // falhas por IP + nome
const LOGIN_MAX_POR_IP = 30;             // falhas por IP (evita varredura de nomes)
const tentativasLogin = new Map();

// Pedidos de recuperação de senha (evita bombardeio de e-mails)
const FORGOT_MAX_POR_IP = 10;            // pedidos por IP na janela
const FORGOT_MAX_POR_CONTA = 3;          // pedidos por conta na janela

// Auto-cadastro, abertura de chamados e comentários (evita spam/abuso)
const CADASTRO_MAX_POR_IP = 10;              // contas por IP/hora
const CHAMADO_MAX_POR_USUARIO = 30;          // chamados por conta/hora
const COMENTARIO_MAX_POR_USUARIO = 60;       // mensagens por conta/10 min

/* Proxy reverso (túnel/nginx): com TRUST_PROXY=true o servidor confia no
   X-Forwarded-For do proxy para contar limites por IP verdadeiro.
   SÓ ligue atrás de um proxy que você controla — caso contrário o IP pode
   ser forjado. Desligado por padrão. */
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

/* Backup automático do banco: cópia consistente (VACUUM INTO) em BACKUP_DIR
   no início do servidor e a cada BACKUP_HORAS, guardando as últimas
   BACKUP_QTD cópias. BACKUP_AUTO=false desliga; BACKUP_DIR muda a pasta. */
const BACKUP_AUTO = process.env.BACKUP_AUTO !== 'false';
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, 'backup');
const BACKUP_QTD = Math.max(1, Number(process.env.BACKUP_QTD) || 10);
const BACKUP_HORAS = Math.max(1, Number(process.env.BACKUP_HORAS) || 24);

/* Bloqueio: só FALHAS de login consomem a cota — entrar corretamente
   não gasta tentativas (várias pessoas podem dividir o mesmo IP). */
function checarBloqueio(chave, limite) {
  const agora = Date.now();
  const entrada = tentativasLogin.get(chave);
  if (!entrada || agora - entrada.inicio > LOGIN_WINDOW_MS) return null;
  if (entrada.count < limite) return null;
  return { esperaSeg: Math.max(1, Math.ceil((entrada.inicio + LOGIN_WINDOW_MS - agora) / 1000)) };
}

function registrarFalha(chave) {
  const agora = Date.now();
  const entrada = tentativasLogin.get(chave);
  if (!entrada || agora - entrada.inicio > LOGIN_WINDOW_MS) {
    tentativasLogin.set(chave, { count: 1, inicio: agora });
  } else {
    entrada.count += 1;
  }
}

/* ------------------- Limite genérico por janela ---------------------- */
/* Usado no auto-cadastro, na abertura de chamados e nos comentários.
   Conta também os pedidos aceitos (quem abre 30 chamados/hora já é abuso). */
const janelasAbuso = new Map();

function limitar(chave, limite, janelaMs) {
  const agora = Date.now();
  let entrada = janelasAbuso.get(chave);
  if (!entrada || agora - entrada.inicio > janelaMs) {
    entrada = { count: 0, inicio: agora };
    janelasAbuso.set(chave, entrada);
  }
  if (entrada.count >= limite) {
    return { esperaSeg: Math.max(1, Math.ceil((entrada.inicio + janelaMs - agora) / 1000)) };
  }
  entrada.count += 1;
  return null;
}

function recusar429(res, bloqueio, mensagem) {
  res.setHeader('Retry-After', String(bloqueio.esperaSeg));
  return res.status(429).json({ error: mensagem });
}

// Varredura periódica: limpa tentativas vencidas e sessões expiradas
setInterval(() => {
  const agora = Date.now();
  for (const [chave, entrada] of tentativasLogin) {
    if (agora - entrada.inicio > LOGIN_WINDOW_MS) tentativasLogin.delete(chave);
  }
  for (const [chave, entrada] of janelasAbuso) {
    if (agora - entrada.inicio > 60 * 60 * 1000) janelasAbuso.delete(chave); // janelas de até 1 h
  }
  try {
    db.prepare('DELETE FROM sessions WHERE created_at < datetime(?)')
      .run(new Date(agora - SESSION_TTL_SECONDS * 1000).toISOString().replace('T', ' ').slice(0, 19));
    // links de recuperação vencidos (mantém por24h após o vencimento)
    db.prepare('DELETE FROM password_resets WHERE expires_at < datetime(?)')
      .run(new Date(agora - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19));
  } catch { /* não crítico */ }
}, 5 * 60 * 1000).unref?.();

/* Encerramento automático: um chamado que ficou "resolvido" por AUTO_CLOSE_MIN
   minutos passa para "fechado" — a rotina varre a cada 15 s e registra no
   console. Quem resolveu continua sendo a conta gravada em closed_by. */
function fecharResolvidos() {
  if (AUTO_CLOSE_MIN <= 0) return 0;
  const info = db
    .prepare(
      `UPDATE tickets SET status = 'fechado', updated_at = datetime('now')
       WHERE status = 'resolvido'
         AND COALESCE(closed_at, updated_at) <= datetime('now', ?)`
    )
    .run(`-${AUTO_CLOSE_MIN} minutes`);
  if (info.changes > 0) {
    console.log(`[auto] ${info.changes} chamado(s) resolvido(s) há ${AUTO_CLOSE_MIN} min → "fechado".`);
  }
  return info.changes;
}
setInterval(fecharResolvidos, 15 * 1000).unref?.();

/* ------------------------------------------------------------------ */
/* Banco de dados                                                      */
/* ------------------------------------------------------------------ */
const db = new DatabaseSync(path.join(DATA_DIR, 'chamados.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'agent'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    priority    TEXT NOT NULL DEFAULT 'media',   -- baixa | media | alta | critica
    status      TEXT NOT NULL DEFAULT 'aberto',  -- aberto | em_andamento | resolvido | fechado
    created_by  INTEGER NOT NULL REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id),
    closed_by   INTEGER REFERENCES users(id),    -- conta que encerrou (histórico)
    closed_at   TEXT,                            -- quando encerrou
    reopened_by INTEGER REFERENCES users(id),    -- conta que reabriu (histórico)
    reopened_at TEXT,                            -- quando reabriu
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    internal   INTEGER NOT NULL DEFAULT 0,       -- 1 = nota interna (só equipe)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
  CREATE INDEX IF NOT EXISTS idx_comments_ticket     ON comments(ticket_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER,
    actor_email TEXT,
    acao        TEXT NOT NULL,
    alvo        TEXT,
    detalhe     TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,       -- SHA-256 do link enviado
    expires_at   TEXT NOT NULL,              -- UTC
    used         INTEGER NOT NULL DEFAULT 0, -- 1 = já usado
    requested_ip TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
`);

/* ------------------------------------------------------------------ */
/* Configurações (settings) e auditoria                                */
/* ------------------------------------------------------------------ */
function getSetting(chave, padrao = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(chave);
  return row ? row.value : padrao;
}

function setSetting(chave, valor) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(chave, String(valor));
}

/** Cadastro aberto por padrão; o Super Admin pode fechar em "Gerenciar usuários". */
function cadastroAberto() {
  return getSetting('open_registration', 'true') === 'true';
}

function registrarAuditoria({ req, ator = null, acao, alvo = null, detalhe = null }) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_id, actor_email, acao, alvo, detalhe, ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      req && req.user ? req.user.id : null,
      (req && req.user && req.user.email) || ator || (detalhe && detalhe.email) || null,
      acao,
      alvo === null ? null : String(alvo),
      detalhe === null ? null : JSON.stringify(detalhe),
      req ? (req.ip || (req.socket && req.socket.remoteAddress) || null) : null
    );
  } catch (err) {
    console.error('[auditoria] falha ao registrar:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Sessões: token guardado como SHA-256 (nunca em texto puro)          */
/* ------------------------------------------------------------------ */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Migração única dos tokens antigos (armazenados em texto puro)
if (getSetting('sessions_hashed') !== '1') {
  const linhas = db.prepare('SELECT token FROM sessions').all();
  const atualiza = db.prepare('UPDATE sessions SET token = ? WHERE token = ?');
  for (const linha of linhas) atualiza.run(hashToken(linha.token), linha.token);
  setSetting('sessions_hashed', '1');
  if (linhas.length) console.log(`[segurança] ${linhas.length} sessão(ões) migrada(s) para hash SHA-256`);
}

/* ------------------------------------------------------------------ */
/* Senhas                                                              */
/* ------------------------------------------------------------------ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------------ */
/* Nome normalizado: sem acentos, minúsculas, espaços colapsados       */
/* É o identificador de login (o e-mail não é usado para entrar) e     */
/* precisa ser único para que o login por nome seja inequívoco.        */
/* ------------------------------------------------------------------ */
function normalizarNome(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Coluna name_key (migração de bancos criados antes disto)
const colunasUsers = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!colunasUsers.includes('name_key')) {
  db.exec('ALTER TABLE users ADD COLUMN name_key TEXT');
}

// Preenche os registros já existentes
for (const u of db.prepare('SELECT id, name FROM users').all()) {
  db.prepare('UPDATE users SET name_key = ? WHERE id = ?').run(normalizarNome(u.name), u.id);
}

// Índice único: dois cadastros não podem ter o mesmo nome
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_name_key ON users(name_key)');
} catch {
  console.warn('[banco] Aviso: existem contas com o mesmo nome — renomeie uma delas para que o login por nome funcione.');
}

// Quem encerrou o chamado e quando (migração de bancos criados antes disto)
const colunasTickets = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!colunasTickets.includes('closed_by')) {
  db.exec('ALTER TABLE tickets ADD COLUMN closed_by INTEGER REFERENCES users(id)');
}
if (!colunasTickets.includes('closed_at')) {
  db.exec('ALTER TABLE tickets ADD COLUMN closed_at TEXT');
}
if (!colunasTickets.includes('reopened_by')) {
  db.exec('ALTER TABLE tickets ADD COLUMN reopened_by INTEGER REFERENCES users(id)');
}
if (!colunasTickets.includes('reopened_at')) {
  db.exec('ALTER TABLE tickets ADD COLUMN reopened_at TEXT');
}
// Chamados já encerrados antes da coluna existir: usa a última atualização
db.exec("UPDATE tickets SET closed_at = updated_at WHERE closed_at IS NULL AND status IN ('resolvido','fechado')");

/* ------------------------------------------------------------------ */
/* Seed de usuários iniciais                                           */
/* ------------------------------------------------------------------ */
function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

const insertUser = db.prepare(
  'INSERT INTO users (name, name_key, email, password, role) VALUES (?, ?, ?, ?, ?)'
);

function criarConta(name, email, senhaHash, role) {
  return insertUser.run(name, normalizarNome(name), email, senhaHash, role);
}

function hasAdmin() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n > 0;
}

/* Senha sorteada quando não é ambiente de demonstração:
   evita deixar usuário/senha padrão conhecidos (ex.: admin123). */
function senhaSorteada() {
  return crypto.randomBytes(9).toString('base64url'); // 12 caracteres URL-safe
}

function criarPrimeiroAdmin() {
  const senha = senhaSorteada();
  let email = 'admin@empresa.com';
  let n = 2;
  while (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    email = `admin${n++}@empresa.com`;
  }
  criarConta('Administração', email, hashPassword(senha), 'admin');
  console.log('[seed] Super Admin criado — troque a senha no primeiro acesso:');
  console.log(`       Nome: Administração | E-mail: ${email} | Senha: ${senha}`);
}

if (countUsers() === 0) {
  if (DEMO) {
    // Contas documentadas apenas com DEMO=true (uso local de demonstração)
    criarConta('Administração', 'admin@empresa.com', hashPassword('admin123'), 'admin');
    criarConta('Equipe de TI', 'ti@empresa.com', hashPassword('ti123456'), 'agent');
    criarConta('João da Silva', 'joao@empresa.com', hashPassword('123456'), 'user');
    console.log('[seed] Contas de demonstração criadas (DEMO=true):');
    console.log('       Super Admin          | Administração  | admin123');
    console.log('       Responsável Técnico  | Equipe de TI   | ti123456');
    console.log('       Usuário              | João da Silva  | 123456');
  } else {
    criarPrimeiroAdmin();
  }
} else if (!hasAdmin()) {
  criarPrimeiroAdmin();
}

/* ------------------------------------------------------------------ */
/* Backup do banco                                                     */
/* ------------------------------------------------------------------ */
/* VACUUM INTO gera uma cópia consistente mesmo com o servidor em uso
   (banco em WAL): o arquivo novo sai de um ponto de consistência e nada
   é travado. Só os arquivos com o nosso carimbo entram na rotação —
   backups antigos feitos à mão nunca são apagados. */
function fazerBackup(origem = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const agora = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const carimbo =
    `${agora.getFullYear()}-${p2(agora.getMonth() + 1)}-${p2(agora.getDate())}_` +
    `${p2(agora.getHours())}${p2(agora.getMinutes())}${p2(agora.getSeconds())}`;

  let destino = path.join(BACKUP_DIR, `chamados-${carimbo}.db`);
  let tentativa = 2;
  while (fs.existsSync(destino)) {
    destino = path.join(BACKUP_DIR, `chamados-${carimbo}-${tentativa++}.db`);
  }

  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);

  const st = fs.statSync(destino);

  // Rotação: guarda só as últimas BACKUP_QTD cópias geradas pelo sistema
  const padrao = /^chamados-\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?\.db$/;
  const copias = fs.readdirSync(BACKUP_DIR).filter((f) => padrao.test(f)).sort();
  while (copias.length > BACKUP_QTD) {
    const velho = copias.shift();
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, velho));
      console.log(`[backup] cópia antiga removida: ${velho}`);
    } catch { /* não crítico */ }
  }

  return {
    arquivo: path.basename(destino),
    pasta: BACKUP_DIR,
    tamanho: st.size,
    quando: st.mtime.toISOString().slice(0, 19).replace('T', ' '),
    origem,
    retidas: copias.length
  };
}

function listarBackups() {
  let itens = [];
  if (fs.existsSync(BACKUP_DIR)) {
    itens = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { arquivo: f, tamanho: st.size, quando: st.mtime.toISOString().slice(0, 19).replace('T', ' ') };
      })
      .sort((a, b) => (a.quando < b.quando ? 1 : -1));
  }
  return { pasta: BACKUP_DIR, retidas: itens.length, itens };
}

if (BACKUP_AUTO) {
  try {
    const b = fazerBackup('início');
    console.log(`[backup] cópia criada na subida: ${b.arquivo} (${b.tamanho} bytes)`);
  } catch (err) {
    console.error('[backup] falha na cópia de subida:', err.message);
  }
  setInterval(() => {
    try {
      const b = fazerBackup('agendado');
      console.log(`[backup] cópia agendada criada: ${b.arquivo}`);
    } catch (err) {
      console.error('[backup] falha na cópia agendada:', err.message);
    }
  }, BACKUP_HORAS * 60 * 60 * 1000).unref?.();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const STATUSES = ['aberto', 'em_andamento', 'resolvido', 'fechado'];
const PRIORITIES = ['baixa', 'media', 'alta', 'critica'];
const ROLES = ['admin', 'agent', 'user'];
const ROLE_LABEL = { admin: 'Super Admin', agent: 'Responsável Técnico', user: 'Usuário' };

/* ------------------------------------------------------------------ */
/* Hierarquia de visualização e acesso aos chamados                    */
/* ------------------------------------------------------------------ */
/* Nível 1 — Usuário:             somente os chamados que ele abriu.   */
/* Nível 2 — Responsável Técnico: os atribuídos a ele + a fila         */
/*                                (chamados ainda sem responsável).    */
/* Nível 3 — Super Admin:         todos os chamados.                   */
const HIERARQUIA = { user: 1, agent: 2, admin: 3 };
const HIERARQUIA_ESCOPO = {
  user: 'Somente os chamados que você abriu.',
  agent: 'Chamados atribuídos a você + a fila sem responsável.',
  admin: 'Todos os chamados da organização.'
};

/** Número do nível na hierarquia (1 = menor alcance, 3 = total). */
function nivelDe(role) {
  return HIERARQUIA[role] || 1;
}

function nivelLabel(role) {
  return `Nível ${nivelDe(role)} de 3`;
}

/** Condição SQL de visibilidade do nível de quem está consultando a lista. */
function escopoChamados(user) {
  if (user.role === 'admin') return { sql: '', params: [] };
  if (user.role === 'agent') {
    // fila (sem responsável) + o que já está com ele
    return { sql: '(t.assigned_to IS NULL OR t.assigned_to = ?)', params: [user.id] };
  }
  return { sql: 't.created_by = ?', params: [user.id] };
}

/** O nível de acesso de quem pede cobre este chamado? (detalhe, mensagens, edição) */
function podeVerChamado(user, ticket) {
  if (nivelDe(user.role) >= 3) return true;
  if (user.role === 'agent') return !ticket.assignee || ticket.assignee.id === user.id;
  return !!ticket.creator && ticket.creator.id === user.id;
}

/** Recusa alinhada ao nível que foi negado. */
function recusaDeAcesso(user) {
  return user.role === 'agent'
    ? 'Este chamado está sob responsabilidade de outro Responsável Técnico.'
    : 'Este chamado não é seu.';
}
const CATEGORIES = [
  // Ordem alfabética — OUTROS fica sempre por último
  'FALTA DE ENERGIA', 'HCP', 'INTERNET', 'RADIO', 'SAD', 'TATICO', 'TELEFONIA',
  'OUTROS'
];

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    level: nivelDe(u.role),
    levelLabel: nivelLabel(u.role),
    scope: HIERARQUIA_ESCOPO[u.role]
  };
}

/* Limites de tamanho dos campos (evita registros gigantes) */
const LIMITES = {
  nome: [2, 80],
  email: [5, 120],
  senha: [8, 128],
  titulo: [5, 120],
  descricao: [10, 3000]
};

function tamanhoInvalido(valor, chave) {
  const [min, max] = LIMITES[chave];
  return valor.length < min || valor.length > max;
}

/* Escapa texto para uso dentro de HTML (conteúdo dos e-mails) */
function escHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serializeTicket(row) {
  return {
    id: row.id,
    code: '#' + String(row.id).padStart(4, '0'),
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: { id: row.creator_id, name: row.creator_name, email: row.creator_email },
    assignee: row.assignee_id
      ? { id: row.assignee_id, name: row.assignee_name, email: row.assignee_email }
      : null,
    closedAt: row.closed_at || null,
    closedBy: row.closed_by_id
      ? { id: row.closed_by_id, name: row.closed_by_name, email: row.closed_by_email }
      : null,
    reopenedAt: row.reopened_at || null,
    reopenedBy: row.reopened_by_id
      ? { id: row.reopened_by_id, name: row.reopened_by_name, email: row.reopened_by_email }
      : null
  };
}

const TICKET_SELECT = `
  SELECT t.*, u.id AS creator_id, u.name AS creator_name, u.email AS creator_email,
         a.id AS assignee_id, a.name AS assignee_name, a.email AS assignee_email,
         f.id AS closed_by_id, f.name AS closed_by_name, f.email AS closed_by_email,
         r.id AS reopened_by_id, r.name AS reopened_by_name, r.email AS reopened_by_email
  FROM tickets t
  JOIN users u ON u.id = t.created_by
  LEFT JOIN users a ON a.id = t.assigned_to
  LEFT JOIN users f ON f.id = t.closed_by
  LEFT JOIN users r ON r.id = t.reopened_by
`;

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
const app = express();

/* Não divulgar que o servidor é Express (X-Powered-By) */
app.disable('x-powered-by');
/* Só confia no X-Forwarded-For quando há proxy reverso configurado */
if (TRUST_PROXY) app.set('trust proxy', 1);

/* ----------------------- Cabeçalhos de segurança ---------------------- */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-XSS-Protection', '0');
  // Nada de respostas da API no cache do navegador/proxy (dados de chamados e de contas)
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (req.secure || SECURE_COOKIE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* --------------------------- Anti-CSRF -------------------------------- */
/* Toda mutação (POST/PATCH/PUT/DELETE) precisa vir da própria origem.
   Navegadores enviam Origin/Sec-Fetch-Site; clientes locais (sem esses
   cabeçalhos) continuam funcionando. */
app.use('/api', (req, res, next) => {
  const metodo = String(req.method).toUpperCase();
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(metodo)) return next();

  const host = req.headers.host;
  const origem = req.headers.origin;
  const origensPermitidas = new Set([`http://${host}`, `https://${host}`]);

  const bloquear = (motivo) => {
    console.warn(`[segurança] CSRF bloqueado | ${motivo} | ${metodo} ${req.path}`);
    return res.status(403).json({ error: 'Requisição bloqueada: origem não permitida.' });
  };

  if (origem && !origensPermitidas.has(origem)) return bloquear(`origin=${origem}`);

  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return bloquear(`sec-fetch-site=${site}`);

  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getSession(req) {
  const header = req.headers.cookie || '';
  const match = header.match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  if (!match) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.user_id, s.created_at, u.id, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(hashToken(match[1]));
  if (!row) return null;

  // Sessão expirada: apaga e desloga
  const criadaEm = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(criadaEm) || Date.now() - criadaEm > SESSION_TTL_SECONDS * 1000) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(row.token);
    return null;
  }

  return {
    token: row.token,
    user: publicUser({ id: row.user_id, name: row.name, email: row.email, role: row.role })
  };
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Faça login para continuar.' });
  req.user = session.user;
  req.sessionToken = session.token;
  next();
}

/* Encerra todas as sessões de um usuário (usado ao trocar a senha).
   Mantém a sessão atual caso o próprio usuário esteja alterando a senha. */
function revogarSessoes(userId, manterToken) {
  if (manterToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, manterToken);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function requireTech(req, res, next) {
  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Acesso restrito aos perfis Responsável Técnico e Super Admin.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao Super Admin.' });
  }
  next();
}

/* Envolve rotas assíncronas: erro vira 500 tratado, e não derruba o processo */
const assincrono = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(hashToken(token), userId);
  res.setHeader(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; SameSite=Lax${SECURE_COOKIE ? '; Secure' : ''}; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

/* --------------------------- Autenticação -------------------------- */

app.post('/api/auth/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  // O perfil é definido exclusivamente pelo Super Admin: quem se cadastra vira Usuário.
  const role = 'user';

  if (!cadastroAberto()) {
    return res.status(403).json({ error: 'O cadastro está fechado. Procure o Super Admin para criar sua conta.' });
  }

  // Anti-spam: no máximo N contas novas por IP por hora
  const ipCadastro = req.ip || req.socket?.remoteAddress || 'desconhecido';
  const bloqueioCadastro = limitar(`cadastro|${ipCadastro}`, CADASTRO_MAX_POR_IP, 60 * 60 * 1000);
  if (bloqueioCadastro) {
    console.warn(`[segurança] auto-cadastro recusado por limite | ip=${ipCadastro}`);
    return recusar429(res, bloqueioCadastro, 'Muitas contas criadas deste endereço. Tente novamente mais tarde.');
  }
  if (tamanhoInvalido(name, 'nome')) return res.status(400).json({ error: 'O nome deve ter de2 a80 caracteres.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (tamanhoInvalido(email, 'email')) return res.status(400).json({ error: 'E-mail muito longo.' });
  if (tamanhoInvalido(password, 'senha')) return res.status(400).json({ error: 'A senha deve ter de 8 a 128 caracteres.' });

  try {
    const info = db
      .prepare('INSERT INTO users (name, name_key, email, password, role) VALUES (?, ?, ?, ?, ?)')
      .run(name, normalizarNome(name), email, hashPassword(password), role);
    registrarAuditoria({
      req, ator: email, acao: 'conta.criada', alvo: email,
      detalhe: { origem: 'auto-cadastro', perfil: ROLE_LABEL[role], nome: name }
    });
    createSession(res, Number(info.lastInsertRowid));
    res.status(201).json({ user: publicUser({ id: Number(info.lastInsertRowid), name, email, role }) });
  } catch (err) {
    const msg = String(err.message);
    if (msg.includes('name_key')) {
      return res.status(409).json({ error: 'Já existe uma conta com esse nome. Escolha outro.' });
    }
    if (msg.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    }
    throw err;
  }
});

/* Hash fantasma: mantém o custo do login igual existindo a conta ou não,
   para não descobrir nomes de usuário medindo o tempo de resposta. */
const HASH_FANTASMA = hashPassword(crypto.randomBytes(32).toString('hex'));

/* Login por NOME (o e-mail não é usado para entrar) */
app.post('/api/auth/login', (req, res) => {
  const nome = String(req.body.name ?? req.body.nome ?? '').trim();
  const chaveNome = normalizarNome(nome);
  const password = String(req.body.password || '');
  const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';

  if (chaveNome.length > LIMITES.nome[1] || password.length > LIMITES.senha[1]) {
    return res.status(400).json({ error: 'Nome ou senha fora do tamanho permitido.' });
  }

  // Proteção contra força bruta: só falhas contam (5 por IP+nome, 30 por IP)
  const chaveConta = `${ip}|${chaveNome}`;
  const bloqueio = checarBloqueio(chaveConta, LOGIN_MAX_POR_CONTA) || checarBloqueio(ip, LOGIN_MAX_POR_IP);

  if (bloqueio) {
    const minutos = Math.ceil(bloqueio.esperaSeg / 60);
    console.warn(`[segurança] login bloqueado por limite de tentativas | ip=${ip} nome=${chaveNome}`);
    res.setHeader('Retry-After', String(bloqueio.esperaSeg));
    return res.status(429).json({
      error: `Muitas tentativas de login. Tente novamente em ${minutos} minuto(s).`
    });
  }

  const candidatos = db.prepare('SELECT * FROM users WHERE name_key = ?').all(chaveNome);

  // Só pode haver uma conta com o nome informado
  if (candidatos.length > 1) {
    console.warn(`[segurança] login ambíguo | ip=${ip} nome=${chaveNome} (${candidatos.length} contas)`);
    return res.status(409).json({
      error: 'Mais de uma conta usa esse nome. Contate o Super Admin para renomear.'
    });
  }

  const user = candidatos[0];

  // Mesmo custo de scrypt existindo a conta ou não (anti-enumeração por tempo)
  const senhaOk = verifyPassword(password, user ? user.password : HASH_FANTASMA);

  if (!user || !senhaOk) {
    registrarFalha(chaveConta);
    registrarFalha(ip);
    console.warn(`[segurança] login falhou | ip=${ip} nome=${chaveNome}`);
    // Fica registrado na trilha de auditoria para o Super Admin monitorar
    registrarAuditoria({
      req, acao: 'login.negado',
      alvo: nome.trim() || chaveNome || '(vazio)',
      detalhe: { motivo: user ? 'senha incorreta' : 'conta inexistente', nomeNormalizado: chaveNome }
    });
    return res.status(401).json({ error: 'Nome ou senha incorretos.' });
  }

  tentativasLogin.delete(chaveConta);
  console.log(`[segurança] login ok | ip=${ip} nome=${user.name} email=${user.email} perfil=${user.role}`);
  registrarAuditoria({
    req, ator: user.email, acao: 'login', alvo: user.email,
    detalhe: { perfil: user.role, nome: user.name }
  });
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.cookie || '';
  const match = header.match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  if (match) db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(match[1]));
  res.setHeader('Set-Cookie', `session=; Path=/; HttpOnly; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  res.json({ user: session ? session.user : null });
});

/* ------------------------------------------------------------------ */
/* Recuperação de senha por e-mail                                     */
/* ------------------------------------------------------------------ */

/** A conta é localizada pelo e-mail OU pelo nome (mesmo critério do login). */
function localizarContaRecuperacao(valor) {
  const ident = String(valor || '').trim();
  if (!ident) return null;
  return (
    db.prepare('SELECT * FROM users WHERE email = ?').get(ident.toLowerCase()) ||
    db.prepare('SELECT * FROM users WHERE name_key = ?').get(normalizarNome(ident))
  );
}

function mascararEmail(email) {
  const [local, dominio] = String(email).split('@');
  const inicio = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${inicio}***@${dominio || ''}`;
}

function lerTokenReset(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  return db
    .prepare(
      `SELECT r.*, u.name, u.email, u.role
       FROM password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = ?`
    )
    .get(hashToken(token));
}

function tokenResetValido(row) {
  if (!row || row.used) {
    return { ok: false, erro: 'Link inválido ou já utilizado. Solicite um novo.' };
  }
  const expiraEm = Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(expiraEm) || Date.now() > expiraEm) {
    return { ok: false, erro: 'Este link expirou. Solicite um novo.' };
  }
  return { ok: true };
}

/* 1) Pedido de recuperação — a resposta é a mesma existindo a conta ou não
      (não revela quem tem cadastro) e o e-mail sai em segundo plano. */
app.post('/api/auth/forgot', assincrono(async (req, res) => {
  const ident = String(req.body.identifier ?? req.body.email ?? req.body.name ?? '').trim();
  const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';

  if (ident.length > 120) {
    return res.status(400).json({ error: 'Informe seu e-mail ou nome (até 120 caracteres).' });
  }

  // Limite de pedidos por IP e por conta — evita bombardeio de e-mails
  const chaveIp = `forgot|${ip}`;
  const chaveConta = `forgot|${ip}|${normalizarNome(ident)}`;
  const bloqueio =
    checarBloqueio(chaveIp, FORGOT_MAX_POR_IP) || checarBloqueio(chaveConta, FORGOT_MAX_POR_CONTA);
  if (bloqueio) {
    res.setHeader('Retry-After', String(bloqueio.esperaSeg));
    return res.status(429).json({
      error: 'Muitos pedidos de recuperação. Tente novamente em alguns minutos.'
    });
  }
  registrarFalha(chaveIp);
  registrarFalha(chaveConta);

  const resposta = {
    ok: true,
    message: 'Se existir uma conta com esse dado, enviaremos um e-mail com o link para redefinir a senha.'
  };

  const user = localizarContaRecuperacao(ident);
  if (!user) {
    console.warn(`[segurança] recuperação pedida para conta inexistente | ip=${ip}`);
    return res.json(resposta);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiraEm = new Date(Date.now() + RESET_TTL_MIN * 60000).toISOString().replace('T', ' ').slice(0, 19);

  // Um link válido por vez: os anteriores deixam de valer
  db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
  db.prepare(
    'INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)'
  ).run(user.id, hashToken(token), expiraEm, ip);

  const base =
    process.env.PUBLIC_URL || `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
  const link = `${base}/#/reset?token=${token}`;
  const primeiro = user.name.split(' ')[0];

  const texto = [
    `Olá, ${primeiro}!`,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta na Central de Chamados GTI-CG.',
    '',
    'Abra o link abaixo para criar uma nova senha:',
    link,
    '',
    `O link é válido por ${RESET_TTL_MIN} minutos e pode ser usado uma única vez.`,
    'Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.',
    '',
    '— Central de Chamados GTI-CG'
  ].join('\n');

  const html = [
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#16203a;line-height:1.6">',
    `<p>Olá, <strong>${escHtml(primeiro)}</strong>!</p>`,
    '<p>Recebemos um pedido para redefinir a senha da sua conta na ' +
      '<strong>Central de Chamados GTI-CG</strong>.</p>',
    '<p style="text-align:center;margin:26px 0">',
    `<a href="${escHtml(link)}" style="background:#2f5cff;color:#fff;padding:12px 22px;` +
      'border-radius:8px;text-decoration:none;font-weight:600">Redefinir minha senha</a>',
    '</p>',
    `<p style="color:#67718b;font-size:13px">O link é válido por ${RESET_TTL_MIN} minutos e pode ` +
      'ser usado uma única vez. Se o botão não funcionar, copie e cole no navegador:<br>' +
      `<span style="word-break:break-all;color:#2f5cff">${escHtml(link)}</span></p>`,
    '<p style="color:#67718b;font-size:13px">Se você não pediu isso, ignore este e-mail — ' +
      'sua senha continua a mesma.</p>',
    '</div>'
  ].join('');

  // Responde na hora e envia em segundo plano (mesmo tempo de resposta
  // existindo a conta ou não)
  res.json(resposta);

  setImmediate(async () => {
    try {
      const entrega = await mailer.enviarEmail({
        para: user.email,
        assunto: 'Redefinição de senha — Central de Chamados GTI-CG',
        texto,
        html
      });
      if (entrega.modo === 'outbox') {
        console.log(`[mail] e-mail gravado em ${entrega.arquivo}`);
        console.log(`[mail] link de redefinição (${RESET_TTL_MIN} min): ${link}`);
      }
      registrarAuditoria({
        req, ator: user.email, acao: 'senha.solicitada', alvo: user.email,
        detalhe: { nome: user.name, entrega: entrega.modo, minutos: RESET_TTL_MIN }
      });
      console.log(
        `[segurança] recuperação de senha solicitada | ip=${ip} alvo=${user.email} entrega=${entrega.modo}`
      );
    } catch (err) {
      console.error('[mail] falha ao enviar link de recuperação:', err.message);
    }
  });
}));

/* 2) Confere o token do link e devolve a conta (com e-mail mascarado) */
app.get('/api/auth/reset/:token', (req, res) => {
  const row = lerTokenReset(req.params.token);
  const valido = tokenResetValido(row);
  if (!valido.ok) return res.status(400).json({ error: valido.erro });

  res.json({
    name: row.name,
    email: mascararEmail(row.email),
    expiresAt: row.expires_at
  });
});

/* 3) Grava a nova senha, usa o token (uma vez só) e encerra as sessões */
app.post('/api/auth/reset', (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm ?? '');

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Link inválido.' });
  }
  if (tamanhoInvalido(password, 'senha')) {
    return res.status(400).json({ error: 'A senha deve ter de 8 a 128 caracteres.' });
  }
  if (confirm !== password) {
    return res.status(400).json({ error: 'As senhas não conferem.' });
  }

  const row = lerTokenReset(token);
  const valido = tokenResetValido(row);
  if (!valido.ok) return res.status(400).json({ error: valido.erro });

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(row.user_id);
  revogarSessoes(row.user_id, null);

  registrarAuditoria({
    req, ator: row.email, acao: 'senha.redefinida', alvo: row.email,
    detalhe: { nome: row.name, perfil: ROLE_LABEL[row.role], via: 'link de recuperação' }
  });
  console.log(`[segurança] senha redefinida por link de recuperação | alvo=${row.email}`);

  res.json({ ok: true });
});

/* Configuração pública da interface */
app.get('/api/config', (req, res) => {
  res.json({
    demo: DEMO,
    openRegistration: cadastroAberto(),
    resetMinutes: RESET_TTL_MIN,
    autoCloseMinutes: AUTO_CLOSE_MIN
  });
});

/* Configurações do sistema (Super Admin) */
app.get('/api/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({ openRegistration: cadastroAberto() });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  if (typeof req.body.openRegistration !== 'boolean') {
    return res.status(400).json({ error: 'Valor inválido para openRegistration.' });
  }
  setSetting('open_registration', req.body.openRegistration ? 'true' : 'false');
  registrarAuditoria({
    req, acao: 'config.alterada', alvo: 'auto-cadastro',
    detalhe: { aberto: req.body.openRegistration }
  });
  console.log(`[segurança] auto-cadastro ${req.body.openRegistration ? 'ABERTO' : 'FECHADO'} por ${req.user.email}`);
  res.json({ openRegistration: cadastroAberto() });
});

/* Backup do banco (Super Admin): lista as cópias e permite criar uma agora */
app.get('/api/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(Object.assign(
      { automatico: BACKUP_AUTO, horas: BACKUP_HORAS, maximo: BACKUP_QTD },
      listarBackups()
    ));
  } catch (err) {
    console.error('[backup] falha ao listar as cópias:', err.message);
    res.status(500).json({ error: 'Não foi possível listar os backups.' });
  }
});

app.post('/api/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    const backup = fazerBackup('manual');
    registrarAuditoria({
      req, acao: 'backup.criado', alvo: backup.arquivo,
      detalhe: { origem: 'manual', tamanho: backup.tamanho, pasta: backup.pasta }
    });
    console.log(`[backup] cópia manual criada por ${req.user.email}: ${backup.arquivo} (${backup.tamanho} bytes)`);
    res.status(201).json(Object.assign({ backup }, listarBackups()));
  } catch (err) {
    console.error('[backup] falha ao criar a cópia:', err.message);
    res.status(500).json({ error: 'Não foi possível criar o backup.' });
  }
});

/* Trilha de auditoria (Super Admin) */
app.get('/api/audit', requireAuth, requireAdmin, (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const eventos = db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limite)
    .map((e) => ({
      id: e.id,
      ator: e.actor_email || '—',
      acao: e.acao,
      alvo: e.alvo,
      detalhe: e.detalhe ? safeParse(e.detalhe) : null,
      ip: e.ip,
      quando: e.created_at
    }));
  res.json({ eventos });
});

function safeParse(json) {
  try { return JSON.parse(json); } catch { return json; }
}

/* ------------------------------ Chamados --------------------------- */

app.get('/api/meta', (req, res) => {
  res.json({ statuses: STATUSES, priorities: PRIORITIES, categories: CATEGORIES });
});

app.get('/api/tickets', requireAuth, (req, res) => {
  const escopo = escopoChamados(req.user);
  const condicoes = [];
  const params = [];

  // Hierarquia: o WHERE do nível de acesso vem primeiro e sempre com AND
  if (escopo.sql) {
    condicoes.push(escopo.sql);
    params.push(...escopo.params);
  }
  if (req.query.status && STATUSES.includes(req.query.status)) {
    condicoes.push('t.status = ?');
    params.push(req.query.status);
  }
  if (req.query.q) {
    const like = `%${String(req.query.q).slice(0, 80)}%`;
    condicoes.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(like, like);
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const rows = db
    .prepare(`${TICKET_SELECT} ${where} ORDER BY t.updated_at DESC LIMIT 300`)
    .all(...params);
  res.json({
    tickets: rows.map(serializeTicket),
    scope: { level: nivelDe(req.user.role), label: nivelLabel(req.user.role), description: HIERARQUIA_ESCOPO[req.user.role] }
  });
});

/* Histórico — chamados encerrados (resolvido/fechado), na régua do nível de
   acesso: nível 2 vê os do alcance dele, nível 3 todos (o perfil Usuário não
   tem esta aba). Devolve a conta que encerrou cada chamado. */
app.get('/api/tickets/history', requireAuth, requireTech, (req, res) => {
  const escopo = escopoChamados(req.user);
  const condicoes = [];
  const params = [];

  if (escopo.sql) {
    condicoes.push(escopo.sql);
    params.push(...escopo.params);
  }
  condicoes.push("t.status IN ('resolvido','fechado')");

  const filtroStatus = String(req.query.status || '');
  if (filtroStatus === 'resolvido' || filtroStatus === 'fechado') {
    condicoes.push('t.status = ?');
    params.push(filtroStatus);
  }
  if (req.query.q) {
    const like = `%${String(req.query.q).slice(0, 80)}%`;
    condicoes.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(like, like);
  }

  const rows = db
    .prepare(
      `${TICKET_SELECT} WHERE ${condicoes.join(' AND ')}
       ORDER BY COALESCE(t.closed_at, t.updated_at) DESC, t.id DESC LIMIT 500`
    )
    .all(...params);

  res.json({
    tickets: rows.map(serializeTicket),
    scope: { level: nivelDe(req.user.role), label: nivelLabel(req.user.role), description: HIERARQUIA_ESCOPO[req.user.role] }
  });
});

app.post('/api/tickets', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const category = String(req.body.category || '').trim();
  const priority = String(req.body.priority || 'media');

  if (tamanhoInvalido(title, 'titulo')) return res.status(400).json({ error: 'O título deve ter de5 a120 caracteres.' });
  if (tamanhoInvalido(description, 'descricao')) return res.status(400).json({ error: 'A descrição deve ter de10 a3000 caracteres.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Escolha uma categoria.' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Prioridade inválida.' });

  // Anti-spam: evita inundar a fila com chamados automáticos
  const bloqueioChamado = limitar(`chamado|${req.user.id}`, CHAMADO_MAX_POR_USUARIO, 60 * 60 * 1000);
  if (bloqueioChamado) {
    console.warn(`[segurança] abertura de chamado recusada por limite | conta=${req.user.email}`);
    return recusar429(res, bloqueioChamado, 'Você abriu muitos chamados neste período. Tente novamente em alguns minutos.');
  }

  const info = db
    .prepare(
      `INSERT INTO tickets (title, description, category, priority, created_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(title, description, category, priority, req.user.id);

  const row = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(Number(info.lastInsertRowid));
  res.status(201).json({ ticket: serializeTicket(row) });
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
  const row = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chamado não encontrado.' });

  const ticket = serializeTicket(row);
  if (!podeVerChamado(req.user, ticket)) {
    return res.status(403).json({ error: recusaDeAcesso(req.user) });
  }

  const comments = db
    .prepare(
      `SELECT c.*, u.name, u.email, u.role
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.ticket_id = ? ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(row.id)
    .filter((c) => req.user.role !== 'user' || !c.internal)
    .map((c) => ({
      id: c.id,
      body: c.body,
      internal: !!c.internal,
      createdAt: c.created_at,
      author: { id: c.user_id, name: c.name, email: c.email, role: c.role }
    }));

  res.json({ ticket, comments, canManage: req.user.role !== 'user' });
});

app.post('/api/tickets/:id/comments', requireAuth, (req, res) => {
  const row = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chamado não encontrado.' });

  const ticket = serializeTicket(row);
  const canInternal = req.user.role !== 'user';
  if (!podeVerChamado(req.user, ticket)) {
    return res.status(403).json({ error: recusaDeAcesso(req.user) });
  }

  const body = String(req.body.body || '').trim();
  const internal = canInternal && !!req.body.internal;
  if (body.length < 1) return res.status(400).json({ error: 'Escreva uma mensagem.' });
  if (body.length > 4000) return res.status(400).json({ error: 'Mensagem muito longa.' });

  // Anti-spam: evita inundar a conversa com mensagens automáticas
  const bloqueioMsg = limitar(`comentario|${req.user.id}`, COMENTARIO_MAX_POR_USUARIO, 10 * 60 * 1000);
  if (bloqueioMsg) {
    console.warn(`[segurança] comentário recusado por limite | conta=${req.user.email}`);
    return recusar429(res, bloqueioMsg, 'Muitas mensagens em pouco tempo. Aguarde alguns minutos.');
  }

  db.prepare('INSERT INTO comments (ticket_id, user_id, body, internal) VALUES (?, ?, ?, ?)')
    .run(row.id, req.user.id, body, internal ? 1 : 0);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(row.id);

  res.status(201).json({ ok: true });
});

app.patch('/api/tickets/:id', requireAuth, requireTech, (req, res) => {
  const row = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Chamado não encontrado.' });

  // Hierarquia: o Responsável Técnico só mexe no que está no alcance dele
  if (!podeVerChamado(req.user, serializeTicket(row))) {
    return res.status(403).json({ error: recusaDeAcesso(req.user) });
  }

  const updates = [];
  const params = [];

  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Status inválido.' });

    const eraEncerrado = ['resolvido', 'fechado'].includes(row.status);
    const novoEncerrado = ['resolvido', 'fechado'].includes(req.body.status);
    const mudou = req.body.status !== row.status;

    // Reabertura de chamado encerrado: opção exclusiva do Super Admin
    if (mudou && eraEncerrado && !novoEncerrado && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Somente o Super Admin pode reabrir chamados encerrados.' });
    }

    updates.push('status = ?');
    params.push(req.body.status);

    // Histórico: quem encerrou/quando (e, na reabertura, quem reabriu/quando)
    if (mudou) {
      if (novoEncerrado) {
        updates.push('closed_by = ?', "closed_at = datetime('now')");
        params.push(req.user.id);
      } else {
        updates.push('closed_by = NULL', 'closed_at = NULL');
        if (eraEncerrado) {
          updates.push("reopened_at = datetime('now')", 'reopened_by = ?');
          params.push(req.user.id);
        }
      }
    }
  }
  if (req.body.priority !== undefined) {
    if (!PRIORITIES.includes(req.body.priority)) return res.status(400).json({ error: 'Prioridade inválida.' });
    updates.push('priority = ?');
    params.push(req.body.priority);
  }
  if (req.body.assigned_to !== undefined) {
    if (req.body.assigned_to === null) {
      updates.push('assigned_to = NULL');
    } else {
      const agent = db
        .prepare("SELECT id FROM users WHERE id = ? AND role IN ('agent', 'admin')")
        .get(req.body.assigned_to);
      if (!agent) return res.status(400).json({ error: 'Responsável inválido.' });
      updates.push('assigned_to = ?');
      params.push(req.body.assigned_to);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });

  updates.push("updated_at = datetime('now')");
  db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).run(...params, row.id);

  const updated = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(row.id);
  res.json({ ticket: serializeTicket(updated) });
});

/* ------------------------- Painel da equipe ------------------------ */

app.get('/api/agents', requireAuth, requireTech, (req, res) => {
  const rows = db
    .prepare("SELECT id, name, email FROM users WHERE role IN ('agent', 'admin') ORDER BY name")
    .all();
  res.json({ agents: rows });
});

app.get('/api/stats', requireAuth, requireTech, (req, res) => {
  const escopo = escopoChamados(req.user);
  // Todos os números do painel seguem a hierarquia: mesma régua da lista
  const onde = (extras = []) => {
    const partes = [];
    if (escopo.sql) partes.push(escopo.sql);
    partes.push(...extras);
    return partes.length ? { sql: `WHERE ${partes.join(' AND ')}`, params: escopo.params } : { sql: '', params: [] };
  };

  const abertos = onde(["t.status IN ('aberto','em_andamento')"]);
  const fila = onde(["t.status IN ('aberto','em_andamento')", 't.assigned_to IS NULL']);

  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS total FROM tickets t ${onde().sql} GROUP BY status`)
    .all(...onde().params);
  const byPriority = db
    .prepare(`SELECT priority, COUNT(*) AS total FROM tickets t ${abertos.sql} GROUP BY priority`)
    .all(...abertos.params);
  const unassigned = db
    .prepare(`SELECT COUNT(*) AS total FROM tickets t ${fila.sql}`)
    .get(...fila.params).total;
  const assignedToMe = db
    .prepare('SELECT COUNT(*) AS total FROM tickets WHERE assigned_to = ?')
    .get(req.user.id).total;

  res.json({
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.total])),
    byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.total])),
    unassigned,
    assignedToMe,
    scope: { level: nivelDe(req.user.role), label: nivelLabel(req.user.role), description: HIERARQUIA_ESCOPO[req.user.role] }
  });
});

/* ------------------- Gestão de contas ---------------------------------
   Super Admin: tudo (criar, perfil, e-mail, excluir, qualquer senha).
   Responsável Técnico: lista apenas perfis Usuário e redefine senhas. */

const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.created_at,
         (SELECT COUNT(*) FROM tickets t WHERE t.created_by = u.id) AS tickets,
         (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS messages
  FROM users u
`;

const USER_ORDER = `
  ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, u.name
`;

function serializeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABEL[u.role],
    createdAt: u.created_at,
    tickets: u.tickets ?? 0,
    messages: u.messages ?? 0,
    canDelete: u.id !== undefined
  };
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

/* Lista de contas: Super Admin vê todas; Responsável Técnico vê apenas
   as contas de Usuário (o recorte que ele pode redefinir a senha). */
app.get('/api/users', requireAuth, (req, res) => {
  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Acesso restrito aos perfis Responsável Técnico e Super Admin.' });
  }
  const soPerfisUsuario = req.user.role !== 'admin';
  const users = db
    .prepare(`${USER_SELECT} ${soPerfisUsuario ? "WHERE u.role = 'user'" : ''} ${USER_ORDER}`)
    .all();
  res.json({ users: users.map(serializeUser) });
});

/* Redefinir senha — única via para trocar senhas de contas existentes.
   Super Admin: qualquer conta. Responsável Técnico: só perfis Usuário. */
app.post('/api/users/:id/password', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Somente Super Admin e Responsável Técnico podem redefinir senhas.' });
  }
  if (req.user.role === 'agent' && target.role !== 'user') {
    return res.status(403).json({
      error: 'Responsável Técnico só redefinir senhas de contas de perfil Usuário.'
    });
  }

  const password = String(req.body.password || '');
  if (tamanhoInvalido(password, 'senha')) {
    return res.status(400).json({ error: 'A senha deve ter de 8 a 128 caracteres.' });
  }

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), target.id);

  // Encerra as sessões ativas do usuário (mantém a atual se for ele mesmo)
  revogarSessoes(target.id, target.id === req.user.id ? req.sessionToken : null);

  registrarAuditoria({
    req, acao: 'senha.redefinida', alvo: target.email,
    detalhe: { nome: target.name, perfil: ROLE_LABEL[target.role], por: req.user.email }
  });
  console.log(`[segurança] senha redefinida | alvo=${target.email} por=${req.user.email} (${req.user.role})`);
  res.json({ ok: true });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || 'user');

  if (tamanhoInvalido(name, 'nome')) return res.status(400).json({ error: 'O nome deve ter de2 a80 caracteres.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (tamanhoInvalido(email, 'email')) return res.status(400).json({ error: 'E-mail muito longo.' });
  if (tamanhoInvalido(password, 'senha')) return res.status(400).json({ error: 'A senha deve ter de 8 a 128 caracteres.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Perfil inválido.' });

  try {
    const info = insertUser.run(name, normalizarNome(name), email, hashPassword(password), role);
    const created = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(Number(info.lastInsertRowid));
    registrarAuditoria({
      req, ator: req.user.email, acao: 'conta.criada', alvo: email,
      detalhe: { origem: 'painel-admin', perfil: ROLE_LABEL[role], nome: name }
    });
    res.status(201).json({ user: serializeUser(created) });
  } catch (err) {
    const msg = String(err.message);
    if (msg.includes('name_key')) {
      return res.status(409).json({ error: 'Já existe uma conta com esse nome.' });
    }
    if (msg.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    }
    throw err;
  }
});

/* Editar cadastro (nome e e-mail) de uma conta.
   Super Admin: qualquer conta + pode trocar o perfil.
   Responsável Técnico: só contas de perfil Usuário (perfil continua proibido).
   Usuário: não edita nada. */
app.patch('/api/users/:id', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Somente Super Admin e Responsável Técnico podem editar cadastros.' });
  }
  if (req.user.role === 'agent' && target.role !== 'user') {
    return res.status(403).json({
      error: 'Responsável Técnico só edita cadastros de perfil Usuário.'
    });
  }
  if (req.body.role !== undefined && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Só o Super Admin altera o perfil da conta.' });
  }

  const updates = [];
  const params = [];
  const alteracoes = {};

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (tamanhoInvalido(name, 'nome')) return res.status(400).json({ error: 'O nome deve ter de2 a80 caracteres.' });
    updates.push('name = ?', 'name_key = ?');
    params.push(name, normalizarNome(name));
    alteracoes.nome = { de: target.name, para: name };
  }

  if (req.body.email !== undefined) {
    const email = String(req.body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
    if (tamanhoInvalido(email, 'email')) return res.status(400).json({ error: 'E-mail muito longo.' });
    updates.push('email = ?');
    params.push(email);
    alteracoes.email = { de: target.email, para: email };
  }

  if (req.body.role !== undefined) {
    const role = String(req.body.role);
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Perfil inválido.' });
    if (target.role === 'admin' && role !== 'admin') {
      if (target.id === req.user.id) {
        return res.status(400).json({ error: 'Você não pode remover o próprio perfil de Super Admin.' });
      }
      if (countAdmins() <= 1) {
        return res.status(400).json({ error: 'Deve existir ao menos um Super Admin.' });
      }
    }
    updates.push('role = ?');
    params.push(role);
    alteracoes.perfil = { de: ROLE_LABEL[target.role], para: ROLE_LABEL[role] };
  }

  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });

  try {
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params, target.id);
  } catch (err) {
    const msg = String(err.message);
    if (msg.includes('name_key')) {
      return res.status(409).json({ error: 'Já existe uma conta com esse nome.' });
    }
    if (msg.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    }
    throw err;
  }

  registrarAuditoria({ req, acao: 'conta.alterada', alvo: target.email, detalhe: alteracoes });

  const updated = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(target.id);
  res.json({ user: serializeUser(updated) });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'Você não pode excluir a própria conta.' });
  }
  if (target.role === 'admin' && countAdmins() <= 1) {
    return res.status(400).json({ error: 'Deve existir ao menos um Super Admin.' });
  }

  const atividade = db.prepare(
    `SELECT (SELECT COUNT(*) FROM tickets WHERE created_by = ?) AS tickets,
            (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS messages`
  ).get(target.id, target.id);

  if (atividade.tickets > 0 || atividade.messages > 0) {
    return res.status(409).json({
      error: 'Esta conta já tem chamados ou mensagens e não pode ser excluída. Altere o perfil dela para "Usuário".'
    });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  registrarAuditoria({
    req, acao: 'conta.excluida', alvo: target.email,
    detalhe: { nome: target.name, perfil: ROLE_LABEL[target.role] }
  });
  res.json({ ok: true });
});

/* --------------------------- SPA fallback -------------------------- */

/* Rota de API inexistente devolve JSON 404 (e não o HTML do SPA) */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Rota da API não encontrada.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* Erros: corpo malformado vira 400/413 e o resto vira 500 genérico
   (sem vazar stack trace para o cliente). */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Corpo da requisição muito grande.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

/* Um erro dentro de uma rota assíncrona derrubaria o processo sem resposta */
process.on('unhandledRejection', (motivo) => {
  console.error('[erro] promessa rejeitada (servidor segue no ar):', motivo);
});

app.listen(PORT, () => {
  console.log(`\nCentral de Chamados rodando em http://localhost:${PORT}\n`);
});
