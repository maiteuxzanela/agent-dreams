/**
 * TICKET-DREAMS-02 — Suíte determinística REAL (SDET) — ZERO mocks.
 *
 * Escopo deste arquivo (card "Redação exaustiva de credenciais em
 * src/core/security.ts e lockfile seguro em bin/dreams-consolidate.sh via
 * XDG_RUNTIME_DIR"):
 *
 *   FRENTE 1 — src/core/security.ts · REDAÇÃO EXAUSTIVA
 *     - AWS Access Key ID (`AKIA...`), AWS Secret Access Key (atribuição);
 *     - Stripe live (`sk_live_`/`rk_live_`);
 *     - Slack (`xoxb-`/`xoxp-`/`xoxa-`/`xoxs-`);
 *     - blocos PEM (`-----BEGIN ... PRIVATE KEY-----`);
 *     - credenciais embutidas em URL (`http://user:pass@host`);
 *     - idempotência + `containsSecret` (defesa em profundidade).
 *
 *   FRENTE 2 — PROVA END-TO-END (security.ts → src/core/db.ts)
 *     - o segredo NÃO sobrevive até os BYTES do SQLite (db/-wal/-shm).
 *
 *   FRENTE 3 — bin/dreams-consolidate.sh · ISOLAMENTO DO LOCKFILE
 *     - precedência: DREAMS_LOCK_FILE → XDG_RUNTIME_DIR → /tmp por-UID;
 *     - o diretório de runtime do usuário é usado quando existe e é gravável;
 *     - o fallback em /tmp é POR-UID (nunca o caminho compartilhado);
 *     - alvo inseguro (symlink plantado) NUNCA é seguido — degrada para o
 *       diretório privado do próprio usuário.
 *
 * Infraestrutura REAL: módulo de produção real, SQLite real em diretório
 * temporário, o script bash real executado em subprocesso real e um sandbox
 * bwrap real para o tier de fallback em /tmp (que exigiria tocar o /tmp real).
 * ZERO `unittest.mock`/`jest.mock`/stubs/fakes.
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  redactSecrets,
  containsSecret,
  REDACTED_PLACEHOLDER,
  REDACTED_JWT_PLACEHOLDER,
} from "../src/core/security";
import { DreamsDB } from "../src/core/db";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "bin", "dreams-consolidate.sh");

const UID = typeof process.getuid === "function" ? process.getuid() : 1000;

// Segredos SINTÉTICOS (nenhum é real) com a forma exata dos padrões.
const AWS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16 [0-9A-Z]
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // 40 chars base64
const STRIPE_LIVE = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"; // sk_live_ + 24
const STRIPE_RESTRICTED = "rk_live_4eC39HqLyjWDarjtT1zdp7dc"; // rk_live_ + 24
const SLACK_BOT = "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx";
const SLACK_WORKSPACE = "xoxp-123456789012-123456789012-abcdefghijklmnopqrstuvwx";
const PEM_BODY = "MIIEowIBAAKCAQEAwJ2X0mQ0hVZ2xvYmVyZmx1dCBoaXNzaWduYXR1cmUgdGhpcyBpcyBub3QgcmVhbA";
const PEM_BLOCK = [
  "-----BEGIN RSA PRIVATE KEY-----",
  PEM_BODY,
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const tempDirs: string[] = [];

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      // Limpeza best-effort: o diretório temporário é descartado pelo SO no
      // final do processo de teste. O erro é engolido DE PROPÓSITO (e de forma
      // explícita) para não mascarar a asserção que está sendo avaliada.
      void error;
    }
  }
});

// ===========================================================================
// FRENTE 1 — REDAÇÃO EXAUSTIVA (src/core/security.ts)
// ===========================================================================
describe("[DREAMS-02/1] security.ts: redação de credenciais", () => {
  test("AWS Access Key ID (AKIA...) é redigido preservando o prefixo", () => {
    const out = redactSecrets(`chave aws: ${AWS_KEY_ID} fim`);
    expect(out).toContain(`AKIA${REDACTED_PLACEHOLDER}`);
    expect(out).not.toContain(AWS_KEY_ID);
    expect(containsSecret(AWS_KEY_ID)).toBe(true);
    expect(containsSecret(out)).toBe(false);
  });

  test("AWS Secret Access Key em ATRIBUIÇÃO é redigido (o \\b não casa em aws_secret_access_key)", () => {
    const text = `aws_secret_access_key=${AWS_SECRET}`;
    const out = redactSecrets(text);
    expect(out).not.toContain(AWS_SECRET);
    expect(out).toContain("aws_secret_access_key=");
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(containsSecret(text)).toBe(true);
  });

  test("Stripe live (sk_live_/rk_live_) é redigido preservando o prefixo", () => {
    for (const secret of [STRIPE_LIVE, STRIPE_RESTRICTED]) {
      const out = redactSecrets(`stripe: ${secret}`);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED_PLACEHOLDER);
      expect(out).toMatch(/(sk|rk)_live_\*\*\*REDACTED\*\*\*/);
      expect(containsSecret(secret)).toBe(true);
      expect(containsSecret(out)).toBe(false);
    }
  });

  test("Slack (xoxb-/xoxp-) é redigido preservando o prefixo", () => {
    for (const secret of [SLACK_BOT, SLACK_WORKSPACE]) {
      const out = redactSecrets(`slack: ${secret}`);
      expect(out).not.toContain(secret);
      expect(out).toMatch(/xox[bp]-\*\*\*REDACTED\*\*\*/);
      expect(containsSecret(secret)).toBe(true);
      expect(containsSecret(out)).toBe(false);
    }
  });

  test("bloco PEM de chave privada é redigido INTEIRO (corpo incluso)", () => {
    const out = redactSecrets(`chave:\n${PEM_BLOCK}\nfim`);
    expect(out).not.toContain(PEM_BODY);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).not.toContain("END RSA PRIVATE KEY");
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(containsSecret(PEM_BLOCK)).toBe(true);
    expect(containsSecret(out)).toBe(false);
  });

  test("credenciais embutidas em URL são redigidas preservando esquema e host", () => {
    const out = redactSecrets("https://admin:s3cr3tP4ss@api.example.com/v1/resource");
    expect(out).not.toContain("s3cr3tP4ss");
    expect(out).not.toContain("admin:");
    expect(out).toContain("https://");
    expect(out).toContain("@api.example.com");
    expect(out).toContain(`${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`);
    expect(containsSecret("http://user:pass@host")).toBe(true);
    expect(containsSecret(out)).toBe(false);
  });

  test("a redação é IDEMPOTENTE (re-redigir não altera o resultado)", () => {
    const raw = [
      `aws ${AWS_KEY_ID}`,
      `stripe ${STRIPE_LIVE}`,
      `slack ${SLACK_BOT}`,
      `pem ${PEM_BLOCK}`,
      "https://u:p@h.example.com",
    ].join("\n");
    const once = redactSecrets(raw);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
    expect(containsSecret(once)).toBe(false);
  });

  test("os placeholders canônicos são estáveis", () => {
    expect(REDACTED_PLACEHOLDER).toBe("***REDACTED***");
    expect(REDACTED_JWT_PLACEHOLDER).toBe("***REDACTED_JWT***");
  });
});

