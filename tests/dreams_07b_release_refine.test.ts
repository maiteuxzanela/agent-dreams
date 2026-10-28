/**
 * TICKET-DREAMS-07 (Refinamento de Lançamento) — Suíte determinística SDET.
 *
 * ZERO mocks. Nenhuma simulação de estado: tudo é exercitado contra
 * artefatos REAIS em disco, processos REAIS (`bash`, `git`) e o runtime REAL
 * do pacote (MCP server, tool `dream_learn`, `SleepCycle`).
 *
 * O que esta suíte PROVA:
 *
 * 1. BUMP COORDENADO v1.0.5 — a versão é uma só em três lugares:
 *    `package.json` (manifesto), `MCP_SERVER_VERSION` (constante REAL importada
 *    do módulo de produção) e o CHANGELOG (primeira seção semver). O
 *    manifesto não pode listar diretório inexistente em `files`.
 *
 * 2. CI/CD — Node 22 (Active LTS) em `ci.yml` e `publish.yml`; e a guarda de
 *    `NODE_AUTH_TOKEN` é EXECUTADA DE VERDADE: o bloco `run:` do step
 *    "Publish to NPM" é extraído do YAML, escrito em disco e executado por
 *    `bash` em três cenários (token ausente / token vazio / token presente),
 *    com um recorder `npm` REAL no PATH que registra o argv. Prova o
 *    fail-fast ANTES do `npm publish` e a preservação do `--provenance`.
 *
 * 3. HARDENING POSIX — `0o700` nos diretórios e `0o600` nos artefatos
 *    satélite, medidos com `stat` real sobre os arquivos produzidos pelo
 *    `SleepCycle`, pela tool `dream_learn` e pelo `appendDailyLog` do MCP.
 *    Inclui o caminho de HERANÇA (artefato pré-existente `0o644`), que só é
 *    coberto pelo `chmod` pós-escrita, e um CONTROLE DE SENSIBILIDADE que
 *    prova que o modo natural do filesystem NÃO é `0o600`/`0o700`.
 *
 * 4. `.gitignore` — `kanban.json` e `opencode.json` são EFFECTIVAMENTE
 *    ignorados: `git check-ignore` (binário real) e `git status` provam.
 *
 * 5. README — não promete mais o "truncamento invertido"; descreve o handoff
 *    integral e o particionamento em chunks do REM Sleep.
 */
import { test, expect, describe } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { Database } from "bun:sqlite";
import { DreamsDB } from "../src/core/db";
import { SleepCycle, DIALOGUE_CHECKPOINT_FILENAME } from "../src/core/sleep_cycle";
import { MCP_SERVER_VERSION, appendDailyLog } from "../src/mcp/server";
import { dream_learn } from "../src/tools";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const CI_YML = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const PUBLISH_YML = path.join(REPO_ROOT, ".github", "workflows", "publish.yml");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const README_PATH = path.join(REPO_ROOT, "README.md");
const GITIGNORE_PATH = path.join(REPO_ROOT, ".gitignore");

const PKG = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
  version: string;
  files: string[];
};

// ─────────────────────────── helpers ───────────────────────────

function readText(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Modo POSIX real (bits de permissão) do arquivo/diretório. */
function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/**
 * Extrai o corpo de um bloco `run: |` do step indicado, preservando a
 * indentação relativa. Parser textual determinístico — sem YAML externo.
 */
function extractRunBlock(yamlText: string, stepName: string): string {
  const lines = yamlText.split("\n");
  const stepIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(stepIdx).toBeGreaterThan(-1);

  let runIdx = -1;
  for (let i = stepIdx + 1; i < lines.length; i++) {
    if (/^\s*run:\s*\|+\s*$/.test(lines[i])) {
      runIdx = i;
      break;
    }
    // Próximo step Started — o bloco não existe neste step.
    if (/^\s*-\s+name:/.test(lines[i])) break;
  }
  expect(runIdx).toBeGreaterThan(-1);

  const baseIndent = (lines[runIdx].match(/^\s*/)?.[0].length ?? 0) + 2;
  const body: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < baseIndent) break;
    body.push(line.slice(baseIndent));
  }
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  return body.join("\n");
}

