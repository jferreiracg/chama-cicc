# 🎫 Central de Chamados

App web para **abertura e acompanhamento de chamados** de suporte/TI.

Funcionalidades da primeira versão:

- **Abrir chamado** — título, descrição, categoria e prioridade. Categorias (ordem alfabética,
  com **OUTROS** por último): `FALTA DE ENERGIA`, `HCP`, `INTERNET`, `RADIO`, `SAD`, `TATICO`,
  `TELEFONIA`, `OUTROS`
- **Listar e acompanhar** — filtros por status e busca, histórico de conversa
- **Hierarquia de acesso** — três níveis de visualização: **Usuário** (só os que ele abriu) →
  **Responsável Técnico** (atribuídos a ele + fila sem responsável) → **Super Admin** (todos)
- **Histórico de chamados** — aba *Histórico* (ao lado de *Gerenciar usuários*, **só para
  Responsável Técnico e Super Admin**) listando todos os chamados **encerrados** (resolvidos e
  fechados) com a data e **a conta que encerrou**, na régua do nível de acesso, com busca e filtro
  por status
- **Encerramento automático** — um chamado **`resolvido` vira `fechado` sozinho depois de 1
  minuto** (a rotina varre a cada 15 s; o prazo é configurável e o aviso aparece no detalhe)
- **Reabertura pelo Super Admin** — botão **↺ Reabrir** no detalhe do chamado e em cada linha do
  *Histórico*: volta o status para `Aberto` e **grava data, hora e a conta que reabriu**
  (`reopened_at`/`reopened_by`); para os demais perfis a reabertura devolve `403`
- **Backup do banco** — cópia automática em `backup/` **na subida** e **a cada 24 h** (as últimas
  10), feita com `VACUUM INTO` sem travar o servidor, botão **Fazer backup agora** em *Gerenciar
  usuários* e restauração descrita no fim deste README
- **Login de usuários** — cadastro (sempre como Usuário), entrada pelo **nome** (sem e-mail) e sessão por cookie (senha com hash scrypt)
- **Recuperar senha** — link *Esqueceu a senha?* na tela de login: envia por **e-mail** um link de uso único (30 min) para criar uma nova senha **com confirmação**
- **Gestão de contas** — o Super Admin cria contas, troca perfis, redefine senhas (diálogo com **nova senha + confirmação**), exclui contas, abre/fecha o auto-cadastro e acompanha a **trilha de auditoria**
- **Painel do Responsável Técnico** — estatísticas, fila sem responsável, atribuição e mudança de status
- **Notas internas** — mensagens visíveis apenas para o Responsável Técnico

## Perfis

| Perfil | O que pode fazer |
|--------|------------------|
| **Super Admin** | **Nível 3** — vê **todos** os chamados. Cria contas, **edita o cadastro (nome e e-mail) de qualquer conta**, define e altera o perfil, **redefine a senha de qualquer conta**, exclui contas sem atividade — e tem todos os direitos do Responsável Técnico |
| **Responsável Técnico** | **Nível 2** — vê os chamados **atribuídos a ele** e a **fila sem responsável** (o que outro RT já assumiu fica fora do alcance dele), usa o painel, atribui responsáveis, muda status/prioridade, escreve notas internas, **edita o cadastro e redefine a senha de contas com perfil Usuário** (as demais contas e a troca de perfil são só com o Super Admin) |
| **Usuário** | **Nível 1** — abrir chamados, acompanhar **somente os próprios** e responder na conversa — **não edita cadastro nem senha de ninguém** |

Quem se cadastra pela tela pública nasce como **Usuário** — só o Super Admin atribui os demais perfis
na tela **“Gerenciar usuários”**.

## Hierarquia de visualização e acesso aos chamados

A lista, o detalhe, as mensagens e a edição seguem **três níveis**: cada nível enxerga um pouco mais
que o anterior.

