/**
 * TICKET-DREAMS-05 — Suíte determinística SDET (Test Engineer) — ZERO mocks.
 *
 * Frente 5A (tooling): package.json (devDeps typescript/@types/bun + scripts
 *   canônicos), remoção do package-lock.json, bun.lock regenerado e
 *   `bun run typecheck` 100% OFFLINE (proxies em porta morta).
 *
 * Frente 5B (lock operacional de bin/dreams-consolidate.sh):
 *   - contenção por `flock -n` ⇒ saída graciosa (exit 0), sem tocar em estado
 *     e sem sequer checar o CLI;
 *   - aquisição exclusiva + propagação de exit code fatal (CLI ausente ⇒ 1);
 *   - agregação semântica real de `track_exit`/`run_step` (fatal 1 > 75 > 0)
 *     extraída do PRÓPRIO script (mutation-sensitive: se a regra mudar, quebra).
 *
 * Recorder multiline: guardas de integridade em tests/dreams.test.ts +
 * round-trip real de argv com newlines embutidos (NUL, nunca `\n`).
 *
 * Offline: toda variável de proxy aponta para 127.0.0.1:9 (porta morta) e o
 * runner é executado com DREAMS_OFFLINE=1 (script `test` do package.json).
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { MimoSynthesizer } from "../src/core/mimo_synthesizer";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "bin", "dreams-consolidate.sh");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const BUN_LOCK = path.join(REPO_ROOT, "bun.lock");
const NPM_LOCK = path.join(REPO_ROOT, "package-lock.json");
const TSC_BIN = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const DREAMS_TEST = path.join(import.meta.dir, "dreams.test.ts");

// Prova de ausência de rede: qualquer tentativa de egress cai em porta morta.
const DEAD_PROXY = "http://127.0.0.1:9";
const OFFLINE_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  all_proxy: DEAD_PROXY,
  DREAMS_OFFLINE: "1",
};

const tempDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* limpeza best-effort */
    }
  }
});

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  throw new Error("waitFor: condição não satisfeita no tempo limite");
}

