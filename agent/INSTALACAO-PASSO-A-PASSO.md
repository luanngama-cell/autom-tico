# 📘 Guia de Instalação do Agente SQL — Passo a Passo

> **Para quem é este guia?** Para quem **não é programador** e precisa explicar para o TI do hospital o que precisa ser feito, ou seguir junto com o TI durante a instalação.
>
> **Tempo estimado:** 30 a 60 minutos (com TI experiente).

---

## 🎯 O que é o Agente SQL e por que ele é necessário?

O **Agente SQL** é um pequeno programa que precisa ficar rodando **24h por dia** dentro do servidor onde está o SQL Server do ERP do hospital.

Ele faz duas coisas:
1. Lê dados do banco SQL Server local.
2. Envia esses dados, de forma segura, para a nuvem (este sistema).

Sem o agente rodando, o BI **nunca terá dados** para mostrar, porque ninguém estaria enviando eles para a nuvem.

```
┌──────────────────┐         ┌────────────┐         ┌──────────────────┐
│   SQL Server do  │  lê     │  AGENTE    │  envia  │   Esta nuvem     │
│   ERP no hospital│ ──────▶ │  SQL (.NET)│ ──────▶ │   (automaocaobd) │
└──────────────────┘         └────────────┘         └──────────────────┘
                                                              │
                                                              ▼
                                                     ┌────────────────┐
                                                     │ BI Hospital CMO│
                                                     │ (puxa dados)   │
                                                     └────────────────┘
```

---

## ✅ Checklist do que você precisa ter em mãos ANTES de começar

Peça ao seu TI para te ajudar a obter:

- [ ] **Acesso de administrador** ao servidor Windows onde está o SQL Server do hospital
- [ ] **Dados de conexão do banco SQL Server**:
  - Host (geralmente `127.0.0.1` ou `localhost` se for no mesmo servidor)
  - Porta (geralmente `1433`)
  - Nome do banco (ex.: `Protheus`, `MV2000`, etc.)
  - Usuário e senha do SQL Server
- [ ] **Acesso à internet** liberado no servidor (firewall) para o domínio:
  `https://automaocaobd.lovable.app`

---

## 🪪 PARTE 1 — Gerar as credenciais aqui no painel

Antes de instalar qualquer coisa no servidor, você precisa gerar **2 credenciais** aqui no painel desta plataforma.

### 1.1 — Token do Agente

1. No menu lateral, clique em **Conexões**
2. Crie uma nova conexão (ou abra a existente do hospital)
3. Clique em **"Gerar novo token"**
4. Vai aparecer um texto no formato:
   ```
   ca37c9e7-16a0-4bbd-9c3f-665570056cde.abc123xyz...
   ```
5. **Copie esse texto inteiro** (incluindo o ponto no meio) e guarde num bloco de notas. Você vai colar ele depois.

> ⚠️ Esse token aparece **uma única vez**. Se perder, precisa gerar outro.

### 1.2 — Confirmar destino BI ativo

1. Vá em **Destinos BI** (ou no menu correspondente)
2. Confirme que existe um destino chamado **"BI"** e que está **Habilitado** ✅

Pronto! Pode partir para o servidor.

---

## 🖥️ PARTE 2 — No servidor do hospital (TI faz)

> **Para o TI:** os comandos abaixo devem ser executados no **PowerShell como Administrador**.

### 2.1 — Instalar o .NET 8 SDK

Baixe e instale:
👉 https://dotnet.microsoft.com/download/dotnet/8.0

Escolha **".NET 8.0 SDK x64"** para Windows. Próximo, próximo, instalar.

Depois confirme que instalou abrindo um PowerShell e digitando:
```powershell
dotnet --version
```
Deve aparecer algo como `8.0.xxx`.

### 2.2 — Copiar o código do agente para o servidor

A pasta `agent/` deste projeto contém todo o código do agente. Você tem duas opções:

**Opção A (mais simples):** Pedir para o programador (ou para a Lovable) gerar o ZIP da pasta `agent/` e enviar.

**Opção B:** Baixar o projeto inteiro pelo botão **"Export to GitHub"** no canto superior direito do Lovable, depois clonar no servidor.

Coloque a pasta em algum lugar simples, por exemplo:
```
C:\fonte-agente\
```

### 2.3 — Compilar o agente

No PowerShell **como Administrador**, rode:

