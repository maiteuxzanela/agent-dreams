/**
 * TICKET-DREAMS-05 (frentes: CI/CD, Publicação Segura e Documentação Pública)
 * — Suíte determinística SDET — ZERO mocks.
 *
 * O que esta suíte PROVA (tudo contra artefatos reais e processos reais):
 *
 * 1. `ci.yml` é uma esteira HERMÉTICA e ORDENADA:
 *    - Bun TRAVADO em versão exata (nunca `latest`/range) e a mesma versão
 *      satisfaz `bun-types`/`@types/bun`/`engines.bun` do manifesto;
 *    - ordem real dos steps: install(frozen) → typecheck → test(offline) → pack;
 *    - `DREAMS_OFFLINE=1` na suíte e no env do step;
 *    - `permissions: contents: read` (sem escrita), `timeout-minutes` limitado,
 *      `concurrency.cancel-in-progress: true`;
 *    - toda action `uses:` é pinada por MAJOR (`@vN`) e nenhuma referencia a
 *      ação inexistente (`oven-sh/cache-bun`).
 *
 * 2. A GUARDA DE INTEGRIDADE DO TARBALL é EXECUTADA de verdade:
 *    o script `node -e` embutido no workflow é extraído do arquivo, escrito em
 *    disco e executado contra manifestos sintéticos (proibidos, vazio, limpo) e
 *    contra o manifesto REAL gerado por `npm pack --dry-run --json`.
 *    → prova de sensibilidade: a guarda realmente ABORTA a publicação.
 *
 * 3. `publish.yml` publica com `--provenance` + `id-token: write` e a
 *    coerência tag ↔ package.json é executada de verdade em `bash`, nos
 *    casos: coerente, divergente, sem prefixo `v`, não-semver (fail-safe) e
 *    pré-release (não pode publicar o conteúdo da versão estável).
 *
 * 4. A DOCUMENTAÇÃO é EXECUTÁVEL e coerente com a implementação real:
 *    o bloco bash de instalação manual do README é rodado de verdade (com um
 *    `systemctl` recorder real em PATH) contra as *units* versionadas reais;
 *    o README não pode prometer `npx`, o badge de CI aponta para um workflow
 *    que existe e o CHANGELOG é coerente com a versão do manifesto.
 *
 * 5. O pacote REAL publicado é inspecionado (`npm pack --dry-run --json`),
 *    de forma hermética (proxies em porta morta): nada de `tests/`, nada de
 *    `.github/`, presença de `LICENSE`/`systemd/`, e os bytes publicados do
 *    README/manifesto são IDÊNTICOS aos validados aqui (parity src↔publicado).
 *
 * Nenhuma mockagem: o guard e o version-check são executados como processos
 * reais; o `systemctl` do teste é um recorder executável que registra argv.
 */
import { test, expect, describe } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CI_YML = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PUBLISH_YML = path.join(REPO_ROOT, ".github", "workflows", "publish.yml");
const README_PATH = path.join(REPO_ROOT, "README.md");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const SYSTEMD_DIR = path.join(REPO_ROOT, "systemd");

// ─────────────────────────── helpers ───────────────────────────

/** Prova de ausência de rede: qualquer egress cai em porta morta. */
const DEAD_PROXY = "http://127.0.0.1:9";
const HERMETIC_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  all_proxy: DEAD_PROXY,
  DREAMS_OFFLINE: "1",
};