| Nível | Perfil | Vê na lista de chamados | Pode alterar |
|-------|--------|--------------------------|--------------|
| **1** | Usuário | somente os chamados **que ele abriu** | responde na conversa dos próprios |
| **2** | Responsável Técnico | **atribuídos a ele** + a **fila sem responsável** | status, prioridade e responsável — **dentro desse alcance** |
| **3** | Super Admin | **todos** os chamados | tudo (inclusive gestão de contas e auditoria) |

Comportamento decorrente da régua:

- O que **outro Responsável Técnico já assumiu** não aparece na lista do RT e devolve `403` no
  detalhe, na mensagem e na edição (“Este chamado está sob responsabilidade de outro Responsável
  Técnico.”).
- A **fila sem responsável** é o espaço compartilhado do nível 2: qualquer RT vê e pode assumir —
  ao assumir, o chamado sai da fila e passa a ser exclusivo daquele RT.
- O **painel** e as estatísticas usam a mesma régua: cada nível só soma o próprio alcance
  (`/api/stats` devolve `scope` e `assignedToMe`).
- O nível fica **visível na interface**: no topo (`Responsável Técnico · Nível 2 de 3`, com a
  régua no passar do mouse), no rótulo do menu e como legenda da própria lista — e o painel traz a
  tabela dos três níveis, marcando o seu.
- A aba **Histórico** segue a mesma régua e **não aparece para o perfil Usuário**: o nível 2 vê os
  encerrados do alcance dele e o nível 3 todos — sempre com **quem encerrou** e **quando** (a rota
  devolve `403` para o nível 1).
- **Reabrir chamado encerrado é exclusivo do Super Admin (nível 3)**: `PATCH /api/tickets/:id`
  recusa a troca de um status `resolvido`/`fechado` para `aberto`/`em_andamento` com `403` nos
  níveis 1 e 2, e a reabertura grava `reopened_at` + `reopened_by`.
- Um Usuário **continua acompanhando** o chamado que ele mesmo abriu mesmo depois que ele é
  atribuído a um Responsável Técnico.

## Tecnologias

| Parte    | Ferramenta                          |
|----------|-------------------------------------|
| Backend  | Node.js 24 + Express                |
| Banco    | SQLite (`node:sqlite`, sem drivers) |
| Frontend | HTML + CSS + JavaScript (sem build) |

Os dados ficam no arquivo `data/chamados.db`.

## Como rodar

```bash
npm install   # só na primeira vez
npm start
```

Ou dê dois cliques em **`iniciar.bat`** (sobe já pronto, sem credenciais de demonstração).

Depois abra: **http://localhost:3000**

> **Sobre o seed:** com a pasta `data/` apagada (banco novo) o servidor cria **um único Super
> Admin com senha aleatória** e imprime `Nome | E-mail | Senha` no console — troque a senha no
> primeiro acesso. As contas de demonstração (`admin123`, `ti123456`, `123456`) só são criadas
> quando você sobe com **`DEMO=true`**; as dicas da tela de login seguem a mesma variável
> (hoje desligada — o `iniciar.bat` não a define).

## Encerramento automático

Assim que um chamado fica **`resolvido`**, ele passa para **`fechado` sozinho** depois de **1
minuto**. A rotina (`fecharResolvidos()`) varre o banco **a cada 15 segundos** e registra no
console: `[auto] 1 chamado(s) resolvido(s) há 1 min → "fechado".`

| Situação | O que acontece |
|---|---|
| Fica `resolvido` por 1 min | vira `fechado` automaticamente (sem tocar em `closed_by`/`closed_at` — seguem sendo **quem resolveu e quando**) |
| É reaberto antes do prazo | volta a `em_andamento`/`aberto` e a contagem recomeça ao resolver de novo |
| Chamado `fechado` manualmente | nada muda (já está fechado) |

| Variável | Padrão | Descrição |
|---|---|---|
| `AUTO_CLOSE_MIN` | `1` | minutos que um chamado pode ficar `resolvido`; **`0` desliga** a rotina |

O prazo também é exposto em `GET /api/config` (`autoCloseMinutes`) e aparece no detalhe do chamado
(`Encerramento · Automático em ~1 min`) enquanto o status for `resolvido`.

