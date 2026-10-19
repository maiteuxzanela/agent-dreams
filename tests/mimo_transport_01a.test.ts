/**
 * TICKET-DREAMS-01A — Suíte determinística REAL (sem mocks) do hardening de
 * subprocesso do `mimo_synthesizer.ts`.
 *
 * Cobre três garantias:
 *   1. ausência de `--pure` (que desativaria o plugin de auth do Antigravity) e
 *      transporte do prompt por STDIN — o prompt NUNCA entra em `argv` (elimina
 *      E2BIG de `MAX_ARG_STRLEN` e a exposição em `/proc/<pid>/cmdline`);
 *   2. teto em BYTES UTF-8 reais (`MAX_PROMPT_BYTES`) com corte de cauda que
 *      não parte code points multibyte;
 *   3. um diálogo grande e acentuado (multibyte) atravessa um subprocesso REAL
 *      sem disparar E2BIG e sem corromper UTF-8 (0 ocorrências de U+FFFD).
 *
 * O seam de subprocesso é um binário REAL em /tmp (script bash) que grava o
 * próprio argv (delimitado por NUL) e o stdin em disco. Nenhum mock/stub de
 * módulo é usado.
 */
import { test, expect, describe, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import {
  MimoSynthesizer,
  MAX_PROMPT_BYTES,
  utf8ByteLength,
  truncateUtf8Tail,
  DEFAULT_MIMO_MODEL,
} from "../src/core/mimo_synthesizer";

const BASE_DIR = fs.mkdtempSync(path.join("/tmp", "dreams_01a_transport_"));

afterAll(() => {
  fs.rmSync(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Cria um recorder REAL: um script bash executável que grava `argv` (NUL como
 * delimitador para preservar prompts multi-linha) e captura todo o STDIN.
 */
function makeRecorder(name: string): { bin: string; dir: string; argvLog: string; stdinLog: string } {
  const dir = fs.mkdtempSync(path.join(BASE_DIR, name));
  const bin = path.join(dir, "opencode_recorder.sh");
  const argvLog = path.join(dir, "argv.log");
  const stdinLog = path.join(dir, "stdin.log");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\0' "$@" > "${argvLog}"`,
      `cat > "${stdinLog}"`,
      `printf '%s\\n' '[{"scope":"collective","fact":"recorder real capturou stdin e argv do transporte seguro","category":"learning"}]'`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return { bin, dir, argvLog, stdinLog };
}

/** Roda um cenário de síntese desligando o fail-fast offline APENAS no spawn. */
async function runWithRecorder<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DREAMS_OFFLINE;
  delete process.env.DREAMS_OFFLINE;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DREAMS_OFFLINE;
    else process.env.DREAMS_OFFLINE = prev;
  }
}

const readArgv = (argvLog: string): string[] =>
  fs.readFileSync(argvLog, "utf8").split("\0").filter((s) => s.length > 0);

describe("TICKET-DREAMS-01A — helpers de bytes UTF-8 (puros)", () => {
  test("MAX_PROMPT_BYTES é 128000 e mantém folga sob MAX_ARG_STRLEN (131072)", () => {
    expect(MAX_PROMPT_BYTES).toBe(128_000);
    expect(MAX_PROMPT_BYTES).toBeLessThan(131_072);
  });

  test("utf8ByteLength mede BYTES reais, não unidades UTF-16", () => {
    // 'ção' = 3 caracteres (String.length) mas 5 bytes em UTF-8.
    expect("ção".length).toBe(3);
    expect(utf8ByteLength("ção")).toBe(5);
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("")).toBe(0);
    // Acentuado multibyte: N chars não equivalem a N bytes.
    expect(utf8ByteLength("áéíóú")).toBe(10);
  });

  test("truncateUtf8Tail preserva a cauda e nunca parte code points multibyte", () => {
    // 'ação' = a(1)+ç(2)+ã(2)+o(1) = 6 bytes. Cauda de 3 bytes = 'ão'.
    expect(utf8ByteLength("ação")).toBe(6);
    expect(truncateUtf8Tail("ação", 3)).toBe("ão");
    // Não sobra U+FFFD de code point partido.
    expect(truncateUtf8Tail("ação", 3)).not.toContain("\uFFFD");
    // Limite 0 → vazio; limite >= tamanho → texto íntegro.
    expect(truncateUtf8Tail("abc", 0)).toBe("");
    expect(truncateUtf8Tail("abc", 100)).toBe("abc");
  });

  test("truncateUtf8Tail remove o U+FFFD de fronteira em diálogo acentuado grande", () => {
    const big = "ação".repeat(1000); // 6000 bytes
    const cut = truncateUtf8Tail(big, 5); // corta no meio de um code point
    expect(cut).not.toContain("\uFFFD");
    expect(utf8ByteLength(cut)).toBeLessThanOrEqual(5);
  });
});

describe("TICKET-DREAMS-01A — transporte real por STDIN e ausência de --pure", () => {
  test("argv NÃO contém o prompt: 7 itens sem --pure, e o prompt chega por stdin", async () => {
    const rec = makeRecorder("short");
    const dialogue = "user: use sempre a cota gratuita\nassistant: combinado";
    const result = await runWithRecorder(async () => {
      const synth = new MimoSynthesizer({
        binary: rec.bin,
        models: [DEFAULT_MIMO_MODEL],
        timeoutMs: 10_000,
      });
      return synth.synthesize(dialogue);
    });

    // Contrato de saída real.
    expect(result.error).toBeNull();
    expect(result.modelUsed).toBe(DEFAULT_MIMO_MODEL);
    expect(result.source).toBe("gemini");
    expect(result.memories.length).toBe(1);

    // Contrato de entrada: sequência exata de argv, SEM o prompt.
    const argv = readArgv(rec.argvLog);
    expect(argv).toEqual([
      "run",
      "--title",
      "Dreams Synthesis",
      "--dir",
      "/tmp",
      "--model",
      DEFAULT_MIMO_MODEL,
    ]);
    expect(argv.length).toBe(7);
    // `--pure` desativa o plugin de auth do Antigravity: nunca deve ser injetada.
    expect(argv).not.toContain("--pure");
    // NENHUM item de argv contém o prompt.
    expect(argv.some((a) => a.includes("<dialogo>"))).toBe(false);
    expect(argv.some((a) => a.includes("cota gratuita"))).toBe(false);

    // O prompt chegou íntegro por STDIN.
    const stdin = fs.readFileSync(rec.stdinLog, "utf8");
    expect(stdin).toContain("<dialogo>");
    expect(stdin).toContain("</dialogo>");
    expect(stdin).toContain("REGRAS ABSOLUTAS:");
    expect(stdin).toContain("use sempre a cota gratuita");
  });

  test("diálogo acentuado gigante respeita o teto de bytes e não dispara E2BIG", async () => {
    const rec = makeRecorder("large");
    // ~160.000 chars / ~260.000 bytes em UTF-8: excede os DOIS tetos (chars e bytes).
    const unit = "açãoêçã "; // 8 chars, 13 bytes
    const hugeDialogue = unit.repeat(20_000);
    expect(hugeDialogue.length).toBeGreaterThan(120_000);
    expect(utf8ByteLength(hugeDialogue)).toBeGreaterThan(MAX_PROMPT_BYTES);

    const result = await runWithRecorder(async () => {
      const synth = new MimoSynthesizer({
        binary: rec.bin,
        models: [DEFAULT_MIMO_MODEL],
        timeoutMs: 15_000,
      });
      return synth.synthesize(hugeDialogue);
    });

    // Subprocesso real retornou com sucesso (exit 0) → nenhum E2BIG.
    expect(result.error).toBeNull();
    expect(result.memories.length).toBe(1);

    // Teto de bytes respeitado e próximo do budget (não subdimensionado por .length).
    expect(result.promptBytes).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(result.promptBytes).toBeGreaterThan(100_000);

    // argv segue minúsculo e sem prompt → impossível estourar MAX_ARG_STRLEN.
    const argv = readArgv(rec.argvLog);
    expect(argv.length).toBe(7);
    expect(argv.some((a) => a.includes("<dialogo>"))).toBe(false);
    const argvBytes = argv.reduce((acc, a) => acc + utf8ByteLength(a), 0);
    expect(argvBytes).toBeLessThan(1024);

    // O payload REAL enviado por stdin (= prompt) carrega o envelope e é UTF-8 limpo.
    const stdin = fs.readFileSync(rec.stdinLog, "utf8");
    expect(stdin).toContain("<dialogo>");
    expect(stdin).toContain("</dialogo>");
    // Medição INDEPENDENTE em bytes (Buffer nativo) — imune a um `utf8ByteLength`
    // corrompido: prova real de ausência de E2BIG sob MAX_ARG_STRLEN.
    const stdinBytes = Buffer.byteLength(stdin, "utf8");
    expect(stdinBytes).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(stdinBytes).toBeLessThan(131_072);
    expect(utf8ByteLength(stdin)).toBe(stdinBytes);
    expect(stdin).not.toContain("\uFFFD");
    // O corte preservou a CAUDA do diálogo (caractere acentuado íntegro).
    expect(stdin).toContain("ç");
  });

  test("diálogo pequeno preserva acentos e NÃO injeta o marcador de omissão", async () => {
    const rec = makeRecorder("small");
    const dialogue = "user: a atenção à acentuação é essencial\nassistant: ação concluída";
    const result = await runWithRecorder(async () => {
      const synth = new MimoSynthesizer({
        binary: rec.bin,
        models: [DEFAULT_MIMO_MODEL],
        timeoutMs: 10_000,
      });
      return synth.synthesize(dialogue);
    });

    const stdin = fs.readFileSync(rec.stdinLog, "utf8");
    expect(stdin).toContain("atenção à acentuação é essencial");
    expect(stdin).toContain("ação concluída");
    expect(stdin).not.toContain("início do dia omitido");
    expect(result.promptBytes).toBe(utf8ByteLength(stdin));
    expect(result.promptBytes).toBeLessThan(MAX_PROMPT_BYTES);
  });

  test("--pure não é injetada e o binário/argv usam o cwd informado", async () => {
    const rec = makeRecorder("cwd");
    await runWithRecorder(async () => {
      const synth = new MimoSynthesizer({
        binary: rec.bin,
        models: [DEFAULT_MIMO_MODEL],
        timeoutMs: 10_000,
        cwd: rec.dir,
      });
      return synth.synthesize("user: validando cwd");
    });
    const argv = readArgv(rec.argvLog);
    expect(argv).not.toContain("--pure");
    expect(argv[0]).toBe("run");
  });
});
