/**
 * TICKET-DREAMS-02 (Portão 2 — C5) — INTEGRIDADE DO LOCKFILE:
 * prova de NÃO-TRUNCAGEM e de rejeição de alias (hard link).
 *
 * Suíte determinística SDET — ZERO mocks: o script bash REAL é executado em
 * subprocesso real; quando o caso exige /tmp privado, um sandbox bwrap real
 * (tmpfs em /tmp) é usado. Nenhum stub, fake ou mock de comportamento.
 *
 * O que estas regressões provam (e as mutações que devem quebrá-las):
 *
 *   R1  Lockfile REGULAR pré-plantado com conteúdo conhecido ⇒ após o ciclo o
 *       conteúdo está INTACTO. É a prova da abertura READ-ONLY (C2):
 *       mutação `exec {FD}>` ⇒ QUEBRA (o `>` trunca o alvo).
 *
 *   R1b Lockfile SYMLINK pré-plantado apontando para um arquivo da vítima ⇒ o
 *       arquivo da vítima fica INTACTO. É a forma real do ataque (o path do
 *       lock é um link para um path arbitrário).
 *
 *   R2  Lockfile HARD LINK pré-plantado (nlink == 2) ⇒ o path NÃO pode ser
 *       aberto pelo script, o arquivo da vítima fica INTACTO e o log registra
 *       a degradação para o diretório privado. Mutação "remover a regra nlink"
 *       ⇒ QUEBRA (o guard aceitaria o alias e o TIER 3 seria usado).
 *
 *   R3  A camada pós-abertura (`verify_lock_fd_target`): o fd adquirido tem de
 *       apontar para o path reivindicado e o alvo não pode ter alias. Testada
 *       por EXTRAÇÃO da função do PRÓPRIO script (mesmo padrão já usado pela
 *       suíte 5B para `track_exit`/`run_step`), o que torna o comportamento
 *       observável de forma determinística, sem corrida e sem hook de teste
 *       em produção.
 *
 * Nota de escopo: o caso "sem /proc" (branch NÃO VERIFICÁVEL) é exercitado
 * sobre uma CÓPIA da função com patch mecânico de UMA linha, com asserção
 * por diff de que a cópia difere do original APENAS nessa linha — sem
 * variável de produção nova e sem mock de comportamento.
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "bin", "dreams-consolidate.sh");
const UID = typeof process.getuid === "function" ? process.getuid() : 1000;

const tempDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** HOME isolado (o CLI do plugin não existe nele ⇒ o script sai com 1). */
function makeHome(): string {
  return makeTmp("dreams02b_home_");
}

/**
 * Executa o wrapper REAL com HOME isolado e um DREAMS_LOCK_FILE explícito.
 * Sem bwrap: o path do lock fica dentro do HOME isolado, observável de fora.
 */
function runWithExplicitLock(home: string, lockFile: string): { status: number; log: string } {
  const missingCli = path.join(home, "inexistente", "cli.ts");
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      DREAMS_OFFLINE: "1",
      DREAMS_CLI_PATH: missingCli,
      DREAMS_LOCK_FILE: lockFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logPath = path.join(home, ".local", "state", "agent-dreams.log");
  return {
    status: result.exitCode,
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
  };
}

/**
 * Executa o wrapper REAL dentro de um sandbox bwrap com /tmp PRIVADO.
 * `pre` roda antes do script, `post` roda DEPOIS (mesmo namespace) — é o que
 * permite observar, de fora, o estado de arquivos que existem só dentro do
 * tmpfs do sandbox (ex.: a vítima de um hard link).
 */
function runInSandbox(options: {
  home: string;
  env?: Record<string, string>;
  pre?: string[];
  post?: string[];
}): { status: number; log: string } {
  const bwrap = Bun.which("bwrap");
  if (!bwrap) throw new Error("bwrap indisponível");

  const scriptDir = path.join(options.home, "script");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scriptDir, "dreams-consolidate.sh"));
  fs.chmodSync(path.join(scriptDir, "dreams-consolidate.sh"), 0o755);

  const inner = [
    ...(options.pre ?? []),
    "bash /tmp/script/dreams-consolidate.sh",
    "SCRIPT_RC=$?",
    ...(options.post ?? []),
    // O status do SCRIPT é propagado (o exit code do sandbox é o do último
    // comando da cadeia — sem isto, os passos de observação mascarariam o
    // status real do wrapper).
    "exit $SCRIPT_RC",
  ].join("\n");

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
      options.home,
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
      inner,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const logPath = path.join(options.home, ".local", "state", "agent-dreams.log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  if (result.exitCode !== 0 && log === "") {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`sandbox falhou (exit=${result.exitCode}): ${stderr.slice(0, 400)}`);
  }
  return { status: result.exitCode, log };
}