```powershell
cd C:\fonte-agente\agent
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o C:\sqlsync-agent
```

Isso vai gerar um único `SqlSyncAgent.exe` dentro de `C:\sqlsync-agent\`.

### 2.4 — Configurar o `appsettings.json`

Abra o arquivo `C:\sqlsync-agent\appsettings.json` no Bloco de Notas e ajuste para:

```json
{
  "Cloud": {
    "BaseUrl": "https://automaocaobd.lovable.app",
    "AgentSecret": "PEÇA-PARA-O-LOVABLE-O-VALOR-DE-AGENT_INGEST_SECRET",
    "Token": "COLE-AQUI-O-TOKEN-GERADO-NO-PASSO-1.1"
  },
  "Sql": {
    "Host": "127.0.0.1",
    "Port": 1433,
    "Database": "NOME-DO-BANCO-DO-ERP",
    "AuthMode": "Sql",
    "Username": "USUARIO-DO-SQL",
    "Password": "SENHA-DO-SQL",
    "Encrypt": true,
    "TrustServerCertificate": true
  },
  "Sync": {
    "IntervalSeconds": 60,
    "Schema": "dbo",
    "MaxRowsPerTablePerCycle": 50000,
    "ExcludedTables": []
  },
  "Bi": {
    "Enabled": true,
    "ScriptPath": "C:\\sqlsync\\extrair-pmedico_19.sql",
    "IntervalSeconds": 300,
    "CommandTimeoutSeconds": 600,
    "PushPath": "api/public/bi/push"
  }
}
```

**Substitua os campos em MAIÚSCULAS pelos valores reais.**

> 💡 **`AGENT_INGEST_SECRET`**: esse valor está armazenado em segurança no Lovable. Me peça aqui no chat e eu te mostro como recuperar (ou eu rotaciono e gero um novo).

### 2.5 — Colocar o script SQL do BI no lugar

Crie a pasta:
```powershell
mkdir C:\sqlsync
```

Coloque dentro o arquivo `extrair-pmedico_19.sql` (script que extrai os dados que o BI vai mostrar). Se você não tem esse script ainda, me avise — podemos criar um.

### 2.6 — Testar manualmente (antes de instalar como serviço)

Abra o PowerShell, vá até a pasta e rode:

```powershell
cd C:\sqlsync-agent
.\SqlSyncAgent.exe
```

Você deve ver mensagens tipo:
```
[INFO] Connecting to SQL Server 127.0.0.1:1433...
[INFO] Manifest loaded, 12 tables to sync
[INFO] BI script executed, payload sent: 200 OK
```

Se der erro, **leia a mensagem com calma** — geralmente é:
- Senha do SQL errada → corrige no `appsettings.json`
- Token errado → gera outro no painel
- Sem internet → libera firewall

Pressione `Ctrl+C` para parar quando tiver visto que funciona.

### 2.7 — Instalar como serviço Windows (rodar 24h)

```powershell
sc.exe create SqlSyncAgent binPath= "C:\sqlsync-agent\SqlSyncAgent.exe" start= auto
sc.exe start SqlSyncAgent
```

Pronto! O agente vai iniciar sozinho toda vez que o servidor ligar.

Para conferir status depois:
```powershell
sc.exe query SqlSyncAgent
```

Logs detalhados ficam em:
```
C:\sqlsync-agent\agent.log
```

---

## ✅ PARTE 3 — Confirmar que está funcionando

Após 5 minutos do agente rodando:

1. Volta neste painel (Lovable)
2. Vai em **APIs** → seção do BI
3. Deve aparecer: **Último envio: há X minutos** ✅
4. No BI Hospital CMO, clica em **"Sincronizar agora"** — deve dar sucesso ✅

---

## 🆘 Deu errado? Onde pedir ajuda

Cole aqui no chat:
1. A mensagem de erro que apareceu
2. As últimas 30 linhas do arquivo `C:\sqlsync-agent\agent.log`

Que eu te ajudo a resolver.

---

## 📋 Resumo super curto (TL;DR)

1. Aqui no painel: gere o **Token do Agente**
2. No servidor do hospital: instale .NET 8, compile o agente, edite `appsettings.json` com token + dados do SQL
3. Teste com `.\SqlSyncAgent.exe` no PowerShell
4. Funcionou? Instale como serviço Windows com `sc.exe create`
5. Confirme no painel que aparece "Último envio"
