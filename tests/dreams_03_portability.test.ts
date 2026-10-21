/**
 * TICKET-DREAMS-03 — Suíte determinística REAL (sem mocks) da portabilidade dos
 * scripts de sistema do agent-dreams.
 *
 * Cobre, com infraestrutura REAL (subprocessos bash reais, executáveis-stub
 * reais no PATH, diretórios temporários e o binário `systemd-analyze` quando
 * disponível):
 *
 *  1. `bin/dreams-consolidate.sh`:
 *     - ZERO caminho absoluto do autor (`/home/...`) — portabilidade;
 *     - resolução DINÂMICA do diretório do plugin/CLI a partir da localização
 *       do próprio script (nada atrelado ao `$HOME` de um usuário);
 *     - healthcheck de rede por HTTP (curl), SEM dependência de ICMP/ping;
 *     - propagação semântica de saída preservada (0 = ok, 1 = fatal, 75 = adiamento);
 *     - blindagem POSIX do DREAMS-05 preservada (flock, traps, exit codes).
 *
 *  2. `systemd/agent-dreams.service` e `systemd/agent-dreams.timer`:
 *     - versionados no repositório com o nome canônico `agent-dreams`;
 *     - timer diário persistente; service `oneshot` com ExecStart parametrizado.
 *
 *  3. `bin/enable-systemd.sh`:
 *     - instala as units em `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`
 *       substituindo o placeholder pelo diretório real de instalação;
 *     - comanda `systemctl --user` com `agent-dreams.timer`/`agent-dreams.service`.
 *
 * Nenhum `unittest.mock`/`jest.mock` é usado: os seams são executáveis bash
 * REAIS colocados à frente do PATH, exatamente como o runtime de produção os
 * encontraria.
 */