## Backup do banco

O servidor mantém uma **cópia consistente** de `data/chamados.db` na pasta **`backup/`**:

- **na subida** do servidor e **a cada 24 h**;
- criada com `VACUUM INTO` — o SQLite monta o arquivo novo a partir de um ponto de
  consistência, mesmo com o sistema em uso (WAL), **sem travar** nada;
- **rotação automática**: ficam só as últimas **10** cópias do sistema
  (`backup/chamados-AAAA-MM-DD_HHMMSS.db`); arquivos colocados à mão nessa pasta **nunca** são
  apagados;
- no Super Admin, em *Gerenciar usuários → Backup do banco*, o botão **Fazer backup agora** e a
  lista das cópias (data e tamanho) — cada cópia manual é registrada na **trilha de auditoria**.

| Variável | Padrão | Descrição |
|---|---|---|
| `BACKUP_AUTO` | `true` | `false` desliga as cópias automáticas (a manual continua funcionando) |
| `BACKUP_DIR` | `backup/` | pasta de destino (pode apontar para outro disco) |
| `BACKUP_QTD` | `10` | quantas cópias do sistema são mantidas |
| `BACKUP_HORAS` | `24` | intervalo entre as cópias automáticas |

**Para restaurar:** pare o servidor → copie a cópia escolhida por cima de `data/chamados.db`
(apague também `data/chamados.db-wal` e `data/chamados.db-shm`, se existirem) → suba de novo.
Se quiser guardar aquela cópia específica, copie-a antes para outra pasta, porque a rotação
pode removê-la depois (a restauração não apaga nada na hora).

## E-mail de recuperação de senha

Quando alguém clica em **“Esqueceu a senha?”**, o servidor gera um link temporário e envia por
e-mail. Configure o SMTP em `iniciar.bat` (ou nas variáveis de ambiente do servidor):

| Variável | Exemplo | Descrição |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | servidor de saída |
| `SMTP_PORT` | `587` | `465` exige também `SMTP_SECURE=true` |
| `SMTP_USER` | `suasenha@empresa.com` | caixa que envia |
| `SMTP_PASS` | *(senha de aplicativo)* | no Gmail: **Senhas de app** (não a senha normal) |
| `SMTP_FROM` | `Central de Chamados` | remetente exibido (opcional) |
| `PUBLIC_URL` | `http://localhost:3000` | endereço usado no link (opcional) |
| `RESET_TTL_MIN` | `30` | validade do link em minutos (opcional) |
| `TRUST_PROXY` | `true` | **só atrás de proxy reverso** (túnel/nginx): confia no `X-Forwarded-For` para contar os limites por IP de verdade (opcional) |
| `DEMO` | *(ausente)* | `true` cria as contas de demonstração e mostra as dicas de login (opcional) |

**Sem essas variáveis** (ou se o envio falhar), o e-mail é gravado em **`data/outbox/*.eml`** e o
link aparece no console do servidor — o fluxo de recuperação funciona igual, sem conta de e-mail.

## Contas

Para entrar, informe o **Nome** (não o e-mail) e a senha — a busca ignora maiúsculas, acentos e espaços extras.

| Perfil | Nome (login) | Senha     | E-mail                   |
|--------|--------------|-----------|--------------------------|
| Super Admin | `Neves` | `Juni333!` | `jferreiracg@gmail.com` |

> **Os perfis de demonstração foram removidos** (Administração, Equipe de TI e João da Silva,
> junto com os chamados de exemplo). Uma cópia da base anterior está em
> `backup/chamados-demo-2026-10-03.db`.
> Novas contas são criadas pelo Super Admin em **Gerenciar usuários** (ou pelo auto-cadastro, se
> estiver aberto). Para recomeçar do zero, apague a pasta `data/` — nesse caso o seed recria as
> contas de demonstração, então apague-as logo em seguida.

## Segurança

Auditoria feita com payloads reais (SQLi, XSS, IDOR, força bruta, path traversal).

**Implementado:**