// ===========================================================================
// FRENTE 2 — PROVA END-TO-END: o segredo não chega aos BYTES do SQLite
// ===========================================================================
describe("[DREAMS-02/2] redação no seam de persistência (security.ts → db.ts)", () => {
  test("o segredo não sobrevive nos bytes de dreams.db/-wal/-shm", () => {
    const dir = makeTmp("dreams02_persist_");
    const dbPath = path.join(dir, "dreams.db");
    const db = new DreamsDB(dbPath);

    const secret = AWS_KEY_ID;
    db.insertMemory("collective", `a chave da aws é ${secret} e o stripe é ${STRIPE_LIVE}`, "learning");

    // 1) A linha gravada já vem redigida.
    const rows = db.getAllMemories();
    expect(rows.length).toBe(1);
    expect(rows[0].fact).not.toContain(secret);
    expect(rows[0].fact).not.toContain(STRIPE_LIVE);
    expect(containsSecret(rows[0].fact)).toBe(false);

    // 2) Nenhum artefato SQLite contém o segredo em BYTES (nem db, nem WAL,
    //    nem SHM) — a camada de disco também está limpa.
    for (const artifact of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (!fs.existsSync(artifact)) continue;
      const bytes = fs.readFileSync(artifact);
      expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(STRIPE_LIVE, "utf8"))).toBe(false);
    }

    db.close();

    // 3) Após o close (checkpoint), o arquivo principal também está limpo.
    const afterClose = fs.readFileSync(dbPath);
    expect(afterClose.includes(Buffer.from(secret, "utf8"))).toBe(false);
    expect(afterClose.includes(Buffer.from(STRIPE_LIVE, "utf8"))).toBe(false);
  });
});