// ===========================================================================
// C5 / R1 — o lockfile NÃO pode ser truncado (abertura READ-ONLY, C2)
// ===========================================================================
describe("[DREAMS-02/C5] lockfile: integridade do alvo (sem truncagem)", () => {
  test("R1: lockfile REGULAR pré-plantado ⇒ conteúdo INTACTO após o ciclo", () => {
    const home = makeHome();
    const lockFile = path.join(home, "explicit.lock");
    const SENTINEL = "CONTEUDO-SENTINELA-DO-LOCKFILE\n";
    fs.writeFileSync(lockFile, SENTINEL, "utf8");

    const { status } = runWithExplicitLock(home, lockFile);

    expect(status).toBe(1); // CLI ausente ⇒ falha fatal (o lock foi adquirido)
    // A prova: o conteúdo NÃO foi truncado. Com `exec {FD}>` (mutação) o
    // arquivo seria zerado por O_TRUNC ⇒ esta asserção QUEBRA.
    expect(fs.readFileSync(lockFile, "utf8")).toBe(SENTINEL);
  });

  test("R1b: lockfile SYMLINK pré-plantado ⇒ o arquivo da VÍTIMA fica intacto", () => {
    const home = makeHome();
    const victim = path.join(home, "vitima.txt");
    const lockFile = path.join(home, "explicit.lock");
    const SECRET = "DADOS IMPORTANTES DO USUARIO\n";
    fs.writeFileSync(victim, SECRET, "utf8");
    fs.symlinkSync(victim, lockFile);

    const { status } = runWithExplicitLock(home, lockFile);

    expect(status).toBe(1);
    // O path do lock é um link para um path arbitrário: o alvo pode ser
    // ABERTO (read-only), nunca TRUNCADO.
    expect(fs.readFileSync(victim, "utf8")).toBe(SECRET);
  });
});