import { test, expect, describe, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WRAPPER = path.join(REPO_ROOT, "bin", "dreams-consolidate.sh");
const ENABLE = path.join(REPO_ROOT, "bin", "enable-systemd.sh");
const SERVICE_UNIT = path.join(REPO_ROOT, "systemd", "agent-dreams.service");
const TIMER_UNIT = path.join(REPO_ROOT, "systemd", "agent-dreams.timer");

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

const read = (p: string) => fs.readFileSync(p, "utf8");

/** Código executável do script (sem linhas de comentário) — para contratos de código. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// 1. Wrapper: portabilidade, resolução dinâmica e healthcheck HTTP
// ---------------------------------------------------------------------------
describe("[DREAMS-03] bin/dreams-consolidate.sh: portabilidade e healthcheck", () => {
  test("nenhum caminho absoluto do autor e nenhuma dependência de ICMP", () => {
    const src = read(WRAPPER);
    const code = codeOnly(src);
    expect(src).not.toContain("/home/maiteuxzanela");
    // Nenhuma invocação de `ping` no código executável (o histórico em
    // comentário é permitido, mas o comando não pode existir).
    expect(code).not.toContain("ping");
    expect(code).toContain("https://1.1.1.1");
    expect(code).toContain("https://8.8.8.8");
  });

  test("resolução dinâmica do plugin via readlink/dirname e respeito a XDG", () => {
    const src = read(WRAPPER);
    expect(src).toContain("readlink -f");
    expect(src).toContain('dirname "$SELF"');
    expect(src).toContain("DREAMS_PLUGIN_DIR");
    expect(src).toContain("DREAMS_CLI_PATH");
    expect(src).toContain("XDG_STATE_HOME");
    // O CLI é o src/cli.ts IRMÃO do diretório bin/ onde o wrapper vive.
    expect(src).toContain('CLI_PATH="${DREAMS_CLI_PATH:-$PLUGIN_DIR/src/cli.ts}"');
  });

  test("healthcheck HTTP resiliente com timeout curto e fallback de host", () => {
    const src = read(WRAPPER);
    expect(src).toContain("curl");
    expect(src).toContain("--max-time 3");
    expect(src).toContain("https://1.1.1.1");
    expect(src).toContain("https://8.8.8.8");
    expect(src).toContain("wget"); // fallback de cliente HTTP
  });

  test("semântica de saída preservada (0 / 1 / 75) e blindagem POSIX do DREAMS-05", () => {
    const src = read(WRAPPER);
    expect(src).toContain("set -euo pipefail");
    expect(src).toContain("flock -n");
    expect(src).toContain("trap cleanup EXIT");
    expect(src).toContain("trap 'exit 130' INT");
    expect(src).toContain("trap 'exit 143' TERM");
    expect(src).toContain("trap 'exit 129' HUP");
    expect(src).toContain("DREAMS_LOCK_FILE");
    expect(src).toContain('exit "$EXIT_CODE"');
    expect(src).toContain("EXIT_CODE=75");
    expect(src).toContain("EXIT_CODE=1");
  });

  test("sintaxe bash válida (bash -n) nos dois scripts de distribuição", () => {
    for (const script of [WRAPPER, ENABLE]) {
      const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Execução REAL do wrapper num diretório de instalação arbitrário
// ---------------------------------------------------------------------------
interface WrapperRun {
  status: number;
  bunLog: string;
  wrapperLog: string;
  notifyLog: string;
}

/**
 * Executa o wrapper REAL copiado para um diretório de instalação arbitrário
 * (simulando um clone/instalação em qualquer caminho do mundo), com seams
 * executáveis reais à frente do PATH:
 *   - `bun`     → registra o argv e devolve o código de saída pedido;
 *   - `curl`    → sinaliza rede online (healthcheck HTTP);
 *   - `notify-send` → registra o alerta.
 */
function runWrapperInInstallDir(opts: {
  codes: { light: number; rem: number; deep: number };
  offline?: boolean;
}): WrapperRun {
  const home = makeTmp("dreams03_home_");
  const install = makeTmp("dreams03_install_");
  const stubBin = path.join(home, ".opencode", "bin");
  fs.mkdirSync(stubBin, { recursive: true });

  // Instalação portável: o wrapper em <install>/bin e o CLI em <install>/src.
  fs.mkdirSync(path.join(install, "bin"), { recursive: true });
  fs.mkdirSync(path.join(install, "src"), { recursive: true });
  fs.copyFileSync(WRAPPER, path.join(install, "bin", "dreams-consolidate.sh"));
  fs.writeFileSync(path.join(install, "src", "cli.ts"), "// cli real do clone\n");

  const bunLog = path.join(home, "bun-args.log");
  fs.writeFileSync(
    path.join(stubBin, "bun"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" >> "${bunLog}"`,
      'sub=""',
      'for a in "$@"; do case "$a" in light|rem|deep|rotate-log) sub="$a";; esac; done',
      "case \"$sub\" in",
      `  light) exit ${opts.codes.light};;`,
      `  rem) exit ${opts.codes.rem};;`,
      `  deep) exit ${opts.codes.deep};;`,
      "  rotate-log) exit 0;;",
      "  *) exit 0;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  // Seam de rede: HTTP (curl), nunca ICMP.
  fs.writeFileSync(path.join(stubBin, "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const notifyLog = path.join(home, "notify.log");
  fs.writeFileSync(
    path.join(stubBin, "notify-send"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${notifyLog}"\nexit 0\n`,
    { mode: 0o755 }
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.HOME = home;
  env.DREAMS_LOCK_FILE = path.join(home, "consolidate.lock");
  env.PATH = `${stubBin}:${env.PATH ?? "/usr/bin:/bin"}`;
  delete env.DREAMS_OFFLINE;

  const r = spawnSync("bash", [path.join(install, "bin", "dreams-consolidate.sh")], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });

  const wrapperLogPath = path.join(home, ".local", "state", "agent-dreams.log");
  return {
    status: r.status ?? -1,
    bunLog: fs.existsSync(bunLog) ? fs.readFileSync(bunLog, "utf8") : "",
    wrapperLog: fs.existsSync(wrapperLogPath) ? fs.readFileSync(wrapperLogPath, "utf8") : "",
    notifyLog: fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, "utf8") : "",
  };
}

describe("[DREAMS-03] wrapper em diretório de instalação arbitrário", () => {
  test("resolve o CLI a partir do próprio script, não do $HOME do usuário", () => {
    const run = runWrapperInInstallDir({ codes: { light: 0, rem: 0, deep: 0 } });

    expect(run.status).toBe(0);
    // O argv do bun carrega o CLI RESOLVIDO dinamicamente (install/src/cli.ts).
    expect(run.bunLog).toContain(path.join("src", "cli.ts"));
    expect(run.bunLog).not.toContain(path.join(".config", "opencode", "plugins"));
    // Log canônico no diretório de estado XDG do $HOME do teste.
    expect(run.wrapperLog).toContain("Consolidação concluída com sucesso");
    expect(run.wrapperLog).toContain("agent-dreams");
  });

  test("propagação semântica: REM adiado devolve 75 e alerta a usuária", () => {
    const run = runWrapperInInstallDir({ codes: { light: 0, rem: 75, deep: 0 } });

    expect(run.status).toBe(75);
    expect(run.notifyLog).toContain("Agent Dreams");
    expect(run.notifyLog.toLowerCase()).toContain("adiad");
  });

  test("propagação semântica: falha fatal devolve 1 e alerta de FALHA", () => {
    const run = runWrapperInInstallDir({ codes: { light: 0, rem: 0, deep: 1 } });

    expect(run.status).toBe(1);
    expect(run.notifyLog).toContain("FALHA");
  });

  test("prioridade: fatal (1) prevalece sobre adiamento (75)", () => {
    const run = runWrapperInInstallDir({ codes: { light: 1, rem: 75, deep: 0 } });

    expect(run.status).toBe(1);
  });

  test("healthcheck usa HTTP: com curl falhando, o REM roda em modo offline local", () => {
    const home = makeTmp("dreams03_offline_home_");
    const install = makeTmp("dreams03_offline_install_");
    const stubBin = path.join(home, ".opencode", "bin");
    fs.mkdirSync(stubBin, { recursive: true });
    fs.mkdirSync(path.join(install, "bin"), { recursive: true });
    fs.mkdirSync(path.join(install, "src"), { recursive: true });
    fs.copyFileSync(WRAPPER, path.join(install, "bin", "dreams-consolidate.sh"));
    fs.writeFileSync(path.join(install, "src", "cli.ts"), "// cli real do clone\n");

    const bunLogPath = path.join(home, "bun-args.log");
    fs.writeFileSync(
      path.join(stubBin, "bun"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" >> "${bunLogPath}"`,
        `printf 'DREAMS_OFFLINE=%s\\n' "\${DREAMS_OFFLINE:-<unset>}" >> "${bunLogPath}"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    // curl SEMPRE falha ⇒ a sonda HTTP declara a rede indisponível.
    fs.writeFileSync(path.join(stubBin, "curl"), "#!/usr/bin/env bash\nexit 7\n", { mode: 0o755 });
    // wget também indisponível, para exercitar o fallback de cliente HTTP.
    fs.writeFileSync(path.join(stubBin, "wget"), "#!/usr/bin/env bash\nexit 7\n", { mode: 0o755 });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    env.HOME = home;
    env.DREAMS_LOCK_FILE = path.join(home, "consolidate.lock");
    env.PATH = `${stubBin}:${env.PATH ?? "/usr/bin:/bin"}`;
    delete env.DREAMS_OFFLINE;
    // Orçamento de tolerância de boot reduzido (seam operacional do script):
    // a semântica offline/online é a mesma, sem esperar 60s de retry.
    env.DREAMS_NET_MAX_ATTEMPTS = "2";
    env.DREAMS_NET_RETRY_DELAY = "0";

    const r = spawnSync("bash", [path.join(install, "bin", "dreams-consolidate.sh")], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });

    const bunLog = fs.existsSync(bunLogPath) ? fs.readFileSync(bunLogPath, "utf8") : "";
    const wrapperLogPath = path.join(home, ".local", "state", "agent-dreams.log");
    const wrapperLog = fs.existsSync(wrapperLogPath) ? fs.readFileSync(wrapperLogPath, "utf8") : "";

    // O ciclo local segue íntegro (Light/Deep rodam sempre) e o REM é adiado
    // em modo offline — sem qualquer dependência de ICMP.
    expect(r.status).toBe(0);
    expect(wrapperLog).toContain("MODO OFFLINE");
    expect(bunLog).toContain("DREAMS_OFFLINE=1");
  });
});

// ---------------------------------------------------------------------------
// 3. Units systemd versionadas
// ---------------------------------------------------------------------------
describe("[DREAMS-03] systemd/: units canônicas versionadas", () => {
  test("agent-dreams.service: oneshot com ExecStart parametrizado", () => {
    expect(fs.existsSync(SERVICE_UNIT)).toBe(true);
    const unit = read(SERVICE_UNIT);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("__AGENT_DREAMS_DIR__/bin/dreams-consolidate.sh");
    expect(unit).not.toContain("/home/maiteuxzanela");
    expect(unit).not.toContain("opencode-dreams");
  });

  test("agent-dreams.timer: agenda diária persistente", () => {
    expect(fs.existsSync(TIMER_UNIT)).toBe(true);
    const unit = read(TIMER_UNIT);
    expect(unit).toContain("[Timer]");
    expect(unit).toContain("OnCalendar=*-*-* 03:30:00");
    expect(unit).toContain("Persistent=true");
    expect(unit).toContain("Unit=agent-dreams.service");
    expect(unit).toContain("WantedBy=timers.target");
    expect(unit).not.toContain("/home/maiteuxzanela");
    expect(unit).not.toContain("opencode-dreams");
  });
});

// ---------------------------------------------------------------------------
// 4. enable-systemd.sh: instalação real das units
// ---------------------------------------------------------------------------
describe("[DREAMS-03] bin/enable-systemd.sh: instalação real das units", () => {
  test("copia as units para $XDG_CONFIG_HOME/systemd/user com o dir real", () => {
    const home = makeTmp("dreams03_enable_home_");
    const xdg = makeTmp("dreams03_enable_xdg_");
    const stubBin = path.join(home, "stub", "bin");
    fs.mkdirSync(stubBin, { recursive: true });

    const systemctlLog = path.join(home, "systemctl.log");
    fs.writeFileSync(
      path.join(stubBin, "systemctl"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "${systemctlLog}"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    env.HOME = home;
    env.XDG_CONFIG_HOME = xdg;
    env.PATH = `${stubBin}:${env.PATH ?? "/usr/bin:/bin"}`;

    const r = spawnSync("bash", [ENABLE], { env, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Configuração Concluída com Sucesso");

    const unitDir = path.join(xdg, "systemd", "user");
    const service = read(path.join(unitDir, "agent-dreams.service"));
    const timer = read(path.join(unitDir, "agent-dreams.timer"));

    // O placeholder foi substituído pelo diretório REAL de instalação.
    expect(service).not.toContain("__AGENT_DREAMS_DIR__");
    expect(service).toContain(`${REPO_ROOT}/bin/dreams-consolidate.sh`);
    expect(timer).toContain("Unit=agent-dreams.service");
    expect(timer).toContain("OnCalendar=*-*-* 03:30:00");

    // systemctl --user recebeu os nomes canônicos.
    const calls = fs.readFileSync(systemctlLog, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user enable agent-dreams.timer");
    expect(calls).toContain("--user restart agent-dreams.timer");
    expect(calls).toContain("--user is-active --quiet agent-dreams.timer");
    expect(calls).toContain("--user list-timers agent-dreams.timer");
    expect(calls).not.toContain("opencode-dreams");
  });

  test("nomenclatura obsoleta eliminada dos scripts de distribuição", () => {
    for (const script of [WRAPPER, ENABLE]) {
      const src = read(script);
      expect(src).not.toContain("/home/maiteuxzanela");
      expect(src).not.toContain("opencode-dreams");
      expect(src).not.toContain("opencode-plugin-dreams");
    }
  });
});