// ===========================================================================
// FRENTE 3 — ISOLAMENTO DO LOCKFILE (bin/dreams-consolidate.sh)
// ===========================================================================

/** HOME isolado + diretório de runtime (XDG) isolado. */
interface Sandbox {
  home: string;
  runtimeDir: string;
  log: string;
}

function makeSandbox(): Sandbox {
  const home = makeTmp("dreams02_home_");
  const runtimeDir = path.join(home, "xdg-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  return {
    home,
    runtimeDir,
    log: path.join(home, ".local", "state", "opencode-dreams.log"),
  };
}

/** Lê o log do wrapper (o "Lockfile resolvido" é gravado antes do redirect). */
function readLog(home: string): string {
  const logPath = path.join(home, ".local", "state", "opencode-dreams.log");
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

/**
 * Executa o wrapper REAL em subprocesso real, com HOME isolado.
 * O CLI do plugin NÃO existe no HOME isolado ⇒ o script sai com 1 logo após
 * o lock (a checagem do CLI precede o probe de conectividade) — sem rede.
 */
function runScript(
  home: string,
  env: Record<string, string | undefined>
): { status: number; log: string } {
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      DREAMS_OFFLINE: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, log: readLog(home) };
}

/**
 * Executa o wrapper dentro de um sandbox bwrap com /tmp PRIVADO.
 * Necessário para exercitar o fallback em /tmp (e o ataque via symlink) sem
 * tocar o /tmp real da máquina.
 */
