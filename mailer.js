/**
 * Envio de e-mails da Central de Chamados.
 *
 * SMTP real quando configurado pelas variáveis de ambiente:
 *   SMTP_HOST  ex.: smtp.gmail.com
 *   SMTP_PORT  ex.: 587 (STARTTLS) ou 465 (TLS explícito)   — padrão 587
 *   SMTP_USER  e-mail da caixa que envia
 *   SMTP_PASS  senha de aplicativo (no Gmail: Senhas de app)
 *   SMTP_FROM  remetente exibido            — padrão: SMTP_USER
 *   SMTP_SECURE  true|false                 — padrão: true na porta 465
 *
 * Sem configuração (ou se o envio falhar), o e-mail é gravado em
 * data/outbox/*.eml e o link é impresso no console — assim o fluxo de
 * recuperação nunca fica travado.
 */
const fs = require('fs');
const path = require('path');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'Central de Chamados <nao-responda@empresa.com>';
const OUTBOX_DIR = path.join(__dirname, 'data', 'outbox');

function smtpConfigurado() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function gravarOutbox({ para, assunto, texto }) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const arquivo = path.join(OUTBOX_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`);
  const mensagem = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${SMTP_FROM}`,
    `To: ${para}`,
    `Subject: ${assunto}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    texto
  ].join('\r\n');
  fs.writeFileSync(arquivo, mensagem, 'utf8');
  return arquivo;
}

/**
 * Envia um e-mail. Nunca lança: em caso de falha grava em outbox e devolve
 * o modo usado, para a aplicação registrar na auditoria.
 * @returns {Promise<{ modo: 'smtp' | 'outbox', arquivo?: string, erro?: string }>}
 */
async function enviarEmail({ para, assunto, texto, html }) {
  if (smtpConfigurado()) {
    try {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
      });
      await transport.sendMail({
        from: SMTP_FROM,
        to: para,
        subject: assunto,
        text: texto,
        ...(html ? { html } : {})
      });
      return { modo: 'smtp' };
    } catch (err) {
      console.error(`[mail] falha no envio SMTP: ${err.message}`);
      const arquivo = gravarOutbox({ para, assunto, texto });
      return { modo: 'outbox', arquivo, erro: err.message };
    }
  }

  const arquivo = gravarOutbox({ para, assunto, texto });
  return { modo: 'outbox', arquivo };
}

module.exports = { enviarEmail, smtpConfigurado };