// ---------------------------------------------------------------------------
// FRENTE 5A — saneamento de tooling
// ---------------------------------------------------------------------------
describe("[5A] tooling: package.json, lockfile e typecheck offline", () => {
  test("package.json expõe exatamente os scripts canônicos e as devDeps exigidas", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));

    expect(pkg.scripts.test).toBe("DREAMS_OFFLINE=1 bun test");
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");

    const dev = pkg.devDependencies ?? {};
    expect(dev.typescript).toBeDefined();
    expect(dev["@types/bun"]).toBeDefined();
    // bun-types preservado (não regride a stack de tipos anterior).
    expect(dev["bun-types"]).toBeDefined();
  });

  test("package-lock.json removido e bun.lock presente/consistente com as devDeps", () => {
    expect(fs.existsSync(NPM_LOCK)).toBe(false);
    expect(fs.existsSync(BUN_LOCK)).toBe(true);

    const lock = fs.readFileSync(BUN_LOCK, "utf8");
    expect(lock).toContain("typescript");
    expect(lock).toContain("@types/bun");
  });

  test("bun install --frozen-lockfile concorda com bun.lock (offline)", () => {
    const r = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
      cwd: REPO_ROOT,
      env: OFFLINE_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(r.stderr);
    expect(r.exitCode).toBe(0);
    expect(stderr.toLowerCase()).not.toContain("error");
  });

  test("bun run typecheck resolve com EXIT 0 usando o tsc LOCAL, sem rede", () => {
    // Guarda de pré-condição: o binário local de tipos existe de fato.
    expect(fs.existsSync(TSC_BIN)).toBe(true);

    const r = Bun.spawnSync(["bun", "run", "typecheck"], {
      cwd: REPO_ROOT,
      env: OFFLINE_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FRENTE 5B — lock exclusivo + propagação de exit codes
// ---------------------------------------------------------------------------
// TICKET-DREAMS-03: o CLI passou a ser resolvido DINAMICAMENTE a partir da
// localização do script (`dirname "$(readlink -f "$0")"`), sem depender do
// `$HOME` de um usuário específico. O override `DREAMS_CLI_PATH` é o seam
// canônico para simular um CLI genuinamente ausente sem depender do layout
// de instalação da máquina de teste.
const MISSING_CLI = "/nonexistent/agent-dreams/src/cli.ts";

function runScript(
  home: string,
  lockFile: string,
  extraEnv: Record<string, string> = {}
): { status: number; log: string } {
  const r = Bun.spawnSync(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...OFFLINE_ENV, HOME: home, DREAMS_LOCK_FILE: lockFile, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logPath = path.join(home, ".local", "state", "agent-dreams.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  return { status: r.exitCode, log };
}

describe("[5B] bin/dreams-consolidate.sh: lock exclusivo e exit codes", () => {
  test("contrato estático: modo estrito, flock -n, traps de limpeza e lock configurável", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain("set -euo pipefail");
    expect(src).toContain("flock -n");
    expect(src).toContain("trap cleanup EXIT");
    expect(src).toContain("trap 'exit 130' INT");
    expect(src).toContain("trap 'exit 143' TERM");
    expect(src).toContain("trap 'exit 129' HUP");
    expect(src).toContain('exit "$EXIT_CODE"');
    expect(src).toContain("DREAMS_LOCK_FILE");
  });

  test("contenção: 2ª instância sai com 0, loga skip benigno e NÃO checa o CLI", async () => {
    const home = makeTmp("dreams05_home_");
    const lock = path.join(makeTmp("dreams05_lock_"), "consolidate.lock");
    fs.writeFileSync(lock, "");
    fs.writeFileSync(
      path.join(home, "holder.sh"),
      [
        "#!/usr/bin/env bash",
        `touch "${path.join(home, "ready")}"`,
        `while [ ! -f "${path.join(home, "stop")}" ]; do sleep 0.05; done`,
      ].join("\n")
    );
    const ready = path.join(home, "ready");
    const stop = path.join(home, "stop");

    // Retém o flock REAL num processo externo antes de disparar a 2ª instância.
    const holder = Bun.spawn(
      ["flock", "-x", lock, "bash", path.join(home, "holder.sh")],
      { env: OFFLINE_ENV, stdout: "ignore", stderr: "ignore" }
    );
    try {
      await waitFor(() => fs.existsSync(ready)); // lock comprovadamente retido
      const { status, log } = runScript(home, lock, { DREAMS_CLI_PATH: MISSING_CLI });

      expect(status).toBe(0); // skip benigno, nunca erro fatal
      expect(log).toContain("Outra instância de consolidação já está em execução");
      // Saiu ANTES do lock/CLI: não há "Lock exclusivo adquirido" nem checagem de CLI.
      expect(log).not.toContain("Lock exclusivo adquirido");
      expect(log).not.toContain("CLI não encontrado");
    } finally {
      fs.writeFileSync(stop, "");
      await holder.exited;
    }
  });

  test("aquisição exclusiva + propagação fatal: CLI ausente ⇒ exit 1, com lock adquirido", () => {
    const home = makeTmp("dreams05_home_"); // HOME sem CLI instalado
    const lock = path.join(makeTmp("dreams05_lock_"), "consolidate.lock");

    // CLI apontado para um caminho inexistente: a resolução dinâmica do plugin
    // (TICKET-DREAMS-03) é sobreposta pelo seam explícito DREAMS_CLI_PATH.
    const { status, log } = runScript(home, lock, { DREAMS_CLI_PATH: MISSING_CLI });

    expect(status).toBe(1); // falha fatal (0/75/1 semânticos preservados)
    expect(log).toContain("Lock exclusivo adquirido");
    expect(log).toContain("CLI não encontrado");
    // Não chegou ao probe de conectividade (checagem de CLI vem antes da sonda HTTP).
    expect(log).not.toContain("Conectividade OK");
  });

  test("o lock é efetivamente liberado após a saída (flock -n volta a vencer)", () => {
    const home = makeTmp("dreams05_home_");
    const lock = path.join(makeTmp("dreams05_lock_"), "consolidate.lock");
    runScript(home, lock, { DREAMS_CLI_PATH: MISSING_CLI }); // adquire e libera no EXIT

    const probe = Bun.spawnSync(["flock", "-n", lock, "true"], {
      env: OFFLINE_ENV,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(probe.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FRENTE 5B — agregação semântica de exit code (lógica extraída do script real)
// ---------------------------------------------------------------------------
function extractFunction(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`função ${name}() não encontrada no script`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`fecha-chaves de ${name}() não encontrado`);
}

describe("[5B] track_exit/run_step: prioridade fatal > tempfail > sucesso", () => {
  test("agrega 75, permite fatal 1 prevalecer e nunca deixa o sucesso mascarar erro", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const harness = [
      "#!/usr/bin/env bash",
      "EXIT_CODE=0",
      extractFunction(src, "track_exit"),
      extractFunction(src, "run_step"),
      // cenário 1: apenas tempfail
      "run_step bash -c 'exit 75'",
      'echo "C1=$EXIT_CODE"',
      // cenário 2: sucesso não zera; tempfail rebaixa; fatal prevalece sobre tempfail
      "run_step bash -c 'exit 0'",
      "run_step bash -c 'exit 75'",
      "run_step bash -c 'exit 1'",
      "run_step bash -c 'exit 75'",
      'echo "C2=$EXIT_CODE"',
      // cenário 3: só sucesso
      "EXIT_CODE=0",
      "run_step bash -c 'exit 0'",
      'echo "C3=$EXIT_CODE"',
    ].join("\n");
    const harnessPath = path.join(makeTmp("dreams05_harness_"), "harness.sh");
    fs.writeFileSync(harnessPath, harness, { mode: 0o755 });

    const r = Bun.spawnSync(["bash", harnessPath], { env: OFFLINE_ENV, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(out).toContain("C1=75");
    expect(out).toContain("C2=1");
    expect(out).toContain("C3=0");
  });
});

// ---------------------------------------------------------------------------
// Recorder multiline — integridade (argv delimitado por NUL, nunca por \n)
// ---------------------------------------------------------------------------
describe("[recorder] deserialização robusta de argv multi-linha", () => {
  test("tests/dreams.test.ts usa delimitador NUL (printf '%s\\0' + split(\"\\0\"))", () => {
    const content = fs.readFileSync(DREAMS_TEST, "utf8");
    // Gravação NUL-delimitada do argv real do transporte.
    expect(content).toContain("printf '%s\\\\0' \"$@\"");
    // Deserialização correspondente por NUL — não por quebra de linha.
    expect(content).toContain('split("\\0")');
  });

  test("round-trip real: argumento com newlines embutidos é reconstruído por NUL", () => {
    const dir = makeTmp("dreams05_rec_");
    const rec = path.join(dir, "rec.sh");
    const argvLog = path.join(dir, "argv.log");
    fs.writeFileSync(rec, ["#!/usr/bin/env bash", `printf '%s\\0' "$@" > "${argvLog}"`].join("\n"), {
      mode: 0o755,
    });

    const args = ["run", "--model", "opencode/x", "--title", "linha A\nlinha B\nlinha C", "--dir", "/tmp"];
    const r = Bun.spawnSync([rec, ...args], { env: OFFLINE_ENV, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);

    const got = fs.readFileSync(argvLog, "utf8").split("\0").filter((s) => s.length > 0);
    // Reconstrução exata: o argumento multilinha sobrevive intacto (um split por
    // "\n" o partiria em 3, provando que o delimitador NUL é necessário).
    expect(got).toEqual(args);
    expect(got.filter((a) => a.includes("\n"))).toHaveLength(1);
  });
});