/**
 * Recorder REAL do `npm`: um executável que registra o argv recebido.
 * É um seam legítimo (o binário `npm` do PATH é substituído por um
 * executável real), não uma mockagem de estado interno do plugin.
 */
function makeNpmRecorder(dir: string): { binDir: string; logFile: string } {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logFile = path.join(dir, "npm_argv.log");
  const script = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${logFile}"`,
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "npm"), script, { mode: 0o755 });
  return { binDir, logFile };
}

/** Executa o bloco `run:` do step de publicação em `bash`, de verdade. */
function runPublishStep(
  script: string,
  env: Record<string, string | undefined>
): { code: number; output: string; npmLog: string } {
  const dir = mkTmp("dreams07_publish_");
  const { binDir, logFile } = makeNpmRecorder(dir);
  const scriptPath = path.join(dir, "publish_step.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") merged[k] = v;
  }
  // O recorder do `npm` PRECEDE o PATH real (o `npm` genuine nunca é chamado).
  merged.PATH = `${binDir}:${merged.PATH ?? process.env.PATH ?? ""}`;
  const r = spawnSync("bash", [scriptPath], { env: merged, encoding: "utf8" });
  return {
    code: r.status ?? -1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    npmLog: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
  };
}

interface FMsg {
  id: string;
  session: string;
  t: number;
  role: "user" | "assistant";
  texts: string[];
}

/** Banco OpenCode REAL (tabelas `message`/`part`) do qual o Light Sleep lê. */
function buildSessionDb(dir: string, msgs: FMsg[]): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);`);
  // Tabela OPCIONAL do schema do OpenCode (a exclusão anti-recursão do
  // Dreams degrada para lista vazia sem ela) — presente para que a leitura
  // não emita divergência de schema.
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT);`);
  for (const m of msgs) {
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
      m.id,
      m.session,
      m.t,
      JSON.stringify({ role: m.role }),
    ]);
    let n = 0;
    for (const t of m.texts) {
      db.run("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)", [
        `${m.id}_t${n++}`,
        m.id,
        m.t + n,
        JSON.stringify({ type: "text", text: t }),
      ]);
    }
  }
  db.close();
  return dbPath;
}

// ===========================================================================
// 1 — BUMP COORDENADO v1.0.5
// ===========================================================================

describe("DREAMS-07 · bump coordenado v1.0.5", () => {
  test("o manifesto declara 1.0.5 (semver puro)", () => {
    expect(PKG.version).toBe("1.0.5");
    expect(/^\d+\.\d+\.\d+$/.test(PKG.version)).toBe(true);
  });

  test("a versão REAL do servidor MCP é idêntica à do manifesto", () => {
    // Import do módulo de produção: prova de runtime, não de varredura de texto.
    expect(MCP_SERVER_VERSION).toBe(PKG.version);
  });

  test("o CHANGELOG documenta 1.0.5 como PRIMEIRA versão semver", () => {
    const changelog = readText(CHANGELOG_PATH);
    const headings = [...changelog.matchAll(/^##\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
    const semvers = headings.filter((h) => /^\d+\.\d+\.\d+$/.test(h.trim()));
    expect(semvers.length).toBeGreaterThan(0);
    expect(semvers[0]).toBe(PKG.version);
    expect(changelog).toContain(`## [${PKG.version}]`);
  });

  test("o manifesto não lista diretório inexistente em `files`", () => {
    expect(Array.isArray(PKG.files)).toBe(true);
    expect(PKG.files).not.toContain("scripts");
    for (const entry of PKG.files) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry))).toBe(true);
    }
  });

  test("CONTROLE DE SENSIBILIDADE: um bump divergente quebraria a coerência", () => {
    // Se o MCP voltasse a "1.0.0" (divergência real do pré-bump), a
    // coerência acima cairia. Este controle fixa o valor divergente como
    // falha esperada — prova que o assert discrimina.
    expect(MCP_SERVER_VERSION).not.toBe("1.0.0");
    expect(MCP_SERVER_VERSION).not.toBe("1.0.2");
    // O `1.0.3` foi preparado mas NUNCA publicado (nenhuma tag `v1.0.3`
    // existiu): o registry saltou direto para `1.0.4`. O controle fixa a
    // versão intermediária como falha esperada.
    expect(MCP_SERVER_VERSION).not.toBe("1.0.3");
  });
});