// ===========================================================================
// C5 / R2 — alias por HARD LINK é rejeitado antes de qualquer abertura
// ===========================================================================
describe("[DREAMS-02/C5] lockfile: rejeição de alias por hard link", () => {
  test("R2: hard link pré-plantado no alvo do TIER 3 ⇒ vítima intacta + degrade p/ home privado", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      console.warn("[skip] bwrap indisponível — teste de hard link ignorado");
      expect(true).toBe(true);
      return;
    }
    const home = makeHome();
    const missingRuntime = path.join(home, "runtime-inexistente");

    const { status, log } = runInSandbox({
      home,
      env: { XDG_RUNTIME_DIR: missingRuntime },
      pre: [
        // A vítima precisa estar NO MESMO filesystem do alvo (tmpfs do sandbox):
        // `ln` entre filesystems distintos falha com EXDEV e daria um falso
        // "não replicado".
        `printf 'DADOS IMPORTANTES DO USUARIO\\n' > /tmp/vitima.txt`,
        `ln /tmp/vitima.txt /tmp/agent-dreams-${UID}.lock`,
        // Comprovação da pré-condição: é um hard link (nlink=2) de verdade.
        `stat -c '%h %i' /tmp/vitima.txt > /tmp/sandbox-home/estado.txt`,
        `stat -c '%h %i' /tmp/agent-dreams-${UID}.lock >> /tmp/sandbox-home/estado.txt`,
      ],
      post: [
        // Estado da vítima DEPOIS do ciclo, observed de fora via sandbox home.
        `printf 'CONTEUDO=' > /tmp/sandbox-home/vitima-pos.txt`,
        `cat /tmp/vitima.txt >> /tmp/sandbox-home/vitima-pos.txt`,
      ],
    });

    expect(status).toBe(1);
    // Pré-condição realmente estabelecida: nlink == 2 nos dois paths.
    const estado = fs.readFileSync(path.join(home, "estado.txt"), "utf8").trim().split("\n");
    expect(estado[0]).toBe(estado[1]); // mesmo inode
    expect(estado[0]!.trim().split(" ")[0]).toBe("2"); // nlink == 2
    // A vítima NÃO foi truncada (nada foi aberto em modo write).
    const vitimaPos = fs.readFileSync(path.join(home, "vitima-pos.txt"), "utf8");
    expect(vitimaPos).toBe("CONTEUDO=DADOS IMPORTANTES DO USUARIO\n");
    // O path com alias NÃO foi usado como lockfile: degradou para o privado.
    expect(log).toContain("Lockfile resolvido: /tmp/sandbox-home/.local/state/agent-dreams.lock");
    expect(log).not.toContain(`Lockfile resolvido: /tmp/agent-dreams-${UID}.lock`);
    // E o motivo da degradação é explícito (grep estável).
    expect(log).toContain("motivo=alias-hardlink");
  });

  test("R2b: hard link com DOIS aliases (nlink=3) ⇒ rejeitado (regra relaxada não passa raspando)", () => {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) {
      console.warn("[skip] bwrap indisponível — teste de nlink=3 ignorado");
      expect(true).toBe(true);
      return;
    }
    const home = makeHome();
    const missingRuntime = path.join(home, "runtime-inexistente");

    const { status, log } = runInSandbox({
      home,
      env: { XDG_RUNTIME_DIR: missingRuntime },
      pre: [
        `printf 'DADOS IMPORTANTES DO USUARIO\\n' > /tmp/vitima.txt`,
        // DOIS aliases do mesmo inode => nlink == 3 (vitima + alias1 + lock).
        // Uma regra relaxada que rejeitasse apenas nlink==2 aceitaria este
        // caso e o path COM ALIAS viraria o lockfile ⇒ a mutação morre aqui.
        `ln /tmp/vitima.txt /tmp/alias1.lock`,
        `ln /tmp/vitima.txt /tmp/agent-dreams-${UID}.lock`,
        `stat -c '%h' /tmp/vitima.txt > /tmp/sandbox-home/nlink.txt`,
      ],
      post: [`cat /tmp/vitima.txt > /tmp/sandbox-home/vitima-pos.txt`],
    });

    expect(status).toBe(1);
    // Pré-condição: nlink == 3 (dois aliases).
    expect(fs.readFileSync(path.join(home, "nlink.txt"), "utf8").trim()).toBe("3");
    // A vítima não foi tocada.
    expect(fs.readFileSync(path.join(home, "vitima-pos.txt"), "utf8")).toBe("DADOS IMPORTANTES DO USUARIO\n");
    // O path com alias NÃO foi usado: degradou para o diretório privado.
    expect(log).toContain("Lockfile resolvido: /tmp/sandbox-home/.local/state/agent-dreams.lock");
    expect(log).not.toContain(`Lockfile resolvido: /tmp/agent-dreams-${UID}.lock`);
    expect(log).toContain("motivo=alias-hardlink(nlink=3)");
  });
});

// ===========================================================================
// C5 / R4 — o lockfile precisa ser ABRIVEL: diagnóstico explícito
// ===========================================================================
describe("[DREAMS-02/C5] lockfile: legibilidade e diagnóstico", () => {
  test("R4: lockfile legítimo porém ILEGÍVEL ⇒ abort com diagnóstico claro (não dies sujo do set -e)", () => {
    // Requer um usuário NÃO-root: como root, o modo 000 não impede a leitura.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.warn("[skip] rodando como root — chmod 000 não impede leitura");
      expect(true).toBe(true);
      return;
    }
    const home = makeHome();
    const lockFile = path.join(home, "ilegivel.lock");
    fs.writeFileSync(lockFile, "CONTEUDO\n", "utf8");
    fs.chmodSync(lockFile, 0o000);

    const { status, log } = runWithExplicitLock(home, lockFile);

    // Sem o pré-flight, o `exec {LOCK_FD}<` morre com o erro cru do shell.
    // Com ele, o abort é explícito e o motivo é acionável.
    expect(status).toBe(1);
    expect(log).toContain("não pôde ser aberto para leitura");
    expect(log).toContain("Abortando SEM escrever");

    fs.chmodSync(lockFile, 0o600); // restaura para a limpeza do tempdir
  });
});

// ===========================================================================
// C5 / R3 — camada pós-abertura (verify_lock_fd_target)
// ===========================================================================
/** Extrai uma função do PRÓPRIO script (mesmo padrão da suíte 5B). */
function extractFunction(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`função ${name}() não encontrada no script`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`fecha-chaves de ${name}() não encontrado`);
}

/**
 * Monta um harness que executa a função EXTRAÍDA do script real.
 * `patch` (opcional) é um patch MECÂNICO de uma linha aplicado à cópia.
 */
