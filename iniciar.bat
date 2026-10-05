@echo off
title Central de Chamados
cd /d "%~dp0"

set "PATH=%ProgramFiles%\nodejs;%PATH%"
REM Sem variavel DEMO: a tela de login nao mostra credenciais de demonstracao

REM =========================================================================
REM  E-mail de recuperacao de senha (SMTP real) -----------------------------
REM  SEM essa configuracao o sistema funciona normalmente: o link do e-mail e
REM  gravado em data\outbox e impresso no console (o fluxo nunca trava).
REM
REM  Gmail:      SMTP_HOST=smtp.gmail.com   porta 587
REM              SMTP_USER=seu@gmail.com    SMTP_PASS=SENHA DE APP (16 letras)
REM              A senha comum da conta nao serve; gere em:
REM              myaccount.google.com -> Seguranca -> Verificacao em duas
REM              etapas -> Senhas de app
REM  Outlook:    SMTP_HOST=smtp.office365.com  porta 587
REM  Porta 465:  defina tambem  SMTP_SECURE=true
REM
REM  set "SMTP_HOST=smtp.gmail.com"
REM  set "SMTP_PORT=587"
REM  set "SMTP_USER=seu@gmail.com"
REM  set "SMTP_PASS=senha-de-app"
REM  set "SMTP_FROM=Central de Chamados"
REM
REM  Neste computador o Avast Web/Mail Shield intercepta o SMTP; a raiz abaixo
REM  (certs\avast-root.pem) faz o Node confiar nesse certificado.
REM  if exist "%~dp0certs\avast-root.pem" set "NODE_EXTRA_CA_CERTS=%~dp0certs\avast-root.pem"
REM
REM  Link do e-mail (opcional, se o endereco do servidor mudar):
REM  set "PUBLIC_URL=http://localhost:3000"
REM  Validade do link em minutos (padrao 30):
REM  set "RESET_TTL_MIN=30"
REM =========================================================================

if not exist "node_modules" (
  echo Instalando dependencias pela primeira vez...
  call "%ProgramFiles%\nodejs\npm.cmd" install --no-audit --no-fund
)

start "" http://localhost:3000
node server.js
pause