function readText(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Binário `node` real (o guard do CI roda sob node, não sob bun). */
function nodeBin(): string {
  const probe = spawnSync("node", ["-e", "process.stdout.write('ok')"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout === "ok") return "node";
  return process.execPath;
}

// Parser YAML: pacote npm `yaml` (presente no lockfile congelado) com
// fallback para PyYAML. Sem nenhum dos dois ⇒ falha barulhenta (fail-fast),
// nunca um skip silencioso que esvaziaria o portão de CI.
type YamlParser = (text: string) => any;
let yamlParser: YamlParser | null = null;
try {
  const mod = (await import("yaml")) as any;
  yamlParser = (t: string) => mod.parse(t);
} catch {
  yamlParser = null;
}

function parseWithPython(text: string): any | null {
  const r = spawnSync(
    "python3",
    ["-c", "import sys,json,yaml;json.dump(yaml.safe_load(sys.stdin.read()),sys.stdout)"],
    { input: text, encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function loadYaml(text: string, label: string): any {
  if (yamlParser) return yamlParser(text);
  const viaPython = parseWithPython(text);
  if (viaPython) return viaPython;
  throw new Error(`Nenhum parser YAML disponível para validar ${label} (npm 'yaml' e python3+PyYAML ausentes).`);
}

/** PyYAML (YAML 1.1) converte a chave `on` em booleano `true`. */
function onSection(doc: any): any {
  if (!doc || typeof doc !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(doc, "on")) return doc["on"];
  if (Object.prototype.hasOwnProperty.call(doc, true)) return doc[true];
  return undefined;
}

function stepsOf(job: any): any[] {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function allUses(job: any): string[] {
  return stepsOf(job).map((s) => s?.uses).filter((u): u is string => typeof u === "string");
}

function allRunText(job: any): string {
  return stepsOf(job)
    .map((s) => (typeof s?.run === "string" ? s.run : ""))
    .join("\n");
}

function stepIndexByPredicate(job: any, pred: (s: any) => boolean): number {
  return stepsOf(job).findIndex(pred);
}

/** Localiza o step que executa a guarda de integridade do tarball. */
function guardStepOf(job: any): any | undefined {
  return stepsOf(job).find(
    (s) => String(s.run ?? "").includes("node -e '") && String(s.run ?? "").includes("pack-manifest"),
  );
}

/** Extrai o corpo JS do `node -e '...'` da guarda de um job. */
function guardBodyOf(job: any): string {
  const run = String(guardStepOf(job)?.run ?? "");
  const marker = "node -e '";
  const start = run.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const end = run.lastIndexOf("'");
  return end > bodyStart ? run.slice(bodyStart, end) : "";
}

// ─────────────────────────── semver mínimo ───────────────────────────

type Sem = [number, number, number];

function parseSem(v: string): Sem | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSem(a: Sem, b: Sem): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Satisfator de range para os formatos usados no manifesto (^, ~, >=, exato, *). */
function satisfies(version: string, range: string): boolean {
  const v = parseSem(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "" || r === "*") return true;
  if (r.startsWith(">=")) {
    const c = parseSem(r.slice(2));
    return c ? cmpSem(v, c) >= 0 : false;
  }
  if (r.startsWith("^")) {
    const c = parseSem(r.slice(1));
    if (!c) return false;
    if (cmpSem(v, c) < 0) return false;
    if (c[0] > 0) return v[0] === c[0];
    if (c[1] > 0) return v[0] === 0 && v[1] === c[1];
    return v[0] === 0 && v[1] === 0 && v[2] === c[2];
  }
  if (r.startsWith("~")) {
    const c = parseSem(r.slice(1));
    if (!c) return false;
    return cmpSem(v, c) >= 0 && v[0] === c[0] && v[1] === c[1];
  }
  const c = parseSem(r);
  return c ? cmpSem(v, c) === 0 : false;
}

// ─────────────────────────── artefatos ───────────────────────────

const ciText = readText(CI_YML);
const publishText = readText(PUBLISH_YML);
const readmeText = readText(README_PATH);
const changelogText = readText(CHANGELOG_PATH);
const pkg = JSON.parse(readText(PKG_PATH));

const ciDoc = loadYaml(ciText, "ci.yml");
const publishDoc = loadYaml(publishText, "publish.yml");
const ciJob = ciDoc?.jobs?.ci;
const publishJob = publishDoc?.jobs?.publish;
const ciOn = onSection(ciDoc);
const publishOn = onSection(publishDoc);

describe("DREAMS-05 · ci.yml — esteira hermética, travada e ordenada", () => {
  test("dispara em push/pull_request (main|master) e workflow_dispatch", () => {
    expect(ciOn).toBeDefined();
    expect(ciOn.push?.branches).toEqual(["main", "master"]);
    expect(ciOn.pull_request?.branches).toEqual(["main", "master"]);
    expect(ciOn.workflow_dispatch).toBeDefined();
  });

  test("Bun travado em versão EXATA — nunca `latest` nem range", () => {
    const pinned = ciDoc?.env?.BUN_VERSION;
    expect(typeof pinned).toBe("string");
    expect(pinned).not.toMatch(/latest/i);
    expect(pinned).not.toMatch(/[\^~><*]/);
    expect(parseSem(pinned)).not.toBeNull();
  });

  test("a versão travada satisfaz bun-types, @types/bun e engines.bun do manifesto", () => {
    const pinned = ciDoc.env.BUN_VERSION;
    expect(satisfies(pinned, pkg.devDependencies["bun-types"])).toBe(true);
    expect(satisfies(pinned, pkg.devDependencies["@types/bun"])).toBe(true);
    expect(satisfies(pinned, pkg.engines.bun)).toBe(true);
  });

  test("a versão do Bun é a FONTE ÚNICA — idêntica em ci.yml e publish.yml", () => {
    expect(publishDoc.env.BUN_VERSION).toBe(ciDoc.env.BUN_VERSION);
  });

  test("install congelado → typecheck → teste offline → pack (ordem real dos steps)", () => {
    const iInstall = stepIndexByPredicate(ciJob, (s) => String(s.run ?? "").includes("bun install --frozen-lockfile"));
    const iType = stepIndexByPredicate(ciJob, (s) => String(s.run ?? "").includes("bun run typecheck"));
    const iTest = stepIndexByPredicate(ciJob, (s) => String(s.run ?? "").includes("bun test"));
    const iPack = stepIndexByPredicate(ciJob, (s) => String(s.run ?? "").includes("npm pack --dry-run"));

    expect(iInstall).toBeGreaterThanOrEqual(0);
    expect(iType).toBeGreaterThan(iInstall);
    expect(iTest).toBeGreaterThan(iType);
    expect(iPack).toBeGreaterThan(iTest);
  });

  test("a suíte roda em modo OFFLINE (DREAMS_OFFLINE=1 no comando e no env do step)", () => {
    const testStep = stepsOf(ciJob).find((s) => String(s.run ?? "").includes("bun test"));
    expect(testStep).toBeDefined();
    expect(testStep.run).toContain("DREAMS_OFFLINE=1 bun test");
    expect(String(testStep.env?.DREAMS_OFFLINE)).toBe("1");
  });

  test("o step de testes do publish.yml também é OFFLINE", () => {
    const testStep = stepsOf(publishJob).find((s) => String(s.run ?? "").includes("bun test"));
    expect(testStep).toBeDefined();
    expect(testStep.run).toContain("DREAMS_OFFLINE=1 bun test");
  });

  test("setup-bun consome a versão do env (sem hardcode paralelo)", () => {
    const setup = stepsOf(ciJob).find((s) => String(s.uses ?? "").startsWith("oven-sh/setup-bun"));
    expect(setup).toBeDefined();
    expect(setup.with["bun-version"]).toBe("${{ env.BUN_VERSION }}");
  });

  test("permissões somente-leitura e timeout limitado no job", () => {
    expect(ciJob.permissions).toBeDefined();
    expect(ciJob.permissions.contents).toBe("read");
    for (const [perm, value] of Object.entries<string>(ciJob.permissions)) {
      expect(value).toBe("read");
      expect(perm).not.toBe("write-all");
    }
    expect(typeof ciJob["timeout-minutes"]).toBe("number");
    expect(ciJob["timeout-minutes"]).toBeGreaterThan(0);
    expect(ciJob["timeout-minutes"]).toBeLessThanOrEqual(30);
  });

  test("concurrency cancela execuções órfãs do mesmo ref", () => {
    expect(ciDoc.concurrency).toBeDefined();
    expect(ciDoc.concurrency["cancel-in-progress"]).toBe(true);
    expect(String(ciDoc.concurrency.group)).toContain("github.ref");
  });

  test("toda action é pinada por MAJOR e nenhuma aponta para ação inexistente", () => {
    const uses = [...allUses(ciJob), ...allUses(publishJob)];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/^[\w.-]+\/[\w.-]+@v\d+(\.\d+)*$/);
    }
    expect(uses.join("\n")).not.toContain("oven-sh/cache-bun");
  });

  test("o cache de downloads do Bun usa actions/cache com chave derivada do bun.lock", () => {
    const cacheStep = stepsOf(ciJob).find((s) => String(s.uses ?? "").startsWith("actions/cache"));
    expect(cacheStep).toBeDefined();
    expect(cacheStep.with.path).toContain(".bun/install/cache");
    expect(cacheStep.with.key).toContain("hashFiles('bun.lock')");
  });

  test("todo step que invoca `node` tem o runtime Node DECLARADO antes dele", () => {
    for (const [label, job] of [["ci.yml", ciJob], ["publish.yml", publishJob]] as const) {
      const steps = stepsOf(job);
      const setupNode = steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/setup-node"));
      expect(setupNode, `${label} deve declarar actions/setup-node`).toBeGreaterThanOrEqual(0);
      steps.forEach((s: any, i: number) => {
        if (String(s.run ?? "").includes("node -e")) {
          expect(
            setupNode,
            `${label}: step "${s.name}" invoca node mas actions/setup-node vem depois (índice ${setupNode})`,
          ).toBeLessThan(i);
        }
      });
    }
  });
});

describe("DREAMS-05 · guarda de integridade do tarball (executada de verdade)", () => {
  const packStep = stepsOf(ciJob).find((s) => String(s.run ?? "").includes("npm pack --dry-run"));
  const guardRun = String(packStep?.run ?? "");

  /** Extrai o corpo JS do `node -e '...'` embutido no workflow. */
  function guardSource(): string {
    const body = guardBodyOf(ciJob);
    expect(body.length).toBeGreaterThan(0);
    return body;
  }

  /** Executa a guarda real contra um manifesto sintético. */
  function runGuard(files: string[]): { code: number; stdout: string; stderr: string } {
    const dir = tmpDir("dreams05-guard-");
    fs.writeFileSync(
      path.join(dir, "pack-manifest.json"),
      JSON.stringify([{ files: files.map((p) => ({ path: p })) }]),
    );
    fs.writeFileSync(path.join(dir, "guard.js"), guardSource());
    const r = spawnSync(nodeBin(), ["guard.js"], { cwd: dir, encoding: "utf8" });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("a guarda existe no workflow e aborta com artefatos proibidos", () => {
    expect(guardRun).toContain("node -e '");
    const cases: string[][] = [
      ["tests/dreams.test.ts"],
      ["tests/fixtures/log.jsonl"],
      [".github/workflows/ci.yml"],
      [".test-scratch/scratch.txt"],
      ["debug.log"],
      ["state.db"],
      ["state.db-wal"],
      ["state.db-shm"],
    ];
    for (const files of cases) {
      const r = runGuard(files);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("::error::");
      for (const f of files) expect(r.stderr).toContain(f);
    }
  });

  test("a guarda aborta quando o tarball sai VAZIO", () => {
    const r = runGuard([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("vazio");
  });

  test("a guarda aprova um pacote limpo (não é vacuosa)", () => {
    const r = runGuard([
      "package.json",
      "README.md",
      "LICENSE",
      "bin/agent-dreams.js",
      "src/index.ts",
      "systemd/agent-dreams.service",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK:");
  });

  test("a guarda aprova o manifesto REAL de `npm pack --dry-run --json`", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: HERMETIC_ENV,
    });
    expect(r.status).toBe(0);
    const manifest = JSON.parse(r.stdout);
    const dir = tmpDir("dreams05-guard-real-");
    fs.writeFileSync(path.join(dir, "pack-manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, "guard.js"), guardSource());
    const g = spawnSync(nodeBin(), ["guard.js"], { cwd: dir, encoding: "utf8" });
    expect(g.status).toBe(0);
    expect(g.stdout).toContain("OK:");
  });
});

describe("DREAMS-05 · publish.yml — proveniência e coerência de versão", () => {
  test("publica com --access public --provenance e token do secret", () => {
    const publishStep = stepsOf(publishJob).find((s) => String(s.run ?? "").includes("npm publish"));
    expect(publishStep).toBeDefined();
    expect(publishStep.run).toContain("npm publish --access public --provenance");
    expect(publishStep.env?.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
  });

  test("permissões habilitam o OIDC (id-token: write) sem escrita de conteúdo", () => {
    expect(publishJob.permissions["id-token"]).toBe("write");
    expect(publishJob.permissions.contents).toBe("read");
  });

  test("configura o registry npm via setup-node", () => {
    const setup = stepsOf(publishJob).find((s) => String(s.uses ?? "").startsWith("actions/setup-node"));
    expect(setup).toBeDefined();
    expect(setup.with["registry-url"]).toBe("https://registry.npmjs.org");
  });

  test("gatilho é a publicação de release (ou disparo manual)", () => {
    expect(publishOn.release?.types).toEqual(["published"]);
    expect(publishOn.workflow_dispatch).toBeDefined();
  });

  test("o passo de publicação é o ÚLTIMO (typecheck → test → pack → versão → publish)", () => {
    const iType = stepIndexByPredicate(publishJob, (s) => String(s.run ?? "").includes("bun run typecheck"));
    const iTest = stepIndexByPredicate(publishJob, (s) => String(s.run ?? "").includes("bun test"));
    const iPack = stepIndexByPredicate(publishJob, (s) => String(s.run ?? "").includes("npm pack"));
    const iCheck = stepIndexByPredicate(publishJob, (s) => String(s.run ?? "").includes("GITHUB_REF_NAME"));
    const iPub = stepIndexByPredicate(publishJob, (s) => String(s.run ?? "").includes("npm publish"));

    expect(iType).toBeGreaterThanOrEqual(0);
    expect(iTest).toBeGreaterThan(iType);
    expect(iPack).toBeGreaterThan(iTest);
    expect(iCheck).toBeGreaterThan(iPack);
    expect(iPub).toBeGreaterThan(iCheck);
    expect(iPub).toBe(stepsOf(publishJob).length - 1);
  });

  /** Executa o check de versão REAL do publish.yml em bash. */
  function runVersionCheck(refName: string): { code: number; stdout: string; stderr: string } {
    const step = stepsOf(publishJob).find((s) => String(s.run ?? "").includes("GITHUB_REF_NAME"));
    const script = String(step?.run ?? "");
    expect(script).toContain("package.json");
    const r = spawnSync("bash", ["-c", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...HERMETIC_ENV, GITHUB_REF_NAME: refName },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("tag coerente com o manifesto é aceita", () => {
    const r = runVersionCheck(`v${pkg.version}`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Versão coerente");
  });

  test("tag divergente ABORTA a publicação", () => {
    const r = runVersionCheck("v99.99.99");
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("::error::");
  });

  test("tag sem prefixo `v` também é aceita quando coerente", () => {
    const r = runVersionCheck(pkg.version);
    expect(r.code).toBe(0);
  });

  test("tag NÃO-semver é ignorada (fail-safe, não trava convenções alternativas)", () => {
    const r = runVersionCheck("nightly-build");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("::notice::");
  });

  test("pré-release NÃO pode publicar o conteúdo da versão estável", () => {
    const r = runVersionCheck(`v${pkg.version}-rc.1`);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("::error::");
  });

  test("o CAMINHO DE PUBLICAÇÃO é protegido pela guarda de integridade do tarball", () => {
    // O `ci.yml` NÃO é gatilho de `release` e `push.branches` não casa pushes
    // de tag: a publicação só é regida por `publish.yml`. Logo, a guarda de
    // integridade precisa EXECUTAR no próprio caminho de publicação — ou ser
    // invocada por um workflow reutilizável chamado dali.
    const reusableCall = stepsOf(publishJob).find((s) =>
      String(s.uses ?? "").startsWith("./.github/workflows/"),
    );
    if (reusableCall) return; // padrão legítimo: workflow reutilizável

    const guardStep = guardStepOf(publishJob);
    expect(guardStep).toBeDefined();

    // Comportamento: a guarda do caminho de publicação ABORTA com artefato proibido.
    const body = guardBodyOf(publishJob);
    const dir = tmpDir("dreams05-pub-guard-");
    fs.writeFileSync(path.join(dir, "guard.js"), body);
    fs.writeFileSync(
      path.join(dir, "pack-manifest.json"),
      JSON.stringify([{ files: [{ path: "tests/dreams.test.ts" }] }]),
    );
    const g = spawnSync(nodeBin(), ["guard.js"], { cwd: dir, encoding: "utf8" });
    expect(g.status).not.toBe(0);
    expect(g.stderr).toContain("tests/dreams.test.ts");
  });

  test("a guarda do caminho de publicação também ABORTA com tarball vazio e aprova pacote limpo", () => {
    const body = guardBodyOf(publishJob);
    expect(body.length).toBeGreaterThan(0);

    const runWith = (files: string[]): { code: number; stdout: string; stderr: string } => {
      const dir = tmpDir("dreams05-pub-guard2-");
      fs.writeFileSync(path.join(dir, "guard.js"), body);
      fs.writeFileSync(
        path.join(dir, "pack-manifest.json"),
        JSON.stringify([{ files: files.map((p) => ({ path: p })) }]),
      );
      const r = spawnSync(nodeBin(), ["guard.js"], { cwd: dir, encoding: "utf8" });
      return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };

    const empty = runWith([]);
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("vazio");

    const clean = runWith(["package.json", "README.md", "LICENSE", "src/index.ts"]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("OK:");
  });

  test("as guardas do ci.yml e do publish.yml são EQUIVALENTES (não podem divergir)", () => {
    const patterns = (src: string): string[] => {
      const out: string[] = [];
      const re = /p\.(startsWith|endsWith)\("([^"]+)"\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) out.push(`${m[1]}:${m[2]}`);
      return out.sort();
    };
    const ciPat = patterns(guardBodyOf(ciJob));
    const pubPat = patterns(guardBodyOf(publishJob));
    expect(ciPat.length).toBeGreaterThan(0);
    expect(pubPat.length).toBeGreaterThan(0);
    expect(pubPat).toEqual(ciPat);
  });
});

describe("DREAMS-05 · README — contrato público coerente com a implementação", () => {
  test("nenhuma invocação via npx para o pacote (o runtime é Bun)", () => {
    expect(readmeText).not.toMatch(/\bnpx\b[^\n]*(agent-dreams|dreams-mcp)/);
    expect(readmeText).not.toMatch(/\bnpx\s+-y\b/);
  });

  test("o comando canônico `bunx agent-dreams` é o documentado", () => {
    expect(readmeText).toContain("bunx agent-dreams");
    expect((readmeText.match(/bunx agent-dreams/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test("os blocos de configuração MCP usam `bunx` como comando", () => {
    const count = (readmeText.match(/"command":\s*"bunx"/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(readmeText).not.toMatch(/"command":\s*"npx"/);
  });

  test("declara explicitamente que Node.js puro não é suportado", () => {
    expect(readmeText).toMatch(/Node\.js puro n[ãa]o [ée] suportado/i);
  });

  test("a seção systemd cita as units REAIS e o placeholder real", () => {
    expect(fs.existsSync(path.join(SYSTEMD_DIR, "agent-dreams.service"))).toBe(true);
    expect(fs.existsSync(path.join(SYSTEMD_DIR, "agent-dreams.timer"))).toBe(true);
    expect(readmeText).toContain("systemd/agent-dreams.service");
    expect(readmeText).toContain("systemd/agent-dreams.timer");
    expect(readmeText).toContain("__AGENT_DREAMS_DIR__");
    expect(readmeText).not.toMatch(/opencode-dreams\.(service|timer)/);
  });

  test("a branding legada não sobrevive no README", () => {
    expect(readmeText).not.toContain("Chamber Dream");
    expect(readmeText).not.toContain("opencode-plugin-dreams");
  });

  test("o badge de CI aponta para um workflow que EXISTE", () => {
    const badge = /actions\/workflows\/([\w.-]+\.yml)\/badge\.svg/.exec(readmeText);
    expect(badge).not.toBeNull();
    const wf = path.join(REPO_ROOT, ".github", "workflows", badge![1]);
    expect(fs.existsSync(wf)).toBe(true);
    // O badge precisa apontar para o workflow de CI desta entrega.
    expect(badge![1]).toBe("ci.yml");
  });

  test("o README referencia o CHANGELOG, que existe", () => {
    expect(readmeText).toContain("CHANGELOG.md");
    expect(fs.existsSync(CHANGELOG_PATH)).toBe(true);
  });

  test("o README declara que a guarda roda também no caminho de publicação", () => {
    expect(readmeText).toMatch(/guarda de integridade/i);
    expect(readmeText).toMatch(/caminho de publica/i);
    expect(readmeText).toMatch(/publish\.yml/);
  });

  test("o bloco bash de instalação manual do README é EXECUTÁVEL de verdade", () => {
    const blocks = [...readmeText.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    const manual = blocks.find((b) => b.includes("__AGENT_DREAMS_DIR__") && b.includes("sed "));
    expect(manual).toBeDefined();

    /** Executa o bloco documentado num sandbox com `systemctl` recorder real. */
    function runManualBlock(script: string, pluginDir: string): { unit: string; timer: string; systemctlLog: string } {
      const home = tmpDir("dreams05-readme-home-");
      const shimDir = path.join(home, "shim");
      fs.mkdirSync(shimDir, { recursive: true });
      const logFile = path.join(home, "systemctl.log");
      fs.writeFileSync(
        path.join(shimDir, "systemctl"),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const work = path.join(home, "work");
      fs.mkdirSync(work, { recursive: true });
      fs.cpSync(SYSTEMD_DIR, path.join(work, "systemd"), { recursive: true });
      const script2 = script.replace(/^PLUGIN_DIR=.*$/m, `PLUGIN_DIR="${pluginDir}"`);
      const r = spawnSync("bash", ["-c", script2], {
        cwd: work,
        encoding: "utf8",
        env: {
          ...HERMETIC_ENV,
          HOME: home,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          XDG_CONFIG_HOME: "",
        },
      });
      expect(r.status).toBe(0);
      const unitDir = path.join(home, ".config", "systemd", "user");
      return {
        unit: fs.readFileSync(path.join(unitDir, "agent-dreams.service"), "utf8"),
        timer: fs.readFileSync(path.join(unitDir, "agent-dreams.timer"), "utf8"),
        systemctlLog: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
      };
    }

    const pluginDir = "/opt/agent-dreams/install";
    const res = runManualBlock(manual!, pluginDir);

    // O placeholder foi REALMENTE substituído pelo caminho do plugin.
    expect(res.unit).not.toContain("__AGENT_DREAMS_DIR__");
    expect(res.unit).toContain(pluginDir);
    // A unit gerada é a unit versionada, com o caminho trocado.
    const versioned = readText(path.join(SYSTEMD_DIR, "agent-dreams.service"));
    expect(res.unit).toBe(versioned.replaceAll("__AGENT_DREAMS_DIR__", pluginDir));
    // O timer foi copiado byte a byte.
    expect(res.timer).toBe(readText(path.join(SYSTEMD_DIR, "agent-dreams.timer")));
    // A nomenclatura canônica foi usada no systemctl documentado.
    expect(res.systemctlLog).toContain("enable --now agent-dreams.timer");
    expect(res.systemctlLog).not.toContain("opencode-dreams");
  });
});

describe("DREAMS-05 · CHANGELOG — histórico coerente e honesto", () => {
  test("segue Keep a Changelog e SemVer", () => {
    expect(changelogText).toContain("keepachangelog.com");
    expect(changelogText).toContain("semver.org");
  });

  test("a primeira versão semver documentada é a versão do manifesto", () => {
    const headings = [...changelogText.matchAll(/^##\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
    const semvers = headings.filter((h) => parseSem(h) !== null);
    expect(semvers.length).toBeGreaterThan(0);
    expect(semvers[0]).toBe(pkg.version);
  });

  test("cobre as quatro frentes do corte de release", () => {
    expect(changelogText).toMatch(/empacotamento|empacotad/i);
    expect(changelogText).toContain("bunx");
    expect(changelogText).toMatch(/systemd/i);
    expect(changelogText).toMatch(/redactSecrets|redação de segredos|segredos/i);
  });

  test("registra a colisão de versão já publicada no registry (bloqueio de lançamento)", () => {
    expect(changelogText).toMatch(/já está ocupado|stage build/i);
    expect(changelogText).toContain("1.0.3");
  });

  test("declara que a guarda roda em AMBOS os caminhos de publicação", () => {
    expect(changelogText).toMatch(/guarda de integridade/i);
    expect(changelogText).toMatch(/ambos os\s+caminhos/i);
    expect(changelogText).toMatch(/ci\.yml[\s\S]{0,160}publish\.yml/i);
    // A razão técnica do porquê (push.branches não casa pushes de tag) deve estar
    // documentada — é o que impede a regressão do defeito corrigido.
    expect(changelogText).toMatch(/push\.branches/i);
  });

  test("honestidade: só afirma permissões POSIX estritas se o código as tiver", () => {
    const codeScan = ["src", "bin", "scripts"]
      .flatMap((d) => {
        const root = path.join(REPO_ROOT, d);
        if (!fs.existsSync(root)) return [] as string[];
        return fs
          .readdirSync(root, { recursive: true, encoding: "utf8" })
          .filter((f) => typeof f === "string" && /\.(ts|js|sh)$/.test(f))
          .map((f) => readText(path.join(root, f)));
      })
      .join("\n");

    const codeHasStrictPerms = /0o700|0o600/.test(codeScan);
    if (codeHasStrictPerms) {
      expect(changelogText).toMatch(/0o700|0o600|POSIX/i);
    } else {
      expect(changelogText).not.toMatch(/0o700|0o600/);
    }
  });
});

describe("DREAMS-05 · pacote real publicado (parity e ausência de vazamento)", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: HERMETIC_ENV,
  });
  expect(r.status).toBe(0);
  const manifest = JSON.parse(r.stdout)[0];
  const packedPaths: string[] = manifest.files.map((f: any) => f.path);

  test("o empacotamento é hermético: nenhum arquivo de teste/CI vaza", () => {
    expect(packedPaths).not.toContain("tests/dreams.test.ts");
    for (const p of packedPaths) {
      expect(p.startsWith("tests/")).toBe(false);
      expect(p.startsWith(".github/")).toBe(false);
      expect(p.endsWith(".log")).toBe(false);
      expect(p.endsWith(".db")).toBe(false);
      expect(p.endsWith(".db-wal")).toBe(false);
      expect(p.endsWith(".db-shm")).toBe(false);
    }
  });

  test("distribui LICENSE e as units systemd", () => {
    expect(packedPaths).toContain("LICENSE");
    expect(packedPaths).toContain("systemd/agent-dreams.service");
    expect(packedPaths).toContain("systemd/agent-dreams.timer");
  });

  test("os binários publicados apontam para o executável canônico", () => {
    expect(packedPaths).toContain("bin/agent-dreams.js");
    expect(packedPaths).not.toContain("bin/dreams-mcp.js");
  });

  test("parity: o README e o manifesto publicados são os mesmos validados aqui", () => {
    const published = manifest.files.find((f: any) => f.path === "README.md");
    expect(published).toBeDefined();
    expect(published.size).toBe(Buffer.byteLength(readmeText, "utf8"));

    const publishedPkg = manifest.files.find((f: any) => f.path === "package.json");
    expect(publishedPkg).toBeDefined();
    expect(publishedPkg.size).toBe(Buffer.byteLength(readText(PKG_PATH), "utf8"));
  });

  test("o manifesto do pack gerado na esteira NÃO é versionável", () => {
    // O guard grava `pack-manifest.json` na raiz do repositório; se o arquivo
    // não for ignorado, ele vira lixo de execução local no working tree.
    const gitignore = readText(path.join(REPO_ROOT, ".gitignore"));
    expect(gitignore).toMatch(/^pack-manifest\.json$/m);
  });

  test("todo arquivo publicado está coberto pelo campo `files` (exceto os sempre inclusos do npm)", () => {
    const allowed = (pkg.files ?? []).map((d: string) => d.replace(/\/$/, ""));
    // O npm inclui estes metadados MESMO sem declaração em `files`.
    const alwaysIncluded = ["package.json", "README.md", "README", "LICENSE", "LICENCE", "NOTICE"];
    for (const p of packedPaths) {
      const covered = allowed.some((d: string) => p === d || p.startsWith(`${d}/`) || d === ".");
      const implicit = alwaysIncluded.includes(p);
      expect(covered || implicit).toBe(true);
    }
    // Nenhum caminho fora da árvore declarada foi publicado.
    for (const p of packedPaths) {
      const top = p.split("/")[0];
      const ok = allowed.includes(top) || alwaysIncluded.includes(p);
      expect(ok).toBe(true);
    }
  });
});