| Proteção | Como funciona |
|---|---|
| Força bruta | Máx. **5 falhas** por IP+nome e **30 falhas** por IP a cada 15 min → `429` + `Retry-After`; **só falhas contam** (login correto zera a cota da conta, então IP compartilhado não trava) |
| Identificação | A entrada é feita **pelo nome** (coluna `name_key` normalizada: sem acento/caixa, **única** e indexada) — o e-mail não é usado para entrar, então contas não são expostas na tela de login |
| Sessões | Expiram em **7 dias** (linhas vencidas são apagadas automaticamente) |
| Token de sessão | Guardado no banco como **SHA-256** — mesmo que o banco vaze, os tokens continuam inúteis (tokens antigos são migrados na subida) |
| Troca de senha | O diálogo pede **nova senha e confirmação** (só envia quando as duas coincidem, de **8** a 128 caracteres) e, ao redefinir, **todas as sessões ativas daquele usuário são encerradas** |
| Recuperação de senha | Pedido **sempre responde igual** (não revela se a conta existe); o link traz **token aleatório de 64 caracteres guardado como SHA-256**, validade de **30 min**, **uso único** (um link novo invalida os anteriores) e a troca encerra todas as sessões |
| E-mail | Limite de **3 pedidos por conta** e **10 por IP** a cada 15 min → `429` (evita bombardeio de e-mails); envio por SMTP (`nodemailer`) com *fallback* para `data/outbox` |
| Credenciais | **Nenhuma senha padrão**: banco novo **sem** `DEMO=true` cria um único Super Admin com **senha aleatória** impressa no console; `admin123`/`ti123456`/`123456` só existem com `DEMO=true` (hoje desligado) |
| Anti-spam | Auto-cadastro **10/h por IP**, abertura de chamados **30/h por conta** e comentários **60 a cada 10 min** → `429` + `Retry-After` |
| Login negado | As falhas entram na **trilha de auditoria** (`login.negado` com motivo e IP) e o custo do login é **igual existindo a conta ou não** — não dá para descobrir nomes cronometrando a resposta |
| Cache da API | Toda resposta de `/api` sai com `Cache-Control: no-store` e `X-Powered-By` fica desligado |
| Erros da API | Rota desconhecida → **`404` JSON** (não o HTML do SPA) · corpo malformado → **`400`** · corpo >100 kb → **`413`** · o `500` devolve só a mensagem, sem *stack trace* |
| Disponibilidade | Rotas assíncronas com captura de erro e `unhandledRejection` tratado: um erro em segundo plano **não derruba** o servidor |
| Cabeçalhos | `Content-Security-Policy` (scripts/só da própria origem), `X-Frame-Options: DENY` + `frame-ancestors 'none'` (clique grampeado), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `X-Permitted-Cross-Domain-Policies: none`, `X-XSS-Protection: 0` |
| CSRF | Toda mutação (`POST/PATCH/PUT/DELETE`) precisa de `Origin` igual ao próprio host (ou `Sec-Fetch-Site: same-origin`) → `403` + log `[segurança]` |
| Cadastro | O Super Admin pode **fechar o auto-cadastro** em *Gerenciar usuários → Preferências*; fechado, a aba de cadastro some da tela de login |
| Auditoria | Tabela `audit_log` com **ator, ação, alvo, detalhe, IP e data** de login, criação/alteração/exclusão de conta e mudança de configuração — visível em *Gerenciar usuários → Trilha de auditoria* |
| Entradas | Limites de tamanho no servidor: nome 2–80, e-mail ≤120, senha **8–128**, título 5–120, descrição 10–3000 caracteres |
| SQL Injection | Todas as queries são parametrizadas |
| XSS | Todo conteúdo exibido passa por escape de HTML |
| Autorização | **Hierarquia de 3 níveis** no servidor: nível 1 vê só os próprios chamados, nível 2 vê os atribuídos + a fila, nível 3 vê tudo — detalhe, mensagens e edição fora do alcance respondem `403`; painel e gestão de contas também por perfil |
| Senhas (quem altera) | **Super Admin** → qualquer conta · **Responsável Técnico** → só perfis `user` · **Usuário** → ninguém (rota `POST /api/users/:id/password` recusa com `403`) |
| Cadastro (quem edita) | **Super Admin** → qualquer conta (nome, e-mail e perfil) · **Responsável Técnico** → só perfis `user` e **sem** trocar perfil · **Usuário** → ninguém (`403`) |
| Senhas | Scrypt + salt, comparação em tempo constante, nunca em log · **mínimo de 8 caracteres** em toda criação/troca (contas existentes continuam valendo) · o campo da senha inicial já sai oculto na tela |
| Cookies | `HttpOnly` + `SameSite=Lax` (+ `Secure` quando `SECURE_COOKIE=true`) |
| Arquivos | Só `public/` é servido: `data/`, `server.js`, `backup/`, `certs/` e `package.json` devolvem o HTML do SPA (nenhum conteúdo é exposto) e caminhos com `..` não passam |
| Backup | Cópia consistente **na subida e a cada 24 h** em `backup/` (fora da área web), rotação das últimas 10, cópia manual pelo Super Admin registrada na trilha |
| Dependências | `npm audit` → 0 vulnerabilidades |