// ===========================================================================
// 2 — CI/CD: Node 22 e guarda NODE_AUTH_TOKEN (COMPORTAMENTO REAL)
// ===========================================================================

describe("DREAMS-07 · CI/CD — Node 22 (Active LTS)", () => {
  test("ci.yml e publish.yml usam node-version 22", () => {
    for (const f of [CI_YML, PUBLISH_YML]) {
      const text = readText(f);
      expect(text).toMatch(/node-version:\s*22\b/);
      expect(text).not.toMatch(/node-version:\s*20\b/);
      expect(text).not.toMatch(/node-version:\s*latest\b/);
    }
  });
});

describe("DREAMS-07 · publish.yml — guarda fail-fast de NODE_AUTH_TOKEN", () => {
  const publishText = readText(PUBLISH_YML);
  const step = extractRunBlock(publishText, "Publish to NPM");

  test("a guarda é executada ANTES do npm publish", () => {
    const guardIdx = step.indexOf("NODE_AUTH_TOKEN");
    const publishIdx = step.indexOf("npm publish");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(publishIdx);
    expect(step).toContain("::error::");
  });

  test("a publicação preserva --access public --provenance", () => {
    expect(step).toContain("npm publish --access public --provenance");
  });

  test("o step consome o secret NPM_TOKEN como NODE_AUTH_TOKEN", () => {
    expect(publishText).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });

  test("COMPORTAMENTO REAL: sem token a publicação ABORTA e o npm NUNCA é chamado", () => {
    const r = runPublishStep(step, { PATH: process.env.PATH });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("::error::");
    expect(r.output).toContain("NODE_AUTH_TOKEN");
    // A prova de que abortou ANTES: o recorder do npm não registrou nada.
    expect(r.npmLog).toBe("");
  });

  test("COMPORTAMENTO REAL: token vazio também aborta (fail-fast)", () => {
    const r = runPublishStep(step, { NODE_AUTH_TOKEN: "", PATH: process.env.PATH });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("::error::");
    expect(r.npmLog).toBe("");
  });

  test("COMPORTAMENTO REAL: com token configurado a publicação SEGUE", () => {
    const r = runPublishStep(step, { NODE_AUTH_TOKEN: "npm_token_fake_para_teste", PATH: process.env.PATH });
    expect(r.code).toBe(0);
    expect(r.npmLog).toContain("publish --access public --provenance");
  });

  test("CONTROLE DE SENSIBILIDADE: sem a guarda o passo publicaria mesmo sem token", () => {
    // Réplica do bloco COM a guarda removida: prova que o abort do cenário
    // "sem token" vem da guarda do workflow, e não de outra causa.
    const unguarded = step.replace(/^\s*if \[ -z .*$/m, "");
    const r = runPublishStep(unguarded, { PATH: process.env.PATH });
    expect(r.code).toBe(0);
    expect(r.npmLog).toContain("publish --access public --provenance");
  });
});

// ===========================================================================
// 3 — HARDENING POSIX (0o700 dirs / 0o600 artefatos)
// ===========================================================================

describe("DREAMS-07 · hardening POSIX — diretórios 0o700 e artefatos 0o600", () => {
  test("CONTROLE DE SENSIBILIDADE: o modo natural do umask NÃO é 0o600/0o700", () => {
    // O umask é fixado em 0o022 durante a medição para que o controle seja
    // determinístico em qualquer máquina (sem mocks, é o umask REAL do SO).
    const prev = process.umask(0o022);
    try {
      const dir = mkTmp("dreams07_umask_");
      const f = path.join(dir, "natural.txt");
      const fd = fs.openSync(f, "w", 0o666);
      fs.closeSync(fd);
      const natural = modeOf(f);
      expect(natural).toBe(0o644);
      expect(natural).not.toBe(0o600);
      expect(natural).not.toBe(0o700);
      expect(natural & 0o077).not.toBe(0); // legível por outros usuários
    } finally {
      process.umask(prev);
    }
  });

  test("SleepCycle: diretórios 0o700 e projeções 0o600 (arquivos reais em disco)", () => {
    const base = mkTmp("dreams07_posix_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "Fato coletivo para projecao POSIX", "learning");
    db.insertMemory("agent:alice", "Fato da persona alice para projecao POSIX", "pitfall");

    const cycle = new SleepCycle(db, { baseDir: base, captureDialogue: false });
    cycle.updateProjections();

    expect(modeOf(base)).toBe(0o700);
    expect(modeOf(path.join(base, "daily"))).toBe(0o700);
    expect(modeOf(path.join(base, "collective"))).toBe(0o700);
    expect(modeOf(path.join(base, "personas"))).toBe(0o700);

    const collectiveFile = path.join(base, "collective", "COLLECTIVE_MEMORY.md");
    const personaFile = path.join(base, "personas", "alice.md");
    expect(fs.existsSync(collectiveFile)).toBe(true);
    expect(fs.existsSync(personaFile)).toBe(true);
    expect(modeOf(collectiveFile)).toBe(0o600);
    expect(modeOf(personaFile)).toBe(0o600);
    db.close();
  });

  test("HERANÇA: diretório pré-existente 0o755 é endurecido para 0o700", () => {
    const base = mkTmp("dreams07_inherit_dir_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "Fato herdado de diretorio", "learning");

    // Sabota os modos ANTES do ciclo (simula artefato de versão anterior).
    fs.chmodSync(base, 0o755);
    fs.mkdirSync(path.join(base, "collective"), { recursive: true });
    fs.chmodSync(path.join(base, "collective"), 0o755);
    fs.mkdirSync(path.join(base, "personas"), { recursive: true });
    fs.chmodSync(path.join(base, "personas"), 0o755);
    expect(modeOf(base)).toBe(0o755);
    expect(modeOf(path.join(base, "collective"))).toBe(0o755);

    const cycle = new SleepCycle(db, { baseDir: base, captureDialogue: false });
    cycle.updateProjections();

    expect(modeOf(base)).toBe(0o700);
    expect(modeOf(path.join(base, "collective"))).toBe(0o700);
    expect(modeOf(path.join(base, "personas"))).toBe(0o700);
    db.close();
  });

  test("handoff e checkpoint do Light Sleep: dialogue_pending.txt e checkpoint em 0o600", async () => {
    const base = mkTmp("dreams07_dialogue_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    const sessionDb = buildSessionDb(base, [
      {
        id: "m1",
        session: "ses_a",
        t: Date.now() - 5 * 60 * 1000,
        role: "user",
        texts: ["DIALOGO POSIX do dia"],
      },
    ]);

    const cycle = new SleepCycle(db, { baseDir: base, sessionDbPath: sessionDb });
    await cycle.lightSleep();

    const pending = path.join(base, "dialogue_pending.txt");
    const checkpoint = path.join(base, DIALOGUE_CHECKPOINT_FILENAME);
    expect(fs.existsSync(pending)).toBe(true);
    expect(fs.existsSync(checkpoint)).toBe(true);
    expect(fs.readFileSync(pending, "utf8")).toContain("DIALOGO POSIX do dia");
    expect(modeOf(pending)).toBe(0o600);
    expect(modeOf(checkpoint)).toBe(0o600);
    db.close();
  });

  test("HERANÇA: dialogue_pending.txt legado em 0o644 é endurecido para 0o600", async () => {
    const base = mkTmp("dreams07_inherit_file_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    const pending = path.join(base, "dialogue_pending.txt");
    fs.writeFileSync(pending, "BLOCO LEGADO ANTERIOR");
    fs.chmodSync(pending, 0o644);
    // O handoff legado precisa estar no PASSADO para que o checkpoint não
    // corte a janela de captura (regra de fronteira do Light Sleep).
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(pending, past, past);
    expect(modeOf(pending)).toBe(0o644);

    const sessionDb = buildSessionDb(base, [
      {
        id: "m1",
        session: "ses_a",
        t: Date.now() - 5 * 60 * 1000,
        role: "user",
        texts: ["DIALOGO NOVO APOS LEGADO"],
      },
    ]);

    const cycle = new SleepCycle(db, { baseDir: base, sessionDbPath: sessionDb });
    await cycle.lightSleep();

    // O conteúdo NÃO pode ser perdido no endurecimento...
    const content = fs.readFileSync(pending, "utf8");
    expect(content).toContain("BLOCO LEGADO ANTERIOR");
    expect(content).toContain("DIALOGO NOVO APOS LEGADO");
    // ... e o modo tem de estar endurecido (o `mode` do writeFileSync NÃO
    // altera arquivo já existente — quem fecha a janela é o chmod pós-escrita).
    expect(modeOf(pending)).toBe(0o600);
    db.close();
  });

  test("tool dream_learn: diretório 0o700 e JSONL diário 0o600 (com herança)", () => {
    const base = mkTmp("dreams07_tools_");
    const dailyDir = path.join(base, "daily");
    const db = new DreamsDB(path.join(base, "dreams.db"));

    // 1ª chamada: o diretório e o arquivo NASCEM.
    dream_learn(
      { scope: "collective", fact: "Fato duravel do agente", category: "learning" },
      { dailyDir, db }
    );
    expect(modeOf(dailyDir)).toBe(0o700);
    const files = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    const jsonl = path.join(dailyDir, files[0]);
    expect(modeOf(jsonl)).toBe(0o600);

    // 2ª chamada: arquivo JÁ EXISTENTE sabotado em 0o644 → deve ser endurecido.
    fs.chmodSync(jsonl, 0o644);
    fs.chmodSync(dailyDir, 0o755);
    expect(modeOf(jsonl)).toBe(0o644);

    dream_learn(
      { scope: "collective", fact: "Segundo fato duravel", category: "decision" },
      { dailyDir, db }
    );
    expect(modeOf(dailyDir)).toBe(0o700);
    expect(modeOf(jsonl)).toBe(0o600);
    expect(fs.readFileSync(jsonl, "utf8")).toContain("Segundo fato duravel");
    db.close();
  });

  test("UMASK ADVERSARIAL (0o777): as projeções do SleepCycle continuam 0o600", () => {
    // Com umask 0o777 o modo de CRIAÇÃO vira 0o000 (o umask limpa TODOS os
    // bits) — logo só a camada de `chmod` pós-rename consegue devolver 0o600.
    // Isto prova que o hardening NÃO depende do umask do processo.
    const base = mkTmp("dreams07_umask777_proj_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    db.insertMemory("collective", "Fato sob umask adversarial", "learning");
    const cycle = new SleepCycle(db, { baseDir: base, captureDialogue: false });

    const prev = process.umask(0o777);
    try {
      cycle.updateProjections();
      const collectiveFile = path.join(base, "collective", "COLLECTIVE_MEMORY.md");
      const personaFile = path.join(base, "personas", "alice.md");
      expect(modeOf(collectiveFile)).toBe(0o600);
      expect(fs.readFileSync(collectiveFile, "utf8")).toContain("Fato sob umask adversarial");
      expect(fs.existsSync(personaFile)).toBe(false);
    } finally {
      process.umask(prev);
    }
    db.close();
  });

  test("UMASK ADVERSARIAL (0o777): o JSONL do MCP e da tool continuam 0o600", () => {
    const base = mkTmp("dreams07_umask777_daily_");
    const paths = {
      dir: base,
      dbPath: path.join(base, "dreams.db"),
      dailyDir: path.join(base, "daily"),
    };
    const dailyDir = path.join(base, "daily_tools");
    const db = new DreamsDB(path.join(base, "dreams.db"));

    const prev = process.umask(0o777);
    try {
      const mcpFile = appendDailyLog(
        paths,
        "collective",
        "Fato MCP sob umask adversarial",
        "learning",
        new Date("2026-10-21T12:00:00.000Z")
      );
      expect(modeOf(mcpFile)).toBe(0o600);
      expect(modeOf(paths.dailyDir)).toBe(0o700);

      dream_learn(
        { scope: "collective", fact: "Fato tool sob umask adversarial", category: "learning" },
        { dailyDir, db }
      );
      // `dream_learn` grava sempre com a data de HOJE (`new Date()`), então o
      // nome do arquivo precisa ser calculado dinamicamente para o teste ser
      // determinístico em qualquer dia.
      const today = new Date().toISOString().slice(0, 10);
      const toolFile = path.join(dailyDir, `log_${today}.jsonl`);
      expect(fs.existsSync(toolFile)).toBe(true);
      expect(modeOf(toolFile)).toBe(0o600);
      expect(modeOf(dailyDir)).toBe(0o700);
    } finally {
      process.umask(prev);
    }
    db.close();
  });

  test("UMASK ADVERSARIAL (0o777): o handoff pendente continua 0o600", async () => {
    const base = mkTmp("dreams07_umask777_handoff_");
    const db = new DreamsDB(path.join(base, "dreams.db"));
    const sessionDb = buildSessionDb(base, [
      {
        id: "m1",
        session: "ses_a",
        t: Date.now() - 5 * 60 * 1000,
        role: "user",
        texts: ["DIALOGO SOB UMASK ADVERSARIAL"],
      },
    ]);
    const cycle = new SleepCycle(db, { baseDir: base, sessionDbPath: sessionDb });

    const prev = process.umask(0o777);
    try {
      await cycle.lightSleep();
      const pending = path.join(base, "dialogue_pending.txt");
      const checkpoint = path.join(base, DIALOGUE_CHECKPOINT_FILENAME);
      expect(fs.readFileSync(pending, "utf8")).toContain("DIALOGO SOB UMASK ADVERSARIAL");
      expect(modeOf(pending)).toBe(0o600);
      expect(fs.existsSync(checkpoint)).toBe(true);
      expect(modeOf(checkpoint)).toBe(0o600);
    } finally {
      process.umask(prev);
    }
    db.close();
  });

  test("CONTROLE DE EQUIVALÊNCIA: o modo final é invariante ao modo de criação (o chmod é a camada que decide)", () => {
    // Documenta — de forma executável — por que relaxar APENAS o `mode` de
    // criação é equivalente no estado observável: o `chmod` subsequente
    // determina o modo final. A criação permissiva continua sendo defesa em
    // profundidade contra a janela entre `create` e `chmod` (e o diretório
    // pai 0o700 já bloqueia o trajeto de outros usuários).
    const dir = mkTmp("dreams07_equiv_");
    const f = path.join(dir, "probe.jsonl");
    const prev = process.umask(0o022);
    try {
      const fd = fs.openSync(f, "w", 0o666);
      fs.closeSync(fd);
      expect(modeOf(f)).toBe(0o644); // criação permissiva (umask 0o022)
    } finally {
      process.umask(prev);
    }
    fs.chmodSync(f, 0o600);
    expect(modeOf(f)).toBe(0o600); // o chmod decide o estado final
  });

  test("MCP appendDailyLog: diretório 0o700 e JSONL 0o600", () => {
    const base = mkTmp("dreams07_mcp_");
    const paths = {
      dir: base,
      dbPath: path.join(base, "dreams.db"),
      dailyDir: path.join(base, "daily"),
    };
    const file = appendDailyLog(
      paths,
      "collective",
      "Fato persistido via MCP",
      "learning",
      new Date("2026-10-21T12:00:00.000Z")
    );
    expect(path.basename(file)).toBe("log_2026-10-21.jsonl");
    expect(modeOf(paths.dailyDir)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toContain("Fato persistido via MCP");
  });

  test("HERANÇA (MCP): diretório 0o755 e JSONL 0o644 legados são endurecidos", () => {
    const base = mkTmp("dreams07_mcp_inherit_");
    const dailyDir = path.join(base, "daily");
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.chmodSync(dailyDir, 0o755);

    // Arquivo JSONL JÁ EXISTENTE em modo permissivo (o `mode` do append
    // NÃO se aplica a arquivo existente — só o chmod pós-escrita fecha a janela).
    const legacy = path.join(dailyDir, "log_2026-10-21.jsonl");
    fs.writeFileSync(legacy, '{"legacy":true}\n', { mode: 0o644 });
    fs.chmodSync(legacy, 0o644);
    expect(modeOf(dailyDir)).toBe(0o755);
    expect(modeOf(legacy)).toBe(0o644);

    const paths = { dir: base, dbPath: path.join(base, "dreams.db"), dailyDir };
    const file = appendDailyLog(
      paths,
      "collective",
      "Fato via MCP sobre arquivo herdado",
      "learning",
      new Date("2026-10-21T12:00:00.000Z")
    );
    expect(file).toBe(legacy);
    expect(modeOf(dailyDir)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    // O conteúdo herdado NÃO pode ser perdido no endurecimento.
    expect(fs.readFileSync(file, "utf8")).toContain('"legacy":true');
    expect(fs.readFileSync(file, "utf8")).toContain("Fato via MCP sobre arquivo herdado");
  });
});

// ===========================================================================
// 4 — .gitignore (efetividade real via git)
// ===========================================================================

describe("DREAMS-07 · .gitignore — metadados locais de orquestração", () => {
  test("kanban.json e opencode.json estão declarados no .gitignore", () => {
    const gi = readText(GITIGNORE_PATH);
    expect(gi).toMatch(/^\s*kanban\.json\s*$/m);
    expect(gi).toMatch(/^\s*opencode\.json\s*$/m);
  });

  test("o git REAL reporta ambos como ignorados", () => {
    const r = spawnSync("git", ["check-ignore", "-v", "kanban.json", "opencode.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kanban.json");
    expect(r.stdout).toContain("opencode.json");
  });

  test("git status não lista os metadados locais", () => {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      expect(line).not.toMatch(/kanban\.json$/);
      expect(line).not.toMatch(/opencode\.json$/);
    }
  });
});

// ===========================================================================
// 5 — README coerente (handoff integral + chunks no REM)
// ===========================================================================

describe("DREAMS-07 · README — handoff integral e chunks no REM Sleep", () => {
  const readme = readText(README_PATH);

  test("não promete mais o truncamento invertido", () => {
    expect(readme).not.toMatch(/Truncamento Invertido/i);
    expect(readme).not.toMatch(/início do dia omitido/i);
  });

  test("descreve o handoff integral e o particionamento em chunks", () => {
    expect(readme).toMatch(/Handoff integral/i);
    expect(readme).toMatch(/chunk/i);
    expect(readme).toMatch(/particionad/i);
    expect(readme).toContain("chunkDialogueText");
  });

  test("o diagrama da FASE 1 reflete o handoff integral", () => {
    const diagram = readme.split("\n").filter((l) => l.includes("FASE 1"));
    expect(diagram.length).toBeGreaterThan(0);
    expect(readme).toMatch(/FASE 1[\s\S]{0,600}Handoff integral/);
  });
});