function buildHarness(fnSource: string, patch?: (src: string) => string): string {
  const fn = patch ? patch(fnSource) : fnSource;
  return [
    "#!/usr/bin/env bash",
    "set -u",
    fn,
    'DIR="$(mktemp -d)"',
    'printf "BENIGNO\\n" > "$DIR/alvo.txt"',
    'printf "OUTRO\\n" > "$DIR/outro.txt"',
    // O alias nasce de um arquivo SEPARADO: se viesse do alvo, o nlink do
    // alvo subiria para 2 e o caso benigno viraria alias (falso positivo).
    'printf "ALVO\\n" > "$DIR/alias-alvo.txt"',
    'ln "$DIR/alias-alvo.txt" "$DIR/alias.txt"',
    'mkdir -p "$DIR/real"',
    'ln -s "$DIR/real" "$DIR/link"',
    'printf "ANCESTRAL\\n" > "$DIR/real/ancestral.lock"',
    "",
    "# --- caso 1: benigno (fd no path esperado) ---",
    'exec {FD}<"$DIR/alvo.txt"',
    'verify_lock_fd_target "$FD" "$DIR/alvo.txt"; echo "BENIGNO=$?"',
    'exec {FD}>&-',
    "",
    "# --- caso 2: divergência (fd aponta para outro path) ---",
    'exec {FD}<"$DIR/outro.txt"',
    'verify_lock_fd_target "$FD" "$DIR/alvo.txt"; echo "DIVERGENCIA=$?"',
    'exec {FD}>&-',
    "",
    "# --- caso 3: alias (nlink > 1 no alvo do fd) ---",
    'exec {FD}<"$DIR/alias.txt"',
    'verify_lock_fd_target "$FD" "$DIR/alias.txt"; echo "ALIAS=$?"',
    'exec {FD}>&-',
    "",
    "# --- caso 4: ancestral symlinkado NÃO pode ser falso positivo ---",
    'exec {FD}<"$DIR/real/ancestral.lock"',
    'verify_lock_fd_target "$FD" "$DIR/link/ancestral.lock"; echo "ANCESTRAL=$?"',
    'exec {FD}>&-',
    'rm -rf "$DIR"',
  ].join("\n");
}

function runHarness(src: string): Record<string, string> {
  const harnessPath = path.join(makeTmp("dreams02b_harness_"), "harness.sh");
  fs.writeFileSync(harnessPath, src, { mode: 0o755 });
  const result = Bun.spawnSync(["bash", harnessPath], { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(result.stdout);
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return map;
}

describe("[DREAMS-02/C5] camada pós-abertura: verify_lock_fd_target", () => {
  test("R3: benigno ⇒ 0; divergência ⇒ 1; alias(nlink=2) ⇒ 1; ancestral symlinkado ⇒ 0 (sem falso positivo)", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const fn = extractFunction(src, "verify_lock_fd_target");
    const res = runHarness(buildHarness(fn));

    expect(res.BENIGNO).toBe("0");
    expect(res.DIVERGENCIA).toBe("1");
    expect(res.ALIAS).toBe("1");
    // Ancestral symlinkado: com `cd -P`/`pwd -P` (físico) não há divergência
    // ⇒ o falso positivo que abortaria o consolidador não existe.
    expect(res.ANCESTRAL).toBe("0");
  });

  test("R3: branch NÃO VERIFICÁVEL (sem /proc) ⇒ 2 (pula, nunca aborta) — cópia patcheada em 1 linha", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const fn = extractFunction(src, "verify_lock_fd_target");

    // Patch MECÂNICO de UMA linha: o path do /proc passa a não existir.
    const patched = fn.replace("/proc/self/fd/", "/proc-inexistente/self/fd/");
    // Asserção de escopo: a cópia difere do original APENAS naquela linha.
    const originalLines = fn.split("\n");
    const patchedLines = patched.split("\n");
    expect(patchedLines.length).toBe(originalLines.length);
    const changed = patchedLines.filter((l, i) => l !== originalLines[i]);
    expect(changed.length).toBe(1);
    expect(changed[0]).toContain("/proc-inexistente/self/fd/");

    const res = runHarness(buildHarness(patched));
    // Sem /proc, NENHUM caso pode ser verificado ⇒ todos devolvem 2 (pular),
    // inclusive o benigno: o caller deve PULAR com warning, nunca abortar.
    expect(res.BENIGNO).toBe("2");
    expect(res.DIVERGENCIA).toBe("2");
    expect(res.ALIAS).toBe("2");
    expect(res.ANCESTRAL).toBe("2");
  });
});