**Para expor na rede/internet:** publique atrás de um proxy com TLS (Caddy, nginx) e suba com
`SECURE_COOKIE=true` — o cookie de sessão passa a exigir HTTPS e o servidor envia
`Strict-Transport-Security` nas respostas over TLS. Com proxy reverso, adicione também
`TRUST_PROXY=true` para que os **limites por IP** (força bruta, auto-cadastro) contem o IP real
do cliente e não o do proxy. Localmente, `iniciar.bat`/`npm start` continuam usando
`http://localhost:3000` sem essas bandeiras.

## Proteção do código (senha ao acessar os arquivos)

A pasta do projeto está **travada no Windows (NTFS)**: só `SISTEMA`, `Administradores` e a conta
dono (`Júnior\Neves`) têm permissão. A herança da pasta `Documents` foi removida, então nada é
emprestado do diretório pai.

**Efeito:** um outro usuário do computador que tentar abrir ou alterar `server.js`, `iniciar.bat`
ou `data/chamados.db` recebe **“Acesso negado”**; se insistir, o Windows abre a janela de
Controle de Conta de Usuário pedindo a **senha de administrador**. Sem essa senha o código não é
lido nem modificado.

```powershell
# conferir quem tem acesso
icacls "C:\Users\Neves\Documents\Projeto Padrão"

# liberar acesso para outra pessoa (se um dia for preciso)
icacls "C:\Users\Neves\Documents\Projeto Padrão" /grant "DOMINIO\usuario:(OI)(CI)F"

# desfazer a trava e voltar às permissões antigas
icacls "C:\Users\Neves\Documents\Projeto Padrão" /restore "backup\acl-antes-da-trava.txt"
```

> Verificação feita na entrega: **976 arquivos** varridos, **0 falhas** e **nenhum** com
> permissão de `Users`, `Authenticated Users` ou `Everyone`.
> backup/ guarda a cópia das permissões anteriores (`acl-antes-da-trava.txt`).

## Estrutura

```
Projeto Padrão/
├── server.js          # API + autenticação + banco
├── mailer.js          # Envio de e-mail (SMTP com fallback para outbox)
├── package.json
├── iniciar.bat        # Sobe já pronto, sem DEMO (SMTP configurável aqui)
├── backup/            # Cópias de segurança do banco (SQLite)
├── certs/             # Raiz usada para validar o SMTP neste computador
├── public/
│   ├── index.html     # Shell da aplicação (login + área logada)
│   ├── styles.css     # Estilos
│   ├── app.js         # Rotas por hash, chamadas à API, renderização
│   ├── logo.svg       # Marca GTI-CG (topo + tela de login)
│   ├── fundo-login.webp # Foto de fundo da tela de login (com véu escuro)
│   └── icon.svg       # Ícone / favicon GTI-CG
└── data/
    ├── chamados.db    # Banco SQLite (criado automaticamente)
    └── outbox/        # E-mails quando o SMTP não está configurado
```