function runScriptInSandbox(
  sandbox: Sandbox,
  options: { env?: Record<string, string>; pre?: string[] } = {}
): { status: number; log: string } {
  const bwrap = Bun.which("bwrap");
  if (!bwrap) throw new Error("bwrap indisponível");

  const scriptDir = path.join(sandbox.home, "script");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scriptDir, "dreams-consolidate.sh"));
  fs.chmodSync(path.join(scriptDir, "dreams-consolidate.sh"), 0o755);

  const inner = [...(options.pre ?? []), "exec bash /tmp/script/dreams-consolidate.sh"];
  const result = Bun.spawnSync(
    [
      bwrap,
      "--unshare-user",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/home",
      "--bind",
      sandbox.home,
      "/tmp/sandbox-home",
      "--ro-bind",
      scriptDir,
      "/tmp/script",
      "--chdir",
      "/tmp",
      "--setenv",
      "HOME",
      "/tmp/sandbox-home",
      "--setenv",
      "PATH",
      `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      "--setenv",
      "DREAMS_OFFLINE",
      "1",
      ...Object.entries(options.env ?? {}).flatMap(([k, v]) => ["--setenv", k, String(v)]),
      "bash",
      "-c",
      inner.join("\n"),
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0 && readLog(sandbox.home) === "") {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`sandbox falhou (exit=${result.exitCode}): ${stderr.slice(0, 400)}`);
  }
  return { status: result.exitCode, log: readLog(sandbox.home) };
}

describe("[DREAMS-02/3] bin/dreams-consolidate.sh: isolamento do lockfile", () => {
  test("TIER 1: DREAMS_LOCK_FILE tem precedência sobre o XDG_RUNTIME_DIR", () => {
    const sandbox = makeSandbox();
    const explicit = path.join(sandbox.home, "explicit.lock");

    const { status, log } = runScript(sandbox.home, {
      DREAMS_LOCK_FILE: explicit,
      XDG_RUNTIME_DIR: sandbox.runtimeDir,
    });

    expect(status).toBe(1); // CLI ausente ⇒ falha fatal (o lock foi adquirido)
    expect(log).toContain(`Lockfile resolvido: ${explicit}`);
    expect(log).not.toContain(sandbox.runtimeDir);
    expect(fs.existsSync(explicit)).toBe(true);
  });

  test("TIER 2: XDG_RUNTIME_DIR gravável é usado (lock isolado por usuário)", () => {
    const sandbox = makeSandbox();

    const { status, log } = runScript(sandbox.home, { XDG_RUNTIME_DIR: sandbox.runtimeDir });

    expect(status).toBe(1);
    const expected = path.join(sandbox.runtimeDir, "opencode-dreams.lock");
    expect(log).toContain(`Lockfile resolvido: ${expected}`);
    expect(fs.existsSync(expected)).toBe(true);
    // O lock NÃO foi plantado no /tmp compartilhado.
    expect(log).not.toContain("/tmp/opencode-dreams.lock");
  });

  test("TIER 3: sem runtime dir utilizável ⇒ fallback POR-UID em /tmp (nunca o caminho compartilhado)", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      console.warn("[skip] bwrap indisponível — teste do fallback /tmp ignorado");
      expect(true).toBe(true);
      return;
    }
    const sandbox = makeSandbox();
    const missingRuntime = path.join(sandbox.home, "runtime-inexistente");

    const { status, log } = runScriptInSandbox(sandbox, {
      env: { XDG_RUNTIME_DIR: missingRuntime },
    });

    expect(status).toBe(1);
    // O fallback é POR-UID: `/tmp/opencode-dreams-<uid>.lock`.
    expect(log).toContain(`Lockfile resolvido: /tmp/opencode-dreams-${UID}.lock`);
    // E NUNCA o caminho compartilhado (que permitiria sequestro por symlink).
    expect(log).not.toContain("Lockfile resolvido: /tmp/opencode-dreams.lock\n");
  });

  test("TIER 3.5: symlink plantado no alvo do /tmp NUNCA é seguido (degrada para o home privado)", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      console.warn("[skip] bwrap indisponível — teste de sequestro do lockfile ignorado");
      expect(true).toBe(true);
      return;
    }
    const sandbox = makeSandbox();
    const missingRuntime = path.join(sandbox.home, "runtime-inexistente");
    const sentinel = path.join(sandbox.home, "sentinel.txt");
    fs.writeFileSync(sentinel, "ORIGINAL", "utf8");

    const { status, log } = runScriptInSandbox(sandbox, {
      env: { XDG_RUNTIME_DIR: missingRuntime },
      // Symlink plantado por um atacante local no caminho de fallback.
      pre: [
        `ln -sf /tmp/sandbox-home/sentinel.txt /tmp/opencode-dreams-${UID}.lock`,
        `ls -l /tmp/opencode-dreams-${UID}.lock`,
      ],
    });

    expect(status).toBe(1);
    // O symlink NÃO foi seguido: o sentinela está intacto.
    expect(fs.readFileSync(sentinel, "utf8")).toBe("ORIGINAL");
    // O lock degradou para o diretório PRIVADO do próprio usuário.
    expect(log).toContain("Lockfile resolvido: /tmp/sandbox-home/.local/state/opencode-dreams.lock");
  });

  test("TIER 3.5: symlink DANGLING no alvo do /tmp NUNCA é seguido (o path-arbitrário do atacante NÃO é criado)", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      console.warn("[skip] bwrap indisponível — teste do symlink dangling ignorado");
      expect(true).toBe(true);
      return;
    }
    const sandbox = makeSandbox();
    const missingRuntime = path.join(sandbox.home, "runtime-inexistente");
    // Alvo do atacante INEXISTENTE ⇒ o symlink é DANGLING. `[ -e ]` SEGUE o
    // link e reporta "inexistente", então o teste do symlink PRECEDE o da
    // existência — se a ordem se inverter, este link seria seguido e o arquivo
    // seria criado num path escolhido pelo atacante (mutação-sensível).
    const attackerTarget = path.join(sandbox.home, "alvo-do-atacante.txt");
    expect(fs.existsSync(attackerTarget)).toBe(false);

    const { status, log } = runScriptInSandbox(sandbox, {
      env: { XDG_RUNTIME_DIR: missingRuntime },
      pre: [
        `ln -sf /tmp/sandbox-home/alvo-do-atacante.txt /tmp/opencode-dreams-${UID}.lock`,
        // Comprovação da pré-condição: o path É symlink e É dangling.
        `ln -l /tmp/opencode-dreams-${UID}.lock > /tmp/sandbox-home/estado-symlink.txt 2>&1 || true`,
        `test -L /tmp/opencode-dreams-${UID}.lock && echo "IS-SYMLINK" >> /tmp/sandbox-home/estado-symlink.txt || echo "NOT-SYMLINK" >> /tmp/sandbox-home/estado-symlink.txt`,
        `test ! -e /tmp/opencode-dreams-${UID}.lock && echo "IS-DANGLING" >> /tmp/sandbox-home/estado-symlink.txt || echo "NOT-DANGLING" >> /tmp/sandbox-home/estado-symlink.txt`,
      ],
    });

    expect(status).toBe(1);
    // (a) O path ARBITRÁRIO escolhido pelo atacante NÃO pode ter sido criado.
    expect(fs.existsSync(attackerTarget)).toBe(false);
    // (b) O lock degradou para o diretório PRIVADO do próprio usuário.
    expect(log).toContain("Lockfile resolvido: /tmp/sandbox-home/.local/state/opencode-dreams.lock");

    // Prova de que a pré-condição foi mesmo estabelecida (evita verde falso):
    // o path do fallback era um symlink E dangling antes do script rodar.
    const estado = fs.readFileSync(path.join(sandbox.home, "estado-symlink.txt"), "utf8");
    expect(estado).toContain("IS-SYMLINK");
    expect(estado).toContain("IS-DANGLING");
  });

  test("TIER 3.5: home privado hostil (symlink) ⇒ ABORTA fail-closed, sem escrever em NENHUM alvo", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      console.warn("[skip] bwrap indisponível — teste de fail-closed ignorado");
      expect(true).toBe(true);
      return;
    }
    const sandbox = makeSandbox();
    const missingRuntime = path.join(sandbox.home, "runtime-inexistente");
    // Até o destino do degrade é validado: symlink no home privado ⇒ aborta.
    const attackerTarget = path.join(sandbox.home, "alvo-final.txt");
    expect(fs.existsSync(attackerTarget)).toBe(false);

    const { status, log } = runScriptInSandbox(sandbox, {
      env: { XDG_RUNTIME_DIR: missingRuntime },
      pre: [
        // Os DOIS candidatos são hostis: o do /tmp e o do home privado.
        `ln -sf /tmp/sandbox-home/alvo-do-atacante.txt /tmp/opencode-dreams-${UID}.lock`,
        `mkdir -p /tmp/sandbox-home/.local/state`,
        `ln -sf /tmp/sandbox-home/alvo-final.txt /tmp/sandbox-home/.local/state/opencode-dreams.lock`,
      ],
    });

    expect(status).toBe(1);
    // NENHUM path escolhido pelo atacante foi criado.
    expect(fs.existsSync(attackerTarget)).toBe(false);
    expect(fs.existsSync(path.join(sandbox.home, "alvo-do-atacante.txt"))).toBe(false);
    // E o abort fail-closed ficou registrado no log.
    expect(log).toContain("nenhum alvo de lockfile seguro");
  });
});