## Marca

A identidade visual **GTI-CG** está nos arquivos `public/logo.svg` e `public/icon.svg`:
símbolo com gradiente azul→violeta, wordmark `GTI-CG` e assinatura "Central de Chamados".
Para trocar as cores, altere as cores do `<linearGradient>` nos dois arquivos.

## Fundo da tela de login

A tela de login (`.auth` em `public/styles.css`) usa **`public/fundo-login.webp`** como foto de
fundo, cobrindo a tela inteira **atrás do cartão** de login, com um **véu escuro de 55%** por
cima para o formulário continuar legível. A foto atual é do **CICC — Centro Integrado de
Comando e Controle**.

- **Trocar a foto:** substitua `public/fundo-login.webp` (se for `.jpg`/`.png`, ajuste o nome
  no `url(...)` do bloco `.auth`).
- **Se a imagem faltar**, o CSS cai sozinho no gradiente azul/violeta original — a tela nunca
  fica branca.
- Aplicação: `background-size: cover` + `center`, em 3 camadas (véu → foto → gradiente), igual
  no celular e no desktop.
- As telas de **criar conta** e **recuperar senha** usam o mesmo fundo.

## API (resumo)

| Método | Rota                          | Acesso        |
|--------|-------------------------------|---------------|
| POST   | `/api/auth/register`          | público (sempre cria **Usuário**) |
| POST   | `/api/auth/login`             | público (corpo: `name` + `password`) |
| POST   | `/api/auth/logout`            | logado        |
| GET    | `/api/auth/me`                | público       |
| POST   | `/api/auth/forgot`            | público (e-mail ou nome; **sempre responde igual**) |
| GET    | `/api/auth/reset/:token`      | público (devolve a conta com e-mail mascarado) |
| POST   | `/api/auth/reset`             | público (token + nova senha + confirmação) |
| GET    | `/api/config`                 | público (mostra `demo`, `openRegistration`, `resetMinutes` e `autoCloseMinutes`) |
| GET    | `/api/tickets`                | logado (escopo do nível: **1** = os seus · **2** = atribuídos + fila · **3** = todos) |
| GET    | `/api/tickets/history`        | **RT / Admin** (encerrados no escopo do nível — devolve `closedBy` e `closedAt`) |
| POST   | `/api/tickets`                | logado        |
| GET    | `/api/tickets/:id`            | logado (**dentro do alcance do nível**, senão `403`) |
| POST   | `/api/tickets/:id/comments`   | logado (**dentro do alcance do nível**) |
| PATCH  | `/api/tickets/:id`            | RT / Admin (**dentro do alcance**; **reabrir encerrado só Super Admin**, grava `reopened_at`/`reopened_by`) |
| GET    | `/api/agents`                 | RT / Admin    |
| GET    | `/api/stats`                  | RT / Admin (só soma o escopo do nível + `assignedToMe`) |
| GET/POST | `/api/users`                | Super Admin (lista) · RT (só perfis `user`) |
| PATCH    | `/api/users/:id`           | Super Admin (qualquer conta, inclui perfil) · RT (só perfis `user`, só nome/e-mail) |
| DELETE   | `/api/users/:id`           | **Super Admin** |
| POST   | `/api/users/:id/password`    | Super Admin (qualquer conta) · RT (só perfis `user`) |
| GET/PUT | `/api/settings`               | **Super Admin** (`openRegistration`) |
| GET    | `/api/audit`                  | **Super Admin** (últimos eventos da trilha) |
| GET/POST | `/api/backup`               | **Super Admin** (lista as cópias · cria uma agora, registrada na trilha) |

No banco, o perfil é gravado como `admin` (Super Admin), `agent` (Responsável Técnico) ou `user` (Usuário).

Status possíveis: `aberto`, `em_andamento`, `resolvido`, `fechado`.
Prioridades: `baixa`, `media`, `alta`, `critica`.
